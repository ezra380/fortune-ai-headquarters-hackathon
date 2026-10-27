// _lib/hqBoardSql.js — every statement the Fortune HQ board runs against the HQ database (Fortune AI Headquarters).
//
// READ ONLY. Each one names its columns, takes its values as $n parameters, and never selects what is secret:
// approvals (code hashes) are not read at all, door_tokens are never touched, people are read for name, role and
// phone only, tasks are read as their job and worker names (never the payload, which holds the text she sent),
// and inbound_texts and model_spend are never read. Column names come from the HQ migrations
// (supabase/migrations/*.sql) and the HQ console's loader (apps/console/src/loader.ts).
// $1 is always one of the six fixed assistant ids or three division ids (hq-board.js checks the tab first).

export const SQL = {
  profile: `select a.id::text as id, a.display_name, a.sms_from, p.version, p.title, p.reads, p.models, p.lessons, p.updated_at
              from public.assistants a
              left join public.assistant_profiles p on p.assistant_id = a.id
             where a.id = $1::public.assistant_id`,

  head: `select name, role, phone from public.people where assistant_id = $1::public.assistant_id order by id limit 1`,

  live: `select id, kind, status::text as status, payload->>'job' as job, payload->>'worker' as worker,
                created_at, updated_at
           from public.tasks
          where assistant_id = $1::public.assistant_id and status in ('running', 'queued', 'waiting')
          order by created_at desc
          limit 100`,

  workerLatest: `select distinct on (worker_id) worker_id, report_date::text as report_date, status, written_by,
                        report->>'headline' as headline, report->'findings' as findings, created_at
                   from public.worker_reports
                  where division = $1
                  order by worker_id, report_date desc, created_at desc`,

  workerWeek: `select worker_id, report_date::text as report_date, status, report->>'headline' as headline
                 from public.worker_reports
                where division = $1 and report_date >= $2::date
                order by report_date desc, created_at desc
                limit 300`,

  weekly: `select week_of::text as week_of, status, ceo_line, report->>'summary' as summary, report->'goal' as goal,
                  report->'paths'->'plans' as plans, report->'actions' as actions, report->'sections' as sections, created_at
             from public.weekly_reports
            where division = $1
            order by week_of desc, created_at desc
            limit 1`,

  brief: `select brief_date::text as brief_date, status, brief->>'headline' as headline, brief->'actions' as actions, created_at
            from public.division_briefs
           where division = $1
           order by brief_date desc, created_at desc
           limit 1`,

  outgoing: `select o.id, o.channel::text as channel, o.status::text as status, o.body, o.created_at, pe.name as to_name
               from public.outbox o
               left join public.people pe on pe.id = o.to_person_id
              where o.from_assistant = $1::public.assistant_id and o.status in ('pending', 'sending')
              order by o.created_at desc
              limit 60`,

  history: `select o.id, o.channel::text as channel, o.status::text as status, o.body, coalesce(o.sent_at, o.created_at) as at,
                   pe.name as to_name
              from public.outbox o
              left join public.people pe on pe.id = o.to_person_id
             where o.from_assistant = $1::public.assistant_id and o.status in ('sent', 'failed', 'skipped')
             order by coalesce(o.sent_at, o.created_at) desc
             limit 60`,

  mailbox: `select from_assistant::text as from_a, to_assistant::text as to_a, kind::text as kind, created_at,
                   body->>'type' as type,
                   left(coalesce(body->>'text', body->>'summary', body->>'headline', body->'words'->>'headline', body->>'question', body->>'title',
                                 body->>'ceoLine', body->>'reason'), 1200) as said
              from public.assistant_messages
             where from_assistant = $1::public.assistant_id or to_assistant = $1::public.assistant_id
             order by created_at desc
             limit 60`,

  versions: `select version, made_by, left(reason, 400) as reason, created_at
               from public.assistant_profile_versions
              where assistant_id = $1::public.assistant_id
              order by version desc
              limit 30`,

  decisions: `select m.created_at, m.body->>'verdict' as verdict, m.body->>'title' as title,
                     coalesce(m.body->>'rank', m.body->>'planRank') as rank, pe.name as by_name
                from public.assistant_messages m
                left join public.people pe on pe.id = m.body->>'by'
               where m.kind = 'decision'
                 and (m.from_assistant = $1::public.assistant_id or m.to_assistant = $1::public.assistant_id)
               order by m.created_at desc
               limit 30`,

  // The HQ Manager's findings about this assistant (manager_reviews.review.findings[].assistant is an assistant id).
  reviewFindings: `select r.created_at, f->>'text' as text
                     from public.manager_reviews r
                    cross join lateral jsonb_array_elements(
                          case when jsonb_typeof(r.review->'findings') = 'array' then r.review->'findings' else '[]'::jsonb end) f
                    where f->>'assistant' = $1
                    order by r.created_at desc
                    limit 30`,

  // The HQ Manager's own memory: the summaries of the reviews it wrote.
  reviewSummaries: `select created_at, review->>'summary' as text from public.manager_reviews order by created_at desc limit 20`,

  // Who decided a recommendation (decided_by) is not read, as in the console.
  recommendationsFor: `select kind, change, status, applied_by, coalesce(decided_at, created_at) as at
                         from public.recommendations
                        where assistant_id = $1::public.assistant_id
                        order by created_at desc
                        limit 30`,

  digest: `select created_at, left(body->>'text', 4000) as text
             from public.assistant_messages
            where kind = 'report' and from_assistant = 'owner' and to_assistant = 'owner' and dedupe_key like 'digestdoc:%'
            order by created_at desc
            limit 1`,

  weeklyByDivision: `select distinct on (division) division, status, ceo_line
                       from public.weekly_reports
                      order by division, week_of desc, created_at desc`,

  briefByDivision: `select distinct on (division) division, status, ceo_line
                      from public.division_briefs
                     order by division, brief_date desc, created_at desc`,

  heads: `select assistant_id::text as assistant_id, name from public.people order by id`,

  latestReview: `select created_at, review->>'summary' as summary, scope
                   from public.manager_reviews
                  order by created_at desc
                  limit 1`,

  recommendationsAll: `select assistant_id::text as assistant, kind, change, status, applied_by, coalesce(decided_at, created_at) as at
                         from public.recommendations
                        order by created_at desc, rank asc
                        limit 60`,

  usage: `select assistant_id::text as assistant, count(*)::int as tasks,
                 (count(*) filter (where outcome = 'failed'))::int as failed,
                 coalesce(sum(model_calls), 0)::int8 as model_calls,
                 coalesce(sum(input_tokens + output_tokens), 0)::int8 as tokens
            from public.work_reports
           where ended_at >= $1::timestamptz
           group by assistant_id
           order by assistant_id`,

  doorReports: `select tool, left(summary, 1200) as summary, created_at, reviewed_at is not null as reviewed
                  from public.session_reports
                 where assistant_id = $1::public.assistant_id
                 order by created_at desc
                 limit 60`,
};
