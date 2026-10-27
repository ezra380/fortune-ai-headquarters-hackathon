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

## Slice 3 of 3: personas and the digest (2026-10-27)

### What works (with the tests that prove it)

- **Personas** (`packages/profiles/skills/{finance,online,salon}/SKILL.md`, commit 51b3d21). Each Job section opens "You
  are George, the finance manager. You report to Alan, ...", "You are Georgette, the online manager. You report to Emma,
  ...", "You are Cindy, the salon manager. You report to Esther, ..." (each serves that head alone), then one line naming
  every daily worker's segment; George's second line is his duty to know the salon's money and the online store's money
  and keep them apart. A new last section, **Your weekly report**, says what it holds (summary, one section per worker
  citing only its own ids, what was asked and answered, the CEO sentence; George: the profit goal of the week and three
  paths; the others: up to three ranked actions), the asks on both sides, and that the head approves by one-time code.
  "You never" and "End of work" are the same words on fewer lines, so the bodies are 47 / 44 / 43 lines (limit 48): room
  for the data lane's read lines (finance net 0, online +1 so far, salon none yet). The "You can read" sections are
  untouched. Tests: `packages/profiles/test/personas.test.ts` (13, no database; 12 seen failing first): "%s opens with
  its manager, whom the manager reports to, and serves that head alone", "%s names the segment of every one of its daily
  workers, and no other division's", "%s says what its weekly report holds, who asks whom, and that the head decides by
  one-time code", "puts the weekly report after the daily brief ...", "names the asks between the managers on both
  sides", "gives George the duty to know both businesses' money and keep it apart", "keeps Online and the Salon each to
  their own business in the persona". profiles.test.ts and door.test.ts stay green (line limit, tool names, headings,
  the "Numbers" section word for word, End of work).
- **Texts start with the manager's name** (commit 096cd6c): `briefSms` opens "George: Finance brief for <date> (status
  ...)" (Georgette: Online, Cindy: Salon); the weekly text already opened "George, Finance: your weekly report is in".
  Test: brief.test.ts "the text to the head" (3 red first, incl. "starts with the name of the division's manager,
  whoever the head is").
- **Weekly CEO digest** (commit fb8cd32): the third weekly report of a run (Monday's, or a REPORT ALL text's) queues
  `digest:<date>:weekly` (`:weekly:<text id>` for a text) for Owner HQ, payload `{ job: 'ceo_digest', date, weekOf,
  request? }`. `buildWeeklyDigest` reuses the daily digest's lines, rules and `DIGEST_MAX` (480) under "Weekly reports,
  week of <Monday>:", built from the day's `weekly_status` rows only (`store.weeklyStatusMessages`); the day's own digest
  still reads only `division_status`. Kept as `digestdoc:<key>`, texted once as `digest-sms:<key>`; a weekly digest is
  never partial (refused plainly). Tests: weekly.test.ts "the weekly CEO digest" (3: one line per division by the daily
  rules; no line and the length limit; its own key); weekly-flow.test.ts "the third weekly report of the day queues the
  weekly CEO digest: one line per division from the managers' CEO lines, texted to the owner once" (two of three queue
  nothing; a brief's line that day is ignored; the deliver receipt says so; one doc, one text, a re-run sends nothing
  new; no model call). Mutations, each red then reverted: no queue; queue on every report; reading the briefs' lines;
  another heading.
- **Seed** (commit 9c4a786): `supabase/seed.sql` names the assistants `George (finance)`, `Georgette (online)`, `Cindy
  (salon)` and the heads `Demo Alan`, `Demo Emma`, `Demo Esther` (fictional 555 numbers, no email). Test:
  `supabase/tests/seed.test.ts` (4, reads the file, no database; 3 red on the old seed).
- **docs/workers.md** rewritten: the managers and their personas, the clock table, a worker's day, the weekly report,
  the asks between the managers (table), approvals, the weekly CEO digest with an example, how to run a worker or a
  report by hand (REPORT texts, or a keyed SQL insert with a request id), and what is still to come.
- Proof: `npm run typecheck` clean; full suite under the lock (`flock ~/.fahq-db-test.lock npm test`): 62 files passed,
  9 skipped (no Meterless engines in this worktree), 1121 tests passed, 173 skipped, no unhandled errors (slice 2 ended
  at 60 files and 1099 tests: +2 files, +22 tests).

### Not done in this slice

- Replies to a command (APPROVE confirmations, REPORT acknowledgments, the finance proposal texts in flows.ts) keep their
  wording and do not start with the manager's name. Doing it centrally in common.ts `text()` would change dozens of exact
  reply assertions in brief-flow, digest-flow, chain and departments tests, most of which need the Meterless engines and
  cannot run in this worktree. Only the brief and weekly report texts carry the name.
