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
