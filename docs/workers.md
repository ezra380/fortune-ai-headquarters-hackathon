# The division managers, their workers and their reports

Wave 2 (docs/wave2.md is the spec of record). Each division has a named manager. The manager has recurring daily
**workers**, one per segment of the division's work, and writes the head a thorough **weekly report** built from
them. This page says who the managers are, how a worker's daily report is made, how the weekly report is built,
who asks whom, how the head approves, and how to run any of it by hand.

| Manager | Division | Reports to (seed stand-in) | Workers |
|---|---|---|---|
| George | Finance | Alan (`Demo Alan`) | `finance.email`, `finance.google_ads`, `finance.meta`, `finance.amazon`, `finance.walmart`, `finance.online_money`, `finance.salon_money` |
| Georgette | Online | Emma (`Demo Emma`) | `online.messages`, `online.journey`, `online.inventory`, `online.returns_reviews`, `online.site_content` |
| Cindy | Salon | Esther (`Demo Esther`) | `salon.clients`, `salon.turnaround`, `salon.appointments` |

The registry is `apps/worker/src/workers.ts` (`WORKERS`): each worker's division, a one-line focus, its metric
families (id prefixes) and its fixed row reads (a read tool's name and fixed arguments). The names come from the
contracts (`MANAGERS`); people rows hold the rest.

## The managers

A manager is the division's assistant: the same read-only profile, with a persona. Each department skill
(`packages/profiles/skills/{finance,online,salon}/SKILL.md`) opens with who the manager is, whom she or he
reports to and serves alone, and what the daily workers cover; its last section, **Your weekly report**, says what
the weekly report holds, the asks between the managers and that the head approves by one-time code. The worker
puts the skill first in the system words of every brief, worker report and weekly report, so this is who the model
is when it writes them.

- **George** (Finance, to Alan) knows the salon's money and the online store's money and keeps them apart: two
  businesses, never added together and never in one sentence. His workers watch email, Google Ads, Meta, Amazon,
  Walmart, the online store's money and the salon's money (each worker's numbers are of one business; a test
  checks it).
- **Georgette** (Online, to Emma) sees online numbers only: customer messages (Emma's reply speed too), the store
  journey, stock and product performance, returns and reviews, site speed, links and the blog.
- **Cindy** (Salon, to Esther) sees salon numbers only: clients and their segments with salon product sales,
  repair and personalization turnaround, appointments.

A text from a division starts with its manager's name: "George: Finance brief for ...", "Georgette, Online: your
weekly report is in ...". The seed (`supabase/seed.sql`) names the assistants `George (finance)`, `Georgette
(online)` and `Cindy (salon)`, and the heads `Demo Alan`, `Demo Emma` and `Demo Esther`, with fictional 555
numbers and no email address. Real demo phones and names are registered locally from `.env.local` by
`scripts/register-demo-phones.ts` and never committed. The profiles in the database change only when they are
seeded again (`npx tsx scripts/seed-profiles.ts --force`, which keeps what the owner approved).

## The clock (New York time)

| When | Job | What it queues |
|---|---|---|
| 07:00 every day | `division-workers` | the fifteen workers, `worker:<id>:<date>` |
| 07:30 Mondays | `weekly-reports` | the three weekly reports, `weekly:<division>:<Monday>`; it waits while the day's workers are still open, for at most an hour after they were queued |
| 08:00 every day | `division-briefs` | the three daily briefs |
| 08:30 every day | `ceo-digest` | the day's CEO digest (it waits for the briefs) |
| after the third weekly report | (no clock) | the weekly CEO digest, `digest:<date>:weekly` |
| 09:00 every day | `manager-review` | the HQ Manager's daily review |

Queuing any of them twice changes nothing: every task is keyed, and so is every step inside it.

## A worker's day

At **07:00** the clock queues all fifteen workers, each as a `scheduled` task for its division's assistant, keyed
`worker:<id>:<YYYY-MM-DD>`. A run asked for by hand adds a request id: `worker:<id>:<date>:<request>`.

1. **Numbers.** The division's numbers are read once (`divisionData`, the division's own mart). The worker
   keeps the metrics whose id starts with one of its prefixes, of its own business, and that its division
   reads (the catalog says who reads what), and the attention rules that fired on those metrics. Another
   division's metric never reaches it, even if a read hands one over. Receipt `worker.data`.
2. **Rows.** Its row reads are called directly (the read tool's own `run()`, never a model's script), and
   only their totals are kept (counts and money, flattened to `a.b` keys). A row tool the data lane has
   not added yet is skipped and the receipt says so. Receipt `worker.rows`.
3. **Status.** From those attention rules (`statusOf`): act, watch or normal. A model never sets it.
4. **Words.** One model call (the brief writer's model, JSON, reasoning on) writes a headline and up to
   five findings that cite the worker's own metric ids. A program checks every number (`numberTrace`:
   each must be a metric value or a row total the report keeps: its first 60 metrics and 4 row reads,
   `workerSource`), every cite, that no sentence puts a salon number next to an online number, and that
   there are no medical words. One correction round with the exact objections; otherwise the program
   writes the report from the rules (`writtenBy: 'rule'`). A model that cannot be reached also gets the
   rule-written report. What was decided is kept before the save (`workerwords:<key>`): a task that runs
   again after the save failed checks the kept words again and asks no model. Receipt `worker.write`.
5. **Save.** The report is checked against `WorkerReport` (contracts) and stored once per key in
   `worker_reports`. A task that runs again finds it and stops: nothing is read or asked twice (receipt
   `worker.reuse`). Receipt `worker.save`.

No text message is sent for a daily report. Every worker's numbers are of one business (a test checks
the prefixes), so a worker never adds the salon and the online store together.

## The weekly report

Each manager writes the head one thorough report a week (`apps/worker/src/weekly.ts`): George to Alan,
Georgette to Emma, Cindy to Esther. At **07:30 on Mondays** the clock queues the three (job `weekly-reports`,
keyed `weekly:<division>:<Monday>`). **REPORT** by text asks for one now: the owner texts `REPORT FINANCE`,
`ONLINE`, `SALON` or `ALL` (`REPORT` alone means all three), a head texts `REPORT` for her own division (another
division's is refused). A text's run is keyed `weekly:<division>:<Monday>:<text's task id>`, so a retried text
asks for the same run and a new text for a new one. Every step below is keyed by the run.

1. **Numbers.** The division's numbers and attention rules, read once. Receipt `weekly.data`.
2. **Workers.** The newest report of each of the division's workers from the seven days up to the run's
   day. A worker with none runs now (the same code as its 07:00 run, under today's key, so the 07:00 task
   finds it stored), unless its own task for today is still queued or running: then it is named as still
   running, so the model is never asked twice for one worker's day. One that still has none (its data is
   not connected yet, say) is named with the reason, never left out silently. No report at all stops the
   task plainly. Receipt `weekly.workers`.
3. **Asking.** See "The asks between the managers" below. Receipts `weekly.needs` and `<division>.lookup`.
4. **Words.** One model call (the plan model, reasoning on, JSON) writes the summary, one section per
   worker that reported, and the CEO line; Online and Salon up to three actions (the brief's shape);
   Finance a **goal of the week** (one of its metrics, `from` exactly its value, a target, a date within
   seven days). A program checks every number against exactly the numbers the report stores
   (`reportMetrics`: the division's metrics, the workers' metrics and the replies' traced values, at most
   250) and the workers' row totals (the goal's target is allowed only in the goal), every cite (a section
   cites only its own worker's ids), no salon number next to an online one, no medical words. One
   correction round; otherwise the program writes it from the rules: each worker's own checked headline as
   its section, the act rules as actions, no goal. What was decided is kept (`weeklywords:<key>`) before
   the next step. Receipt `weekly.write`.
5. **Paths (Finance).** Three profit paths toward the goal through the plan writer and `checkPlans`, from
   Finance's metrics and the replies' traced values in a unit the plan checker can check. Paths that never
   pass mean a rule-written report with no goal and no paths. Kept as `weeklypaths:<key>`. Receipt
   `weekly.paths`.
6. **Save.** The program assembles the `WeeklyReport` (the asked notes, every metric as read with the
   source it was read from, the worker report ids, each section's status from its worker report) and stores
   it once per key in `weekly_reports`. Its status is the worst of the worker reports' and the division's
   attention. Receipt `weekly.save`. A task that runs again after a failed save reuses the kept words and
   paths (checked again against this run's numbers; any that no longer pass give the rule-written report)
   and asks no model twice.
7. **Deliver.** A mailbox row the head's code hangs from (`weeklydoc:<key>`, also kept as the report's
   `message_id`); a `weekly_status` line to the owner with the CEO line (`weeklystatus:<key>`); an email outbox
   row to the head (`attachment_ref weekly_report:<id>`, body = the subject "For <head>: <manager>'s weekly
   report, week of <Monday>"; the delivery lane sends it to `HQ_REPORT_TO` only); a print row (printed only
   when the head has a printer); and a text to the head: "George, Finance: your weekly report is in ...", the
   summary, the goal, the paths or actions, where the full report is ("in your view on the console", "and on
   your printer" only when she has one, and that its email goes to the owner until real data is connected),
   and "Reply APPROVE <1-3> <code> to approve a path" (or an action), one code that lasts 24 hours. A head
   whose assistant has no live number gets no text (receipt `weekly.sms`); the email and printout rows are
   still queued. The third weekly report of a run queues the weekly CEO digest. Receipt `weekly.deliver`.

## The asks between the managers

The weekly report uses the briefs' data-request route (`decideNeeds` and `consult` in brief.ts). One model call
decides what to ask; the needs prompt carries the owner's standing asks (`STANDING_ASKS`). Each question is a
mailbox request that the **other** division answers with its own tools, and a reply's numbers count only when they
come back tied to a metric id of that division's business (`replyMetrics`). A division never reads another's tools.
The reply also keeps, per metric id, the view and query hash of the answering division's tool output that named it
(`replySources`: George's stock numbers carry the finance mart, Cindy's the salon mart, never the asker's). The weekly
report uses a reply's number only when it has that source and a known unit (from the reply or the catalog;
`traceReplies`); one without is left out of the words, the check, the stored metrics and the asked notes alike, and a
reply with none left counts as one that could not answer.

| Who asks | Whom | For what | Why it is an ask |
|---|---|---|---|
| George | Cindy | client segments (frequent, sale-only, summer-only, Mazali buyers, standard: counts and revenue) | `m:salon.clients.*` is read by salon and hq, never by finance |
| George | Georgette | product performance (cost against profit, products that lose money), returns and their reasons | `m:online.products.*` (apart from the money totals), `m:online.returns.*`, `m:online.reviews.*` are online's |
| Georgette | George | Amazon and Walmart stock (low cover, out of stock, inbound), to know when to send goods or restock | the marketplace stock metrics are read by finance and hq, never by online |
| Georgette | Cindy | how long repairs and personalization take at the salon | online never reads `m:salon.*` |
| Cindy | Georgette | (may ask) how many repairs and personalization orders came in online | when it would change what she tells Esther |

What was asked and what came back is kept in the report (`asked`); an answer that could not be given says so and
is never filled in.

## Approvals

The head decides; nothing is carried out by the program. The weekly text carries one code (24 hours): **APPROVE
<n> <code>**, or several at once (`APPROVE 1 2 <code>`), approves George's path n or Georgette's or Cindy's action
n. It is recorded exactly as for a brief: each path or action named is a decision in the World Model and the
division's memory, and the HQ Manager gets a note (`action_decision` with `weeklyReportId` and `kind`). A rank the
report does not have is refused before the code is spent, so the code still works. A plain "yes" decides nothing.

## The CEO digest on a weekly day

The owner's daily digest (08:30, or after the third brief) reads only the briefs' `division_status` lines. When all
three weekly reports of a run are in (Monday's, or a REPORT ALL text's), the last one to be delivered queues a
**weekly CEO digest** for Owner HQ: `digest:<date>:weekly` (or `digest:<date>:weekly:<text's task id>`). It is one
line per division from the managers' weekly CEO lines, by the daily digest's rules (a normal division is the fixed
sentence "running normally."; a division that needs a look or a decision carries its CEO line, shortened by words)
and within the same 480 characters:

```
Weekly reports, week of 2026-10-26:
Salon: running normally.
Finance: needs a look — Finance has something to watch; its head has the detail.
Online: needs a decision — Online needs a decision from its head.
```

A program writes it, never a model. It is kept as `digestdoc:<key>` and texted once (`digest-sms:<key>`); with no
live number for Owner HQ it is stored and the receipt says no text was sent. A head's own REPORT is one division's
run, so it never completes a set and queues no digest.

## Running a worker or a report by hand

All of this is the local stack (`postgresql://postgres:postgres@127.0.0.1:54322/postgres`) with the worker
running (`npm run worker`); the running worker claims a queued task within a few seconds.

- **A weekly report:** text `REPORT` from the owner's phone (all three, or `REPORT FINANCE` / `ONLINE` / `SALON`),
  or `REPORT` from a head's phone for her own division. Each head sees hers in her view (and by text with a live
  number, on her printer with one), the owner sees them on the console, and every email goes to the owner until
  real data is connected. On the local stack without phones, queue the task directly (the request id makes
  it a new run beside the week's):

  ```sql
  with r as (select gen_random_uuid() as id)
  insert into public.tasks (assistant_id, kind, idempotency_key, payload)
  select 'finance', 'scheduled', 'weekly:finance:2026-10-26:' || r.id,
         jsonb_build_object('job', 'weekly_report', 'division', 'finance', 'date', '2026-10-27', 'request', r.id)
  from r;
  ```

  The key's date is the Monday on or before the payload's `date`. Use `online` or `salon` for the others.
- **A worker:** there is no text command for one worker. Queue it with a request id, so it is its own report and
  never replaces the day's:

  ```sql
  with r as (select gen_random_uuid() as id)
  insert into public.tasks (assistant_id, kind, idempotency_key, payload)
  select 'finance', 'scheduled', 'worker:finance.google_ads:2026-10-27:' || r.id,
         jsonb_build_object('job', 'division_worker', 'worker', 'finance.google_ads', 'date', '2026-10-27', 'request', r.id)
  from r;
  ```

  The assistant must be the worker's division (`finance`, `online` or `salon`); any other is refused with a plain
  reason. The report is in `worker_reports` under that key, and the console shows the division's latest.
- **What happened:** every step leaves a receipt (`select step, outcome, detail from public.receipts where
  task_id = '<task id>' order by id`): `worker.*` for a worker, `weekly.*` for a weekly report, `digest.*` for a
  digest.

## What is still to come

- Families and row tools the data lane adds in this wave are listed in `PENDING_DATA_PREFIXES` and
  `PENDING_ROW_TOOLS`; tests fail when one of them appears, so the merge takes it off the list. Until
  then `online.site_content` and `salon.clients` have no metrics and stop plainly.
- Replies to a command (an APPROVE confirmation, a REPORT acknowledgment) keep their wording and do not yet start
  with the manager's name; only the brief and weekly report texts do.
- The weekly digest has no partial form: if one division's weekly report stops for good, no weekly digest is sent
  (the receipts and the console say which report is missing).
