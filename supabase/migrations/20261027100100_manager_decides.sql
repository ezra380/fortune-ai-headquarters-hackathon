-- The HQ Manager decides what changes in a profile: typed recommendations, and the session reports it has read.
-- Additive only: no table is dropped or rewritten, every new column has a default or is nullable, and the
-- functions and policies of the earlier migrations are untouched. Synthetic data only.

-- What a recommendation changes. Older rows (and a review that names no kind) are lessons.
--   lesson / skill_note : the manager applies it itself, as a new profile version
--   reads / model       : waits for the owner's one-time code
-- `detail` holds the typed part ({ reads: { add, remove } } or { model: { job, model } }) and, when the program
-- refused to apply a recommendation, { refused: "<why>" }.
-- `applied_by` says who made it take effect and `applied_version` which profile version that made; a recommendation
-- the manager applied has status 'adopted' with no `decided_by` (no person decided it), so every reader of
-- adopted recommendations (the standing lessons, the console) sees it without change.
alter table public.recommendations
  add column kind text not null default 'lesson' check (kind in ('lesson', 'skill_note', 'reads', 'model')),
  add column detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  add column applied_by text check (applied_by in ('manager', 'owner')),
  add column applied_version integer check (applied_version >= 1);

-- The review that read an outside session's report. `reviewed_at` (already there) says when.
alter table public.session_reports
  add column review_id uuid references public.manager_reviews (id);
create index session_reports_by_review on public.session_reports (review_id) where review_id is not null;

notify pgrst, 'reload schema';
