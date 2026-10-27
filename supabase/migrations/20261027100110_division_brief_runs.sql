-- A brief the head asks for by text (BRIEF) is a run of its own: brief:<division>:<YYYY-MM-DD>:<id of that text's task>.
-- The day's scheduled brief keeps its key, brief:<division>:<YYYY-MM-DD>. Either way the key must name the division and
-- the day it holds, and (brief_key is unique) a text that is retried finds its own run again instead of making a second.
-- Additive: every key the table already holds still passes.

alter table public.division_briefs drop constraint division_briefs_check;
alter table public.division_briefs add constraint division_briefs_check
  check (brief_key ~ ('^brief:' || division || ':' || to_char(brief_date, 'YYYY-MM-DD')
                      || '(:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$'));
