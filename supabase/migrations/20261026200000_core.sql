-- Fortune AI HQ core schema: queue, mailbox, approvals, outbox, receipts, spending cap.
-- Synthetic data only. RLS is on for every table with NO policies, so the anon and authenticated
-- roles see nothing; the inbound Edge Function and the worker use the service role server-side.
-- Everything that must happen once is enforced here (unique keys, row locks), never check-then-insert.

create extension if not exists pgcrypto with schema extensions;

create type public.assistant_id as enum ('owner', 'finance', 'salon', 'online');
create type public.task_status as enum ('queued', 'running', 'waiting', 'done', 'failed', 'cancelled');
create type public.message_kind as enum ('request', 'proposal', 'decision', 'report');
create type public.message_status as enum ('open', 'answered', 'closed');
create type public.approval_status as enum ('pending', 'signed', 'declined', 'expired', 'locked');
create type public.outbox_channel as enum ('sms', 'print');
create type public.outbox_status as enum ('pending', 'sending', 'sent', 'failed', 'skipped');

create table public.assistants (
  id public.assistant_id primary key,
  display_name text not null check (length(display_name) between 1 and 60),
  sms_from text unique check (sms_from ~ '^\+1[0-9]{10}$')
);

create table public.people (
  id text primary key check (id ~ '^demo-p-[a-z0-9-]+$'),
  name text not null check (length(name) between 1 and 80),
  role text not null check (role in ('owner', 'head_stylist', 'finance_owner', 'online_staff')),
  phone text not null unique check (phone ~ '^\+1[0-9]{10}$'),
  assistant_id public.assistant_id not null unique references public.assistants (id)
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  assistant_id public.assistant_id not null references public.assistants (id),
  kind text not null check (kind in ('inbound_text', 'mailbox', 'scheduled')),
  status public.task_status not null default 'queued',
  idempotency_key text not null unique check (length(idempotency_key) between 3 and 200),
  payload jsonb not null,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  lease_owner text,
  lease_until timestamptz,
  last_error text check (length(last_error) <= 500),
  run_after timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tasks_claimable on public.tasks (created_at) where status in ('queued', 'running');

create table public.inbound_texts (
  message_sid text primary key check (message_sid ~ '^(SM|MM)[0-9a-f]{32}$'),
  from_phone text not null check (from_phone ~ '^\+1[0-9]{10}$'),
  to_phone text not null check (to_phone ~ '^\+1[0-9]{10}$'),
  -- A refused (unknown) sender's words are not kept.
  body text check (length(body) <= 1600),
  outcome text not null check (outcome in ('queued', 'refused_unknown_sender')),
  task_id uuid references public.tasks (id),
  received_at timestamptz not null default now()
);

create table public.assistant_messages (
  id uuid primary key default gen_random_uuid(),
  from_assistant public.assistant_id not null references public.assistants (id),
  to_assistant public.assistant_id not null references public.assistants (id),
  kind public.message_kind not null,
  body jsonb not null,
  status public.message_status not null default 'open',
  reply_to uuid references public.assistant_messages (id),
  dedupe_key text not null unique,
  created_at timestamptz not null default now()
);

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.assistant_messages (id),
  approver_person_id text not null references public.people (id),
  action text not null check (action in ('forward_plan', 'decide_plan')),
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  status public.approval_status not null default 'pending',
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 5),
  expires_at timestamptz not null,
  decided_at timestamptz,
  decision jsonb,
  created_at timestamptz not null default now()
);
create unique index approvals_one_pending
  on public.approvals (message_id, approver_person_id, action) where status = 'pending';

