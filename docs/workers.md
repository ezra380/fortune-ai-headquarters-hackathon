# The division workers and their reports

Wave 2 (docs/wave2.md is the spec of record). Each division's named manager has recurring daily
**workers**, one per segment of the division's work. This page says how a worker's daily report is made,
and how the manager's weekly report to the head is built from them.

| Manager | Division | Reports to | Workers |
|---|---|---|---|
| George | Finance | Alan | `finance.email`, `finance.google_ads`, `finance.meta`, `finance.amazon`, `finance.walmart`, `finance.online_money`, `finance.salon_money` |
| Georgette | Online | Emma | `online.messages`, `online.journey`, `online.inventory`, `online.returns_reviews`, `online.site_content` |
| Cindy | Salon | Esther | `salon.clients`, `salon.turnaround`, `salon.appointments` |

The registry is `apps/worker/src/workers.ts` (`WORKERS`): each worker's division, a one-line focus, its
metric families (id prefixes) and its fixed row reads (a read tool's name and fixed arguments).

## A worker's day

At **07:00 New York time** the clock queues all fifteen workers (job `division-workers`), each as a
`scheduled` task for its division's assistant, keyed `worker:<id>:<YYYY-MM-DD>`. Queuing twice changes
nothing. A run asked for by hand adds the asking task's id: `worker:<id>:<date>:<task id>`.

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
   each must be a metric value or a row total it was given), every cite, that no sentence puts a salon
   number next to an online number, and that there are no medical words. One correction round with the
   exact objections; otherwise the program writes the report from the rules (`writtenBy: 'rule'`). A
   model that cannot be reached also gets the rule-written report. Receipt `worker.write`.
5. **Save.** The report is checked against `WorkerReport` (contracts) and stored once per key in
   `worker_reports`. A task that runs again finds it and stops: nothing is read or asked twice (receipt
   `worker.reuse`). Receipt `worker.save`.

No text message is sent for a daily report. Every worker's numbers are of one business (a test checks
the prefixes), so a worker never adds the salon and the online store together.

## The weekly report

Each manager writes the head one thorough report a week (`apps/worker/src/weekly.ts`): George to Alan,
Georgette to Emma, Cindy to Esther. At **07:30 New York time on Mondays** the clock queues the three
(job `weekly-reports`, keyed `weekly:<division>:<Monday>`). It waits while the day's workers are still
queued or running, for at most an hour after they were queued, so the report is built from today's
worker reports. **REPORT** by text asks for one now: the owner texts `REPORT FINANCE`, `ONLINE`, `SALON`
or `ALL` (`REPORT` alone means all three), a head texts `REPORT` for her own division (another division's
is refused). A text's run is keyed `weekly:<division>:<Monday>:<text's task id>`, so a retried text asks
for the same run and a new text for a new one. Every step below is keyed by the run.

1. **Numbers.** The division's numbers and attention rules, read once. Receipt `weekly.data`.
2. **Workers.** The newest report of each of the division's workers from the seven days up to the run's
   day. A worker with none runs now (the same code as its 07:00 run, under today's key, so the 07:00 task
   finds it stored). One that still has none (its data is not connected yet, say) is named with the
   reason, never left out silently. No report at all stops the task plainly. Receipt `weekly.workers`.
3. **Asking.** The briefs' data-request route (`decideNeeds` and `consult` in brief.ts). The needs prompt
   carries the owner's standing asks (`STANDING_ASKS`): George asks Cindy for client segments and
   Georgette for product performance, cost against profit and returns; Georgette asks George for Amazon
   and Walmart stock and Cindy for repair and personalization turnaround; Cindy may ask Georgette about
   online intake. The answering division pulls its own data with its own tools, and a reply's numbers
   count only when they come back tied to a metric id of that division's business (`replyMetrics`).
   Receipts `weekly.needs` and `<division>.lookup`.
4. **Words.** One model call (the plan model, reasoning on, JSON) writes the summary, one section per
   worker that reported, and the CEO line; Online and Salon up to three actions (the brief's shape);
   Finance a **goal of the week** (one of its metrics, `from` exactly its value, a target, a date within
   seven days). A program checks every number against the division's metrics, the workers' metrics and
   row totals and the replies' values (the goal's target is allowed only in the goal), every cite (a
   section cites only its own worker's ids), no salon number next to an online one, no medical words.
   One correction round; otherwise the program writes it from the rules: each worker's own checked
   headline as its section, the act rules as actions, no goal. Receipt `weekly.write`.
5. **Paths (Finance).** Three profit paths toward the goal through the plan writer and `checkPlans`, from
   Finance's metrics and the replies' traced values. Paths that never pass mean a rule-written report
   with no goal and no paths. Receipt `weekly.paths`.
6. **Save.** The program assembles the `WeeklyReport` (the asked notes, every metric as read, the worker
   report ids, each section's status from its worker report) and stores it once per key in
   `weekly_reports`. Its status is the worst of the worker reports' and the division's attention.
   Receipt `weekly.save`.
7. **Deliver.** A mailbox row the head's code hangs from (`weeklydoc:<key>`, also kept as the report's
   `message_id`); a `weekly_status` line to the owner with the CEO line (`weeklystatus:<key>`; the day's
   digest still reads the briefs' `division_status` lines); an email outbox row to the head
   (`attachment_ref weekly_report:<id>`, body = the subject "For <head>: <manager>'s weekly report, week
   of <Monday>"); a print row; and a text to the head: "George, Finance: your weekly report is in ...",
   the summary, the goal, the paths or actions, and "Reply APPROVE <1-3> <code> to approve a path" (or an
   action), one code that lasts 24 hours. A head whose assistant has no live number gets no text (receipt
   `weekly.sms`); the email and printout are still queued. The delivery lane decides what the outbox does
   with the email and print rows. Receipt `weekly.deliver`.

**APPROVE** with a weekly report's code records the head's choice exactly as for a brief: each path or
action named is a decision in the World Model and the division's memory, and the HQ Manager gets a note
(`action_decision` with `weeklyReportId`). Nothing is carried out. A rank the report does not have is
refused before the code is spent, so the code still works.

## What is still to come in this wave

- Families and row tools the data lane adds in this wave are listed in `PENDING_DATA_PREFIXES` and
  `PENDING_ROW_TOOLS`; tests fail when one of them appears, so the merge takes it off the list. Until
  then `online.site_content` and `salon.clients` have no metrics and stop plainly.
- The digest's weekly CEO lines, the managers' personas and "Your weekly report" sections of the
  SKILL.md files, and the seeds' display names are the next slice.
