-- A task that takes long keeps its lease by asking for it again, about once a minute, while its worker
-- is alive. The lease itself can then stay short: a worker that dies leaves its task for another try
-- within minutes (well inside an approval code's 15 minutes), not after the longest round it could have
-- been in the middle of.
--
-- Only the worker the task is leased to can extend it, and only while the task is still running. A task
-- another worker took after the lease ran out, or one that is finished, is refused (false): the caller
-- has lost it. The lease only ever moves forward.
create function public.extend_lease(
  p_task_id uuid, p_worker text, p_lease_seconds integer default 300, p_now timestamptz default now()
) returns boolean
language plpgsql set search_path = '' as $$
begin
  update public.tasks
     set lease_until = greatest(lease_until, p_now + make_interval(secs => p_lease_seconds)), updated_at = p_now
   where id = p_task_id and lease_owner = p_worker and status = 'running';
  return found;
end $$;

revoke all on function public.extend_lease(uuid, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.extend_lease(uuid, text, integer, timestamptz) to service_role;
