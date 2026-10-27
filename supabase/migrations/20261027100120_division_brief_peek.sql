-- Look at a pending code WITHOUT spending it.
--
-- The worker checks a brief's APPROVE command against the brief (does it have every action named?) before it spends the
-- code, so a typo in an action number costs nothing: the code stays usable. This is the same match as use_approval_code
-- (the person's phone, a pending code that has not expired, and the hash of this approval's id with the code), but it
-- changes nothing, and it never counts a failed attempt: a wrong code is still counted when the worker goes on to spend it.
-- Additive: no existing function or table changes.

create function public.peek_approval_code(
  p_phone text, p_code text, p_action text, p_now timestamptz default now()
) returns table (message_id uuid, approver_person_id text)
language sql stable set search_path = '' as $$
  select a.message_id, a.approver_person_id
    from public.approvals a
   where p_code ~ '^[0-9]{6}$'
     and a.approver_person_id in (select p.id from public.people p where p.phone = p_phone)
     and a.action = p_action and a.status = 'pending' and a.expires_at > p_now
     and a.code_hash = encode(extensions.digest(a.id::text || ':' || p_code, 'sha256'), 'hex')
   order by a.created_at desc
   limit 1;
$$;

revoke all on function public.peek_approval_code(text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.peek_approval_code(text, text, text, timestamptz) to service_role;
