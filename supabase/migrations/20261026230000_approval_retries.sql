-- Approval codes survive retries (adversarial review, 2026-10-26).
--  1. A code works only for its own action: SEND with a CONFIRM code (or the reverse) is refused
--     without spending the code.
--  2. A task that already spent a code can present it again and resume (a retry after a later step
--     failed), instead of being told the code "didn't work" while the approval is lost.
--  3. A code is issued together with the text that carries it, in one transaction keyed by the
--     text's dedupe key. Re-running the step changes nothing: the code already sent stays valid,
--     and no code is ever issued that no text carries.

alter table public.approvals add column used_by_task uuid references public.tasks (id);
create index approvals_used_by_task on public.approvals (used_by_task) where used_by_task is not null;

drop function public.use_approval_code(text, text, text, jsonb, timestamptz);
drop function public.create_approval(uuid, text, text, text, integer, timestamptz);

create function public.issue_approval(
  p_message_id uuid, p_person_id text, p_action text, p_code text,
  p_from_assistant public.assistant_id, p_sms_body text, p_sms_dedupe_key text,
  p_ttl_minutes integer default 15, p_now timestamptz default now()
) returns table (approval_id uuid, created boolean)
language plpgsql set search_path = '' as $$
declare v_id uuid := gen_random_uuid();
begin
  if p_code !~ '^[0-9]{6}$' then raise exception 'issue_approval: code must be 6 digits'; end if;
  if p_action not in ('forward_plan', 'decide_plan') then raise exception 'issue_approval: bad action'; end if;
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

-- Use a code: only the approver's own phone, only for its own action, only once (a retry of the same
-- task resumes), before expiry; five wrong codes lock the person's pending approvals.
create function public.use_approval_code(
  p_phone text, p_code text, p_verdict text, p_action text, p_task_id uuid,
  p_detail jsonb default '{}'::jsonb, p_now timestamptz default now()
) returns table (approval_id uuid, message_id uuid, action text, outcome text, replay boolean)
language plpgsql set search_path = '' as $$
declare
  v_person text;
  r public.approvals%rowtype;
  v_hash text;
begin
  if p_verdict not in ('signed', 'declined') then raise exception 'use_approval_code: bad verdict'; end if;
  if p_action not in ('forward_plan', 'decide_plan') then raise exception 'use_approval_code: bad action'; end if;
  select p.id into v_person from public.people p where p.phone = p_phone;
  if v_person is null or p_code !~ '^[0-9]{6}$' then
    return query select null::uuid, null::uuid, null::text, 'refused'::text, false; return;
  end if;

  -- A retry of the task that already spent this code resumes with the original outcome.
  if p_task_id is not null then
    for r in
      select * from public.approvals a
       where a.approver_person_id = v_person and a.used_by_task = p_task_id and a.action = p_action
    loop
      if r.code_hash = encode(extensions.digest(r.id::text || ':' || p_code, 'sha256'), 'hex') then
        return query select r.id, r.message_id, r.action, r.status::text, true; return;
      end if;
    end loop;
  end if;

  update public.approvals a set status = 'expired'
   where a.approver_person_id = v_person and a.status = 'pending' and a.expires_at <= p_now;

  for r in
    select * from public.approvals a
     where a.approver_person_id = v_person and a.status = 'pending'
     order by a.created_at desc for update
  loop
    v_hash := encode(extensions.digest(r.id::text || ':' || p_code, 'sha256'), 'hex');
    if r.code_hash = v_hash then
      if r.action <> p_action then
        -- The right code with the wrong command word: refused, and the code stays usable.
        return query select null::uuid, null::uuid, r.action, 'wrong_action'::text, false; return;
      end if;
      update public.approvals a
         set status = p_verdict::public.approval_status, decided_at = p_now, decision = p_detail, used_by_task = p_task_id
       where a.id = r.id;
      return query select r.id, r.message_id, r.action, p_verdict, false; return;
    end if;
  end loop;

  update public.approvals a
     set failed_attempts = a.failed_attempts + 1,
         status = case when a.failed_attempts + 1 >= 5 then 'locked'::public.approval_status else a.status end
   where a.approver_person_id = v_person and a.status = 'pending';
  return query select null::uuid, null::uuid, null::text, 'refused'::text, false;
end $$;

revoke all on function public.issue_approval(uuid, text, text, text, public.assistant_id, text, text, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.use_approval_code(text, text, text, text, uuid, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.issue_approval(uuid, text, text, text, public.assistant_id, text, text, integer, timestamptz) to service_role;
grant execute on function public.use_approval_code(text, text, text, text, uuid, jsonb, timestamptz) to service_role;