- No partial weekly digest: if one division's weekly report stops for good, no weekly digest is sent (the receipts and
  the console show which is missing). The owner's STATUS still shows the day's digest only.
- The shared local database was not re-seeded: its assistants still read 'Finance assistant' / 'Online assistant', its
  people 'Demo Finance Owner' and the like, and its stored profiles keep the old skills (see the merge notes).

### What the merge must know

- Files outside the lane's list, each minimal: `apps/worker/test/brief-flow.test.ts` (the exact brief text's first line
  now "George: Finance brief for ..."), `apps/worker/test/chain.test.ts` and `apps/worker/test/digest-flow.test.ts` (the
  owner's and Alan's names read from `public.people` instead of the literals 'Demo Owner' / 'Demo Finance Owner', so they
  pass on the shared database as it is and after a reset with the new seed), `supabase/seed.sql`, new
  `supabase/tests/seed.test.ts`. These three test files need the Meterless engines. **Corrected in the review round:**
  slice 3 said they "typecheck, but run them once at the merge" without running them, and digest-flow in fact had 5
  failures (its BRIEF_JOBS filter missed the two new clock jobs). They have now been run with the engines (see "Review
  fixes" below) and pass. digest-flow's `toContain('Finance brief for')` still holds.
- The SKILL.md personas reach a worker that reads profiles from the database only after `npx tsx scripts/seed-profiles.ts
  --force` (it keeps what the owner approved). The data lane's "You can read" lines merge beside them without touching the
  same lines; keep each body at 48 lines or fewer (finance 47 here).
- The console's "latest CEO digest" reads the newest `digestdoc:%` row, so on a weekly day it shows the weekly digest
  (type `ceo_digest`, plus `weekOf`) once it is in. If the console should keep showing the day's digest, filter
  `body->>weekOf is null` there (delivery lane's file).
- To show the managers' names on the shared stack without a reset (optional, the owner's call): `update public.assistants
  set display_name = 'George (finance)' where id = 'finance'; update public.assistants set display_name = 'Georgette
  (online)' where id = 'online';`. People names on the shared stack are better left until a reset, since other lanes'
  tests in their own worktrees still expect 'Demo Finance Owner'.
- No contract or migration change; no new migration.

## Review fixes (2026-10-27)

An independent review found 1 blocker, 2 majors and 4 minors. All seven are fixed; none was judged wrong. Each fix has a
test that was seen failing first (the blocker's 5 digest-flow tests; the 8 new or changed flow tests and the 1 new workers
unit test before the code changed), and the tests written after their code (replySources) were proven by mutation.

### What works (with the tests that prove it)

- **Blocker: digest-flow's clock tests** (commit 11eb1be). `BRIEF_JOBS` in `apps/worker/test/digest-flow.test.ts` now leaves
  out `division-workers` and `weekly-reports`, as digest.test.ts already did. With the Meterless engines copied into this
  worktree's ignored `.local/meterless` (from `~/fahq-l1`, an old lane worktree; nothing read from the live, merge or
  other wave-2 worktrees), brief-flow, chain and digest-flow were run under the lock: 5 failed before (each "expected
  ['division-workers', 'division-briefs'] to equal ['division-briefs']"), 63 of 63 pass after.
- **Major: a reply's number keeps the answering division's source.** `answerDataRequest` (brief.ts) now stores `sources` in
  the `data_reply` body: per metric id, the view and query hash of the answering division's tool output that names that id
  (`replySources`; an output without a 64-hex hash, or one that does not name the id, gives none: a script's label on a row
  total is not a source). `replyOf` reads it back through zod. weekly.ts `traceReplies` turns each reply's values into
  Metrics with that source; `replyPlanMetrics` no longer stamps the asker's view and hash on them. Tests:
  brief.test.ts "replySources: ... is the view and query hash of the tool output that names the metric's id, never the
  asker's"; weekly.test.ts "the other divisions' answers" (2); weekly-flow.test.ts: each division now has its own mart and
  hash in the fake port, and the Finance test asserts Cindy's `m:salon.clients.frequent.count` carries the salon mart (and
  the stored `data_reply` carries it), the Online test that George's `m:online.amazon.stock.out.count` carries the finance
  mart and Cindy's `m:salon.repairs.avg_days` the salon mart. Mutations (each red, then restored): a source from any output
  whatever ids it names; a hash that is not 64 hex; a reply number with no source still counting.
