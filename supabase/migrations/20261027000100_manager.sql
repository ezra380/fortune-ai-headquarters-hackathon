-- The HQ Manager: end-of-work reports, the manager's reviews, the recommendations the owner may adopt.
-- Synthetic data only. RLS is on for every new table with NO policies (anon and authenticated see
-- nothing; the worker uses the service role). Anything that must happen once is enforced here.

-- The manager has no phone number and no person: it reaches the owner through Owner HQ's number.
insert into public.assistants (id, display_name, sms_from) values ('manager', 'HQ Manager', null)
on conflict (id) do nothing;

-- Provider-reported tokens per step (null when the step called no model).
alter table public.receipts
  add column input_tokens integer check (input_tokens >= 0),
  add column output_tokens integer check (output_tokens >= 0);

-- One report per task: a retried task overwrites its report (the latest attempt wins).
create table public.work_reports (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null unique references public.tasks (id),
  run_id uuid not null,
  assistant_id public.assistant_id not null references public.assistants (id),
  task_kind text not null check (length(task_kind) between 1 and 40),
  outcome text not null check (outcome in ('done', 'failed', 'retrying')),
  summary text not null check (length(summary) between 1 and 300),
  steps jsonb not null check (jsonb_typeof(steps) = 'array'),
  usage jsonb not null check (jsonb_typeof(usage) = 'object'),
  suggestions jsonb not null check (jsonb_typeof(suggestions) = 'array'),
  -- Sums of the usage above, kept as columns so the manager can add them up in SQL.
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  model_calls integer not null default 0 check (model_calls >= 0),
  started_at timestamptz not null,
  ended_at timestamptz not null check (ended_at >= started_at),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index work_reports_ended_at on public.work_reports (ended_at desc);

-- One review per key (the key names the request that asked for it).
create table public.manager_reviews (
  id uuid primary key default gen_random_uuid(),
  review_key text not null unique check (length(review_key) between 3 and 80),
  task_id uuid references public.tasks (id),
  covers_from timestamptz not null,
  covers_to timestamptz not null check (covers_to >= covers_from),
  report_count integer not null check (report_count >= 0),
  review jsonb not null check (jsonb_typeof(review) = 'object'),
  digest jsonb not null check (jsonb_typeof(digest) = 'object'),
  model text check (length(model) <= 120),
  message_id uuid references public.assistant_messages (id),
  created_at timestamptz not null default now()
);

-- Up to three recommendations per review. A recommendation changes nothing until a person adopts it.
create table public.recommendations (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.manager_reviews (id),
  rank integer not null check (rank between 1 and 3),
  assistant_id public.assistant_id not null references public.assistants (id),
  change text not null check (length(change) between 1 and 300),
  why text not null check (length(why) between 1 and 300),
  status text not null default 'proposed' check (status in ('proposed', 'adopted', 'expired')),
  decided_by text references public.people (id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (review_id, rank)
);

alter table public.work_reports enable row level security;
alter table public.manager_reviews enable row level security;
alter table public.recommendations enable row level security;

-- A code can now also adopt a recommendation.
alter table public.approvals drop constraint approvals_action_check;
alter table public.approvals add constraint approvals_action_check
  check (action in ('forward_plan', 'decide_plan', 'adopt_change'));

-- issue_approval and use_approval_code: the live bodies, with only the allowed actions widened.
create or replace function public.issue_approval(
  p_message_id uuid, p_person_id text, p_action text, p_code text,
  p_from_assistant public.assistant_id, p_sms_body text, p_sms_dedupe_key text,
  p_ttl_minutes integer default 15, p_now timestamptz default now()
) returns table (approval_id uuid, created boolean)
language plpgsql set search_path = '' as $$
declare v_id uuid := gen_random_uuid();
begin
  if p_code !~ '^[0-9]{6}$' then raise exception 'issue_approval: code must be 6 digits'; end if;
  if p_action not in ('forward_plan', 'decide_plan', 'adopt_change') then raise exception 'issue_approval: bad action'; end if;
  if position(p_code in p_sms_body) = 0 then raise exception 'issue_approval: the text must carry the code'; end if;
  -- Serialize issuers of the same text so two retries cannot both pass the check below.
  perform pg_advisory_xact_lock(hashtext(p_sms_dedupe_key));
  if exists (select 1 from public.outbox o where o.dedupe_key = p_sms_dedupe_key) then
    return query select null::uuid, false; return;
  end if;
  update public.approvals a set status = 'expired'
   where a.message_id = p_message_id and a.approver_person_id = p_person_id and a.action = p_action and a.status = 'pending';
  insert into public.approvals (id, message_id, approver_person_id, action, code_hash, expires_at, created_at)
  values (v_id, p_message_id, p_person_id, p_action,
          encode(extensions.digest(v_id::text || ':' || p_code, 'sha256'), 'hex'),
          p_now + make_interval(mins => p_ttl_minutes), p_now);
  insert into public.outbox (channel, to_person_id, from_assistant, body, dedupe_key, created_at)
  values ('sms', p_person_id, p_from_assistant, p_sms_body, p_sms_dedupe_key, p_now);
  return query select v_id, true;
end $$;

create or replace function public.use_approval_code(
  p_phone text, p_code text, p_verdict text, p_action text, p_task_id uuid,
  p_detail jsonb default '{}'::jsonb, p_now timestamptz default now()
) returns table (approval_id uuid, message_id uuid, action text, outcome text, replay boolean, approver_person_id text)
language plpgsql set search_path = '' as $$
declare
  v_people text[];
  r public.approvals%rowtype;
begin
  if p_verdict not in ('signed', 'declined') then raise exception 'use_approval_code: bad verdict'; end if;
  if p_action not in ('forward_plan', 'decide_plan', 'adopt_change') then raise exception 'use_approval_code: bad action'; end if;
  v_people := array(select p.id from public.people p where p.phone = p_phone);
  if cardinality(v_people) = 0 or p_code !~ '^[0-9]{6}$' then
    return query select null::uuid, null::uuid, null::text, 'refused'::text, false, null::text; return;
  end if;

  -- A retry of the task that already spent this code resumes with the original outcome.
  if p_task_id is not null then
    for r in
      select * from public.approvals a
       where a.approver_person_id = any(v_people) and a.used_by_task = p_task_id and a.action = p_action
    loop
      if r.code_hash = encode(extensions.digest(r.id::text || ':' || p_code, 'sha256'), 'hex') then
        return query select r.id, r.message_id, r.action, r.status::text, true, r.approver_person_id; return;
      end if;
    end loop;
  end if;

  update public.approvals a set status = 'expired'
   where a.approver_person_id = any(v_people) and a.status = 'pending' and a.expires_at <= p_now;

  for r in
    select * from public.approvals a
     where a.approver_person_id = any(v_people) and a.status = 'pending'
     order by a.created_at desc for update
  loop
    if r.code_hash = encode(extensions.digest(r.id::text || ':' || p_code, 'sha256'), 'hex') then
      if r.action <> p_action then
        -- The right code with the wrong command word: refused, and the code stays usable.
        return query select null::uuid, null::uuid, r.action, 'wrong_action'::text, false, null::text; return;
      end if;
      update public.approvals a
         set status = p_verdict::public.approval_status, decided_at = p_now, decision = p_detail, used_by_task = p_task_id
       where a.id = r.id;
      return query select r.id, r.message_id, r.action, p_verdict, false, r.approver_person_id; return;
    end if;
  end loop;

  update public.approvals a
     set failed_attempts = a.failed_attempts + 1,
         status = case when a.failed_attempts + 1 >= 5 then 'locked'::public.approval_status else a.status end
   where a.approver_person_id = any(v_people) and a.status = 'pending';
  return query select null::uuid, null::uuid, null::text, 'refused'::text, false, null::text;
end $$;

-- Adopt recommendations: one UPDATE takes the listed ranks that are still 'proposed'; the listed ranks
-- that were already adopted come back with newly_adopted = false, so a retried task gets the same rows
-- again. An 'expired' recommendation is never adopted. The read after the update takes a new snapshot,
-- so a second caller that waited on the row lock still sees what the first one adopted.
create function public.adopt_recommendations(
  p_review_id uuid, p_ranks integer[], p_person_id text, p_now timestamptz default now()
) returns table (recommendation_id uuid, rank integer, assistant_id public.assistant_id, change text, newly_adopted boolean)
language plpgsql set search_path = '' as $$
declare v_new uuid[];
begin
  with u as (
    update public.recommendations r
       set status = 'adopted', decided_by = p_person_id, decided_at = p_now
     where r.review_id = p_review_id and r.rank = any(p_ranks) and r.status = 'proposed'
    returning r.id
  )
  select coalesce(array_agg(u.id), '{}'::uuid[]) into v_new from u;

  return query
  select r.id, r.rank, r.assistant_id, r.change, (r.id = any(v_new))
    from public.recommendations r
   where r.review_id = p_review_id and r.rank = any(p_ranks) and r.status = 'adopted'
   order by r.rank;
end $$;

revoke all on function public.issue_approval(uuid, text, text, text, public.assistant_id, text, text, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.use_approval_code(text, text, text, text, uuid, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.adopt_recommendations(uuid, integer[], text, timestamptz) from public, anon, authenticated;
grant execute on function public.issue_approval(uuid, text, text, text, public.assistant_id, text, text, integer, timestamptz) to service_role;
grant execute on function public.use_approval_code(text, text, text, text, uuid, jsonb, timestamptz) to service_role;
grant execute on function public.adopt_recommendations(uuid, integer[], text, timestamptz) to service_role;
