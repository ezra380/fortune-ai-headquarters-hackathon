-- Division briefs: each division's assistant writes its head one daily brief (what the numbers show, up to
-- three actions the head may approve by code, one line for the CEO). Synthetic data only. RLS is on with NO
-- policies (anon and authenticated see nothing; the worker uses the service role).
-- Anything that must happen once is enforced here: one brief per division per day.

create table public.division_briefs (
  id uuid primary key default gen_random_uuid(),
  division text not null check (division in ('salon', 'finance', 'online')),
  -- brief:<division>:<YYYY-MM-DD>. The key is the task's key too, so a retried task finds its own brief.
  brief_key text not null unique,
  brief_date date not null,
  -- The data period the numbers came from (the finance period setting).
  period text not null check (length(period) between 1 and 40),
  -- Set by the program from the attention rules, never by a model.
  status text not null check (status in ('normal', 'watch', 'act')),
  -- 'rule' = the writer's words did not pass their number check, so a program wrote the brief from the rules.
  written_by text not null check (written_by in ('model', 'rule')),
  brief jsonb not null check (jsonb_typeof(brief) = 'object'),
  ceo_line text not null check (length(ceo_line) between 1 and 140),
  -- Where the numbers came from: <view>#<first 12 characters of the query hash>.
  data_source text check (length(data_source) <= 200),
  task_id uuid references public.tasks (id),
  created_at timestamptz not null default now(),
  check (brief_key = 'brief:' || division || ':' || to_char(brief_date, 'YYYY-MM-DD'))
);
create index division_briefs_newest on public.division_briefs (brief_date desc, division);
alter table public.division_briefs enable row level security;

-- A code can now also approve one action of a brief.
alter table public.approvals drop constraint approvals_action_check;
alter table public.approvals add constraint approvals_action_check
  check (action in ('forward_plan', 'decide_plan', 'adopt_change', 'approve_action'));

-- issue_approval and use_approval_code: the live bodies (20261027000100_manager.sql), with only the allowed actions widened.
create or replace function public.issue_approval(
  p_message_id uuid, p_person_id text, p_action text, p_code text,
  p_from_assistant public.assistant_id, p_sms_body text, p_sms_dedupe_key text,
  p_ttl_minutes integer default 15, p_now timestamptz default now()
) returns table (approval_id uuid, created boolean)
language plpgsql set search_path = '' as $$
declare v_id uuid := gen_random_uuid();
begin
  if p_code !~ '^[0-9]{6}$' then raise exception 'issue_approval: code must be 6 digits'; end if;
  if p_action not in ('forward_plan', 'decide_plan', 'adopt_change', 'approve_action') then raise exception 'issue_approval: bad action'; end if;
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
  if p_action not in ('forward_plan', 'decide_plan', 'adopt_change', 'approve_action') then raise exception 'use_approval_code: bad action'; end if;
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
