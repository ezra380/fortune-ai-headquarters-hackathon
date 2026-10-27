-- Wave 2 (docs/wave2.md): each division's recurring workers write a daily report, and its manager writes a weekly
-- report to the head from them. Synthetic data only. RLS is on with NO policies (anon and authenticated see nothing;
-- the worker and the console use the service role). Anything that must happen once is enforced here by a unique key.

-- Reports are also emailed (Postmark; only to the owner's address until real data is connected).
alter type public.outbox_channel add value if not exists 'email';

create table public.worker_reports (
  id uuid primary key default gen_random_uuid(),
  worker_id text not null check (worker_id ~ '^(finance|online|salon)\.[a-z_]{2,40}$'),
  division text not null check (division in ('finance', 'online', 'salon')),
  -- worker:<worker id>:<YYYY-MM-DD>, or with :<task id> for a run asked for by hand. A retried task finds its own run.
  report_key text not null unique,
  report_date date not null,
  period text not null check (length(period) between 1 and 40),
  -- Set by the program from the attention rules, never by a model.
  status text not null check (status in ('normal', 'watch', 'act')),
  written_by text not null check (written_by in ('model', 'rule')),
  report jsonb not null check (jsonb_typeof(report) = 'object'),
  data_source text check (length(data_source) <= 200),
  task_id uuid references public.tasks (id),
  created_at timestamptz not null default now(),
  check (division = split_part(worker_id, '.', 1)),
  check (report_key ~ ('^worker:' || replace(worker_id, '.', '\.') || ':' || to_char(report_date, 'YYYY-MM-DD')
                       || '(:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$'))
);
create index worker_reports_newest on public.worker_reports (division, report_date desc, worker_id);
alter table public.worker_reports enable row level security;

create table public.weekly_reports (
  id uuid primary key default gen_random_uuid(),
  division text not null check (division in ('finance', 'online', 'salon')),
  -- weekly:<division>:<Monday YYYY-MM-DD>, or with :<task id> for a report asked for by text (REPORT).
  report_key text not null unique,
  week_of date not null check (extract(isodow from week_of) = 1),
  period text not null check (length(period) between 1 and 40),
  status text not null check (status in ('normal', 'watch', 'act')),
  written_by text not null check (written_by in ('model', 'rule')),
  report jsonb not null check (jsonb_typeof(report) = 'object'),
  ceo_line text not null check (length(ceo_line) between 1 and 140),
  data_source text check (length(data_source) <= 200),
  -- The message the head approves paths or actions against (approvals.message_id), once it is sent.
  message_id uuid references public.assistant_messages (id),
  task_id uuid references public.tasks (id),
  created_at timestamptz not null default now(),
  check (report_key ~ ('^weekly:' || division || ':' || to_char(week_of, 'YYYY-MM-DD')
                       || '(:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$'))
);
create index weekly_reports_newest on public.weekly_reports (division, week_of desc, created_at desc);
alter table public.weekly_reports enable row level security;

-- The default privileges already deny the public roles (20261027100000_profiles.sql); said again so this file stands alone.
revoke all on table public.worker_reports, public.weekly_reports from anon, authenticated;
