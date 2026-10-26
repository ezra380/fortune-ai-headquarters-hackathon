-- One phone may stand for more than one person (for the demo, the owner plays both the owner and the
-- finance owner from one phone; Ezra, 2026-10-26: "use mine for now ... for all and we can change later").
--  - An inbound text resolves to the person whose assistant owns the number that was texted, then to
--    the owner, then to the first by id.
--  - An approval code acts as the person it was issued to, among the people who share the phone.

alter table public.people drop constraint people_phone_key;
create index people_phone on public.people (phone);

create or replace function public.enqueue_inbound_text(
  p_message_sid text, p_from text, p_to text, p_body text, p_now timestamptz default now()
) returns table (task_id uuid, outcome text, duplicate boolean)
language plpgsql set search_path = '' as $$
declare
  v_person public.people%rowtype;
  v_task uuid;
begin
  select p.* into v_person
    from public.people p
    left join public.assistants a on a.id = p.assistant_id
   where p.phone = p_from
   order by (a.sms_from is not distinct from p_to) desc, (p.role = 'owner') desc, p.id
   limit 1;
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

drop function public.use_approval_code(text, text, text, text, uuid, jsonb, timestamptz);
create function public.use_approval_code(
  p_phone text, p_code text, p_verdict text, p_action text, p_task_id uuid,
  p_detail jsonb default '{}'::jsonb, p_now timestamptz default now()
) returns table (approval_id uuid, message_id uuid, action text, outcome text, replay boolean, approver_person_id text)
language plpgsql set search_path = '' as $$
declare
  v_people text[];
  r public.approvals%rowtype;
begin
  if p_verdict not in ('signed', 'declined') then raise exception 'use_approval_code: bad verdict'; end if;
  if p_action not in ('forward_plan', 'decide_plan') then raise exception 'use_approval_code: bad action'; end if;
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

revoke all on function public.enqueue_inbound_text(text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.use_approval_code(text, text, text, text, uuid, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.enqueue_inbound_text(text, text, text, text, timestamptz) to service_role;
grant execute on function public.use_approval_code(text, text, text, text, uuid, jsonb, timestamptz) to service_role;