- **Major: one set of numbers.** `reportMetrics(src)` (the division's metrics, the workers' that differ, the replies' traced
  values, at most 250) is both what `checkWeeklyWords` accepts (ids, numbers, businesses) and what `assemble` stores; a
  reply number counts only with a source and a known unit (the reply's, or the catalog's: days, minutes, seconds and score
  included), and the writer's input, the asked notes and the plan writer (`replyPlanMetrics`: plan units, `planUse`) all
  read the same traced numbers. A reply with none left counts as one that could not answer ("the answer's numbers could
  not be traced to where that division read them"); the `weekly.write` receipt counts the reply numbers left out. In
  workers.ts, `workerSource` keeps the first 60 metrics, the attention on them and the first 4 row reads, and the words are
  checked against exactly that. Tests: weekly.test.ts "uses a reply's number in any unit once it is traced, and never one
  that is not", "is checked against exactly the numbers the report stores: at most 250, the replies last", the asked notes
  test (an untraced reply now says so); weekly-flow.test.ts Online (Cindy answers 9.5 days, Emma's summary quotes it, and
  it is stored with unit `days`); workers.test.ts "checks the words against the numbers the report keeps: its first 60
  metrics, the attention rules on them and 4 row reads". Mutation: the stored set leaving out `days` replies turned 2 red.
- **Minor: keyed writer calls.** The weekly words (`weeklywords:<key>`), George's paths (`weeklypaths:<key>`) and a worker's
  words (`workerwords:<key>`) are kept as mailbox notes (as `needs:<key>` already was) right after their model call, model
  or rule outcome alike. A task that runs again reuses them, checks kept words and paths again against this run's numbers
  (`checkWeeklyWords`, `checkPlans`, `checkWorkerWords`) and asks no model; any that no longer pass give the rule-written
  report, never a second call. Tests: weekly-flow.test.ts "a step that fails after the writers answered: the task runs
  again on the words and paths it kept, and no model is asked twice"; workers-flow.test.ts "a save that fails after the
  model wrote: ..." and "a kept rule-written outcome is kept too: ...".
- **Minor: no doubled worker run.** `gatherWorkers` checks `openTasksByKey([workerKey(id, date)])` before running a worker
  inline; an open one is listed as missing ("its run for <date> is still queued or running, so it is not run a second
  time"). Test: weekly-flow.test.ts "a worker whose own run for the day is still open is not run a second time: ...".
- **Minor: the words to people say what is true now.** The head's text ends "The full report is in your view on the
  console[ and on your printer]. Its email goes to the owner until real data is connected." (the printer only when
  `deps.printers[assistant]` is set). REPORT acknowledgments: the owner "Each head sees hers in her view, and you see them
  all on the console; their emails come to you until real data is connected."; a head "It will reach you in your view on
  the console[, by text][ and on your printer] when it is ready." (text only with a live number). The `weekly.sms` receipt
  says the email and printout are "queued", not sent. Tests: weekly.test.ts the head's text (with and without a printer);
  weekly-flow.test.ts REPORT (Emma with a live number and no printer, then with a printer and no number) and the Salon
  receipt.
- docs/workers.md and docs/divisions.md (the `data_reply` body's `sources`) say the same.
- Proof: `npm run typecheck` clean; full suite under the lock (`flock ~/.fahq-db-test.lock npm test`) with the Meterless
  engines present, so nothing is skipped: 71 files passed, 1304 tests passed, none skipped (slice 3 ran 62 files and 1121
  tests with 9 files and 173 tests skipped for want of the engines).

### Not done

- The daily brief (brief.ts `checkBrief`, owned by the brief lane before this wave) still accepts any reply value, traced
  or not, as before; it stores no metrics list, so nothing it shows carries a wrong source. Only the weekly report uses
  `sources`.
- A row tool's total that a script labels with a metric id has no source (the output does not name the id), so it is left
  out of a weekly report. When the data lane's marketplace and turnaround metrics are in the marts, the answering
  division's metrics tool names them and they trace.

### What the merge must know

- brief.ts gained `ReplySource`, `Reply.sources` (optional), `replySources`, and the `sources` field of the `data_reply`
  body; replies stored before this change have no sources, so a weekly report treats their numbers as untraced. The
  console reads `data_reply` rows by `datareply:%` and is unaffected.
- New mailbox note keys: `weeklywords:<key>`, `weeklypaths:<key>`, `workerwords:<key>` (kind `report`, the assistant to
  itself; the console lists none of them).
- `weeklySms(row, tail, { printer })` has a third, optional argument.
- Files outside the lane's list: `apps/worker/test/digest-flow.test.ts` (the filter), `docs/divisions.md` (one sentence).
  No contract or migration change; no new migration. `.local/meterless` is ignored by git and not committed.
