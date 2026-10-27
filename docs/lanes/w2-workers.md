# Lane W1 (wave 2): workers and weekly reports

Branch `hq/w2-workers`, worktree `~/fahq-w2-workers`, cut from `hq/divisions-merge` at 16449bf.
Spec of record: docs/wave2.md ("The workers", "Reports"). How it works in plain words: docs/workers.md.

## Slice 1 of 3: daily workers (2026-10-27, commit 9743b9f)

### What works (with the tests that prove it)

- **Registry** `apps/worker/src/workers.ts` (`WORKERS`): the 15 `WORKER_IDS`, each with its division, a
  one-line focus, its metric prefixes from the docs/wave2.md table and its fixed row reads.
  `workers.test.ts`, "the workers registry":
  - "has the fifteen workers of the contract, each in the division its id names, ..."
  - "every family matches at least one metric its division reads in the v2 catalog, apart from the ones the data lane adds in this wave"
  - "a pending family matches nothing its division reads yet, and every pending family belongs to a worker: the merge empties the list"
  - "keeps each worker's numbers to one business: no worker watches the salon and the online store together"
  - "never selects a metric outside its division's reads, even when a read hands it every metric of every division"
  - "runs only read tools that exist (or that the data lane adds in this wave), each one its division may read"
- **Daily worker task** (`job: 'division_worker'`, routed in flows.ts `scheduled`), keyed
  `worker:<id>:<date>` (or `:<task id>` when asked by hand): division read once, cut to the worker's
  metrics and their attention items; row reads through the read tools' own `run()`, totals only; status by
  `statusOf`; one model call (`deps.models.planModel`, purpose `<worker id>.report`, JSON, thinking on);
  checks: `numberTrace`, own-id cites, `mixedBusinessSentences`, `MEDICAL`; one correction round; else the
  rule-written report (`ruleWords`, built on the brief's `fallbackBrief` findings). Stored by
  `store.saveWorkerReport` (insert once per key, read back). Receipts `worker.data`, `worker.rows`,
  `worker.write`, `worker.save`, `worker.reuse`. No text, no printout.
  `workers-flow.test.ts` (real local DB, under the lock):
  - "Finance (George): the Google worker reads its numbers and the budget room, one model call writes it, and it is stored with the program's status"
  - "Online (Georgette): the messages worker keeps the waiting totals, and an act rule on its metric makes it act"
  - "Salon (Cindy): the turnaround worker reads late and done repairs, and says the personalization read is not connected yet"
  - "a report with a number nobody read is corrected once, then refused, and a program writes it from the rules"
  - "a report citing a metric that is not the worker's is corrected, and the corrected one is the model's"
  - "a model that cannot be reached also leaves a rule-written report, and the receipt says it failed"
  - "runs again after the report was stored: nothing is read or asked twice, and one report is kept"
  - "never sees another division's metric, even when the division read hands one over"
  - "a worker none of whose metrics are in the data yet stops plainly, and no model is asked"
  - "a row read that fails stops the task plainly with a receipt, before any model is asked"
  - "a run asked for by hand is its own report, keyed by its task"
  - "refuses a worker job for the wrong assistant, an unknown worker or a bad date"
  - "queues each worker once a day, however often it is asked, and the database keeps a report's key to its worker and day"
- **Clock** `scheduler.ts`: job `division-workers` at 07:00 New York time, first in `SCHEDULE`.
  `workers.test.ts`, "the 07:00 clock" (due at 07:00 and not at 06:59; queues the 15 keys once, a second
  tick queues nothing). digest.test.ts's schedule tests now filter the new job out of BRIEF_JOBS and list
  it in the full SCHEDULE.
- Proof: seen failing first (the clock tests before the job was added; all 12 flow tests before the route
  was added); mutation checks (no division filter, status from the whole division's attention, no stored-report
  check) each turned the matching tests red. `npm run typecheck` clean; full suite under the lock: 58 files
  passed, 9 skipped (no Meterless engines in this worktree), 1075 tests passed, 173 skipped.

### Not done in this slice

- The weekly report (weekly.ts, REPORT, APPROVE for weekly reports, the digest's weekly CEO lines), the
  persona and "Your weekly report" sections of the SKILL.md files, the seed display names: slices 2 and 3.
- `online.site_content` and `salon.clients` have no metrics until the data lane's v2 additions land, so they
  stop plainly ("the <division> data has no metrics for the <id> worker yet"), with a failed `worker.data`
  receipt, and no model call.

### What the merge must know

- **PENDING_DATA_PREFIXES** (workers.ts) lists the families the data lane adds in this wave. The test
  "a pending family matches nothing its division reads yet ..." fails as soon as one matches: take it off
  the list (the merge empties it).
- **PENDING_ROW_TOOLS** names the row tools this registry expects the data lane to add:
  `get_marketplace_stock` ({ marketplace: 'amazon' | 'walmart' }), `get_store_journey` ({ period }),
  `get_product_performance` ({ sort: 'worst', period }), `get_return_cases` ({ period }), `get_salon_clients` ({}),
  `get_personalization` ({ status: 'late' }). These names and arguments are guesses (the data lane had not
  committed its tools when this slice was written). At the merge, rename the registry entries in `WORKERS`
  to the data lane's real tool names and arguments, take them off `PENDING_ROW_TOOLS`, and the test
  "runs only read tools that exist ..." then also requires each to be in its division's profile reads.
  Until then a pending tool is skipped with a receipt note, never silently.
- Files outside the lane's list: `apps/worker/test/digest.test.ts` (schedule tests: the new 07:00 job
  filtered out of BRIEF_JOBS and added to the full SCHEDULE list). brief.ts only gained exports
  (`sourceTag`, `shownMetric`, `MEDICAL`).
- `WorkerReport.dataSource` and `worker_reports.data_source` are `<view>#<first 12 of the hash>` as the
  contract's comment says; the `worker.data` receipt keeps the usual `zetaris:<view>#<hash>`.
- No new migration: the base's `20261027120000_division_reports.sql` was already applied to the shared stack.
- No contract or migration change was needed.

## Slice 2 of 3: weekly reports (2026-10-27)

### What works (with the tests that prove it)

- **Weekly report task** `apps/worker/src/weekly.ts` (`job: 'weekly_report'`, routed in flows.ts `scheduled`), keyed
  `weekly:<division>:<Monday>` (or `:<task id>` for a REPORT text). Steps and receipts: `weekly.data`, `weekly.workers`
  (newest worker report of each worker in the seven days up to the run's day; a worker with none runs now through
  `dailyWorker` under today's key; one that still has none is named with its reason; none at all stops plainly),
  `weekly.needs` + `<division>.lookup` (the briefs' route: `decideNeeds` with `STANDING_ASKS`, `consult`; replies count only
  through `replyMetrics`), `weekly.write` (plan model, thinking on, JSON; `checkWeeklyWords`: one section per reporting
  worker in order citing only its own ids, actions with distinct ranks and known cites for online/salon, a finance goal on
  one of the division's metrics with `from` exactly its value, `to` different, `by` after the day and within 7 days; every
  number traced, the goal's target allowed only in the goal; no salon/online sentence; no medical words; one correction
  round; else `ruleWords`), `weekly.paths` (finance: `writePlans` + `checkPlans` from Finance's metrics and the replies'
  traced values via `replyPlanMetrics`; no paths = rule-written report, no goal, no paths), `weekly.save`
  (`store.saveWeeklyReport`, status = worst of the worker reports and the division's attention), `weekly.deliver`
  (`weeklydoc:<key>` mailbox row, also stored as `weekly_reports.message_id`; `weeklystatus:<key>` to the owner; email outbox
  row `weekly-email:<id>`; print row `weekly-print:<id>`; the head's SMS through `issueApproval`, `approve_action`, 24 h,
  `weekly-sms:<id>`), `weekly.sms` (refused: no live number; email and print still queued).
- **APPROVE** for weekly reports: brief.ts `approveAction` now reads what a code hangs from (`approvableBehind`: a brief's
  actions, or a weekly report's paths for finance / actions for online and salon, via `weeklyItems`). Same record as for a
  brief; the HQ Manager's note is `action_decision` with `weeklyReportId` and `kind` ('path' or 'action').
- **REPORT** (commands.ts `{ kind: 'report', division }`, flows.ts → `requestWeeklyReports`): owner REPORT / REPORT ALL =
  all three, REPORT FINANCE|ONLINE|SALON = one; a head REPORT (or her own division's name) = hers; another division's is
  refused with a receipt. Keyed by the text's task, dated by the text's arrival (`arrivedAt`, now exported).
- **Clock**: `weekly-reports` at 07:30 New York time, Mondays only (`ScheduledJob.weekdays`, checked in `dueJobs`); it
  answers "waiting" while the day's workers are open, for at most `WEEKLY_WAITS_MINUTES` (60) after they were queued.
- Tests: `apps/worker/test/weekly.test.ts` (16, no database): "the week a report covers" (2), "REPORT by text", "the Monday
  07:30 clock" (3: due Monday 07:30 EDT and EST, not 07:29 nor Tuesday; queues three once workers are done; waits, but not
  past the hour), "the check on the manager's words" (7: passes good words; one section per worker with own cites; the
  goal's metric, from, by and to; the target only in the goal; untraced number, mixed sentence and medical words; an
  untagged reply number; online actions ranked and cited, no goal), "the rule-written report, the asked notes and the head"
  (3). `apps/worker/test/weekly-flow.test.ts` (8, real local DB under the lock): "Finance (George): this week's worker
  reports, workers run now, Cindy's client segments, a checked goal and three paths, delivered to Alan" (and Alan approves
  path 2); "Online (Georgette): asks George for marketplace stock and Cindy for turnaround, writes actions, and Emma
  approves one (a rank it lacks keeps the code)"; "Salon (Cindy): a writer that fails leaves a rule-written report; with no
  live number Esther gets no text, but the email and printout are queued"; "Finance: a goal that does not start at its
  metric's value is corrected once; paths that never pass leave a rule-written report with no goal and nothing to
  approve"; "runs again after the report was stored: nothing is read or asked twice, one report is kept and no second code
  is sent"; "REPORT by text: ..."; "a division brief's code still approves the brief's actions, as before weekly reports
  shared the APPROVE route" (the brief tests need Meterless and are skipped in this worktree, so this guards the
  refactor); "refuses a weekly job for the wrong assistant, an unknown division or a bad date".
- Proof: the flow tests seen failing first with the flows.ts route removed (6 of 7 red; REPORT does not need the route).
  Mutation checks, each turned its tests red and was reverted: no goal-from check; no weekday filter; no REPORT command;
  always run workers now; no wait for the workers; status from the division only; goal kept for online; goal target
  allowed everywhere. The flow test also caught "approve a action" (fixed). `npm run typecheck` clean; full suite under the
  lock twice: 60 files passed, 9 skipped, 1099 tests passed, 173 skipped. (One earlier full run also showed one unhandled
  pg 57P01 error from `supabase/tests/profiles.test.ts` dropping its own temporary database; it did not recur in the next
  two runs and is not from this lane.)

### Not done in this slice

- The digest's weekly CEO lines (digest.ts), the SKILL.md persona and "Your weekly report" sections, and the seeds'
  display names: slice 3.
- What the outbox does with `channel 'email'` and the weekly `print` row (the PDF, Postmark, HQ_REPORT_TO) is the delivery
  lane's; this lane only queues them, keyed.

### What the merge must know

- The CEO line goes to the owner as `body.type = 'weekly_status'` (division, weekOf, date, status, ceoLine,
  weeklyReportId), not `division_status`: the day's digest reads the newest `division_status` line of the day per division,
  and a weekly line there would replace the brief's. Slice 3 adds the weekly lines to the digest.
- store.ts W1 section gained `latestWorkerReport`, `saveWeeklyReport`, `weeklyReportByKey`, `weeklyReport`,
  `setWeeklyReportMessage`, `addEmailOutbox` and the type `WeeklyReportRow`. `addEmailOutbox` exists because `addOutbox`
  and `OutboxRow.channel` still say `'sms' | 'print'`; if the delivery lane widens `addOutbox` to `'email'`, fold
  `addEmailOutbox` into it (one call site, weekly.ts `deliver`).
- brief.ts (my file list): exported `decideNeeds` (optional `weekly` purpose and standing asks; its receipt is then
  `weekly.needs`), `consult`, `AskingRun`, `CEO_LINE`, `arrivedAt`, `weeklyItems`; `approveAction` reads through
  `approvableBehind`. A brief's behaviour and words are unchanged.
- Files outside the lane's list: `apps/worker/test/digest.test.ts` again (the 07:30 Monday job filtered out of BRIEF_JOBS
  and listed in the full SCHEDULE). No contract or migration change; no new migration.
- The weekly writer's purposes are `<division>.weekly_needs`, `<division>.weekly` and (finance) `finance.plans` (writePlans
  sets its own purpose). `WEEKLY_MAX_TOKENS` (default 12000) caps the writer.