create table public.outbox (
  id uuid primary key default gen_random_uuid(),
  channel public.outbox_channel not null,
  to_person_id text not null references public.people (id),
  from_assistant public.assistant_id not null references public.assistants (id),
  body text not null check (length(body) between 1 and 1600),
  attachment_ref text check (length(attachment_ref) <= 300),
  status public.outbox_status not null default 'pending',
  attempts integer not null default 0 check (attempts between 0 and 5),
  provider_ref text check (length(provider_ref) <= 120),
  last_error text check (length(last_error) <= 500),
  dedupe_key text not null unique,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create table public.receipts (
  id bigint generated always as identity primary key,
  run_id uuid not null,
  task_id uuid references public.tasks (id),
  step text not null check (length(step) between 1 and 60),
  assistant_id public.assistant_id references public.assistants (id),
  live boolean not null,
  model text check (length(model) <= 120),
  data_source text check (length(data_source) <= 200),
  started_at timestamptz not null,
  ended_at timestamptz not null check (ended_at >= started_at),
  cost_usd numeric(12, 6) check (cost_usd >= 0),
  outcome text not null check (outcome in ('ok', 'refused', 'failed')),
  detail text check (length(detail) <= 500)
);

create table public.model_spend (
  day date primary key,
  usd numeric(12, 6) not null default 0 check (usd >= 0)
);

alter table public.assistants enable row level security;
alter table public.people enable row level security;
alter table public.tasks enable row level security;
alter table public.inbound_texts enable row level security;
alter table public.assistant_messages enable row level security;
alter table public.approvals enable row level security;
alter table public.outbox enable row level security;
alter table public.receipts enable row level security;
alter table public.model_spend enable row level security;

-- ---- Functions (service role only) ---------------------------------------------------------

-- The webhook's single write: remember the text once, and queue one task for a known sender.
create function public.enqueue_inbound_text(
  p_message_sid text, p_from text, p_to text, p_body text, p_now timestamptz default now()
) returns table (task_id uuid, outcome text, duplicate boolean)
language plpgsql set search_path = '' as $$
declare
  v_person public.people%rowtype;
  v_task uuid;
begin
  select * into v_person from public.people where phone = p_from;
  if not found then
    insert into public.inbound_texts (message_sid, from_phone, to_phone, body, outcome, received_at)
    values (p_message_sid, p_from, p_to, null, 'refused_unknown_sender', p_now)
    on conflict (message_sid) do nothing;
    return query select null::uuid, 'refused_unknown_sender'::text, not found;
    return;
  end if;

  insert into public.inbound_texts (message_sid, from_phone, to_phone, body, outcome, received_at)
  values (p_message_sid, p_from, p_to, p_body, 'queued', p_now)
  on conflict (message_sid) do nothing;
  if not found then
    return query select t.task_id, t.outcome, true from public.inbound_texts t where t.message_sid = p_message_sid;
    return;
  end if;

  insert into public.tasks (assistant_id, kind, idempotency_key, payload, run_after, created_at, updated_at)
  values (v_person.assistant_id, 'inbound_text', 'sms:' || p_message_sid,
          jsonb_build_object('messageSid', p_message_sid, 'personId', v_person.id, 'from', p_from,
                             'to', p_to, 'body', p_body, 'receivedAt', p_now),
          p_now, p_now, p_now)
  returning id into v_task;
  update public.inbound_texts set task_id = v_task where message_sid = p_message_sid;
  return query select v_task, 'queued'::text, false;
end $$;

-- Claim the oldest runnable task with a lease. Expired leases are retried until max_attempts.
create function public.claim_task(p_worker text, p_lease_seconds integer default 300, p_now timestamptz default now())
returns setof public.tasks
language plpgsql set search_path = '' as $$
begin
  update public.tasks set status = 'failed', last_error = 'lease expired after the last attempt', updated_at = p_now
  where status = 'running' and lease_until < p_now and attempts >= max_attempts;

  return query
  update public.tasks t
     set status = 'running', lease_owner = p_worker,
         lease_until = p_now + make_interval(secs => p_lease_seconds),
         attempts = t.attempts + 1, updated_at = p_now
   where t.id = (
     select c.id from public.tasks c
      where (c.status = 'queued' and c.run_after <= p_now)
         or (c.status = 'running' and c.lease_until < p_now and c.attempts < c.max_attempts)
      order by c.created_at
      for update skip locked
      limit 1)
  returning t.*;
end $$;

-- Finish a task the worker still holds. A lost lease changes nothing.
create function public.finish_task(
  p_task_id uuid, p_worker text, p_status public.task_status, p_error text default null, p_now timestamptz default now()
) returns boolean
language plpgsql set search_path = '' as $$
begin
  if p_status not in ('done', 'failed', 'waiting', 'queued') then
    raise exception 'finish_task: unsupported status %', p_status;
  end if;
  update public.tasks
     set status = p_status, last_error = left(p_error, 500), lease_owner = null, lease_until = null,
         run_after = case when p_status = 'queued' then p_now + interval '30 seconds' else run_after end,
         updated_at = p_now
   where id = p_task_id and lease_owner = p_worker and status = 'running';
  return found;
end $$;

create function public.cancel_task(p_task_id uuid, p_now timestamptz default now()) returns boolean
language plpgsql set search_path = '' as $$
begin
  update public.tasks set status = 'cancelled', lease_owner = null, lease_until = null, updated_at = p_now
   where id = p_task_id and status in ('queued', 'running', 'waiting');
  return found;
end $$;

-- One pending approval per proposal, person and action. The plain code never touches a table.
create function public.create_approval(
  p_message_id uuid, p_person_id text, p_action text, p_code text, p_ttl_minutes integer default 15,
  p_now timestamptz default now()
) returns uuid
language plpgsql set search_path = '' as $$
declare v_id uuid := gen_random_uuid();
begin
  if p_code !~ '^[0-9]{6}$' then raise exception 'create_approval: code must be 6 digits'; end if;
  update public.approvals set status = 'expired'
   where message_id = p_message_id and approver_person_id = p_person_id and action = p_action and status = 'pending';
  insert into public.approvals (id, message_id, approver_person_id, action, code_hash, expires_at, created_at)
  values (v_id, p_message_id, p_person_id, p_action,
          encode(extensions.digest(v_id::text || ':' || p_code, 'sha256'), 'hex'),
          p_now + make_interval(mins => p_ttl_minutes), p_now);
  return v_id;
end $$;

-- Use a code: only the approver's own phone, only once, before expiry, five wrong tries lock it.
create function public.use_approval_code(
  p_phone text, p_code text, p_verdict text, p_detail jsonb default '{}'::jsonb, p_now timestamptz default now()
) returns table (approval_id uuid, message_id uuid, action text, outcome text)
language plpgsql set search_path = '' as $$
declare
  v_person text;
  r public.approvals%rowtype;
begin
  if p_verdict not in ('signed', 'declined') then raise exception 'use_approval_code: bad verdict'; end if;
  select id into v_person from public.people where phone = p_phone;
  if v_person is null or p_code !~ '^[0-9]{6}$' then
    return query select null::uuid, null::uuid, null::text, 'refused'::text; return;
  end if;

  update public.approvals set status = 'expired'
   where approver_person_id = v_person and status = 'pending' and expires_at <= p_now;

  for r in
    select * from public.approvals
     where approver_person_id = v_person and status = 'pending'
     order by created_at desc for update
  loop
    if r.code_hash = encode(extensions.digest(r.id::text || ':' || p_code, 'sha256'), 'hex') then
      update public.approvals
         set status = p_verdict::public.approval_status, decided_at = p_now, decision = p_detail
       where id = r.id;
      return query select r.id, r.message_id, r.action, p_verdict; return;
    end if;
  end loop;

  update public.approvals
     set failed_attempts = failed_attempts + 1,
         status = case when failed_attempts + 1 >= 5 then 'locked'::public.approval_status else status end
   where approver_person_id = v_person and status = 'pending';
  return query select null::uuid, null::uuid, null::text, 'refused'::text;
end $$;

-- Reserve model spend before a call; refuse if it would pass the day's cap.
create function public.reserve_model_spend(p_day date, p_usd numeric, p_cap numeric) returns boolean
language plpgsql set search_path = '' as $$
declare v_total numeric;
begin
  if p_usd < 0 then raise exception 'reserve_model_spend: negative amount'; end if;
  insert into public.model_spend (day, usd) values (p_day, 0) on conflict (day) do nothing;
  update public.model_spend set usd = usd + p_usd where day = p_day and usd + p_usd <= p_cap
  returning usd into v_total;
  return v_total is not null;
end $$;

revoke all on function public.enqueue_inbound_text(text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.claim_task(text, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.finish_task(uuid, text, public.task_status, text, timestamptz) from public, anon, authenticated;
revoke all on function public.cancel_task(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.create_approval(uuid, text, text, text, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.use_approval_code(text, text, text, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.reserve_model_spend(date, numeric, numeric) from public, anon, authenticated;
grant execute on function public.enqueue_inbound_text(text, text, text, text, timestamptz) to service_role;
grant execute on function public.claim_task(text, integer, timestamptz) to service_role;
grant execute on function public.finish_task(uuid, text, public.task_status, text, timestamptz) to service_role;
grant execute on function public.cancel_task(uuid, timestamptz) to service_role;
grant execute on function public.create_approval(uuid, text, text, text, integer, timestamptz) to service_role;
grant execute on function public.use_approval_code(text, text, text, jsonb, timestamptz) to service_role;
grant execute on function public.reserve_model_spend(date, numeric, numeric) to service_role;
