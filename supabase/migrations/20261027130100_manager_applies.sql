-- The HQ Manager applies a lesson, a skill note or a retire by itself (Ezra, in writing, 2026-10-27), with the two
-- minimum rules of the independent review. Additive: no table is dropped or rewritten, every new column is nullable,
-- and no function or policy changes. Synthetic data only.

-- A recommendation may now be a retire: it takes one standing lesson, or one line of the notes, out of a profile.
-- The kind's check is widened (every older row still passes it).
alter table public.recommendations drop constraint if exists recommendations_kind_check;
alter table public.recommendations
  add constraint recommendations_kind_check check (kind in ('lesson', 'skill_note', 'retire', 'reads', 'model'));

-- What each review's digest carried from the doors, so a retried task decides exactly as the first run did:
--   carried_reports : every outside report the reader tool handed the digest script, as [{ "id", "assistant" }], taken
--                     from the tool's output, never from the model's words. A review that carried any applies nothing
--                     by itself. Null (a row from before this column) also applies nothing by itself: it fails closed.
--   scope           : 'internal' (the daily review of work reports only), 'doors' (the daily review of outside reports
--                     only; nothing in it applies by itself) or 'all' (REVIEW, the owner asks).
alter table public.manager_reviews
  add column carried_reports jsonb check (carried_reports is null or jsonb_typeof(carried_reports) = 'array'),
  add column scope text check (scope is null or scope in ('internal', 'doors', 'all'));

notify pgrst, 'reload schema';
