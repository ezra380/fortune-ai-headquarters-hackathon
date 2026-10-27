# The division workers and their reports

Wave 2 (docs/wave2.md is the spec of record). Each division's named manager has recurring daily
**workers**, one per segment of the division's work. This page says how a worker's daily report is made.
The weekly report built from them is described in a later section of this page when it lands.

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

## What is still to come in this wave

- Families and row tools the data lane adds in this wave are listed in `PENDING_DATA_PREFIXES` and
  `PENDING_ROW_TOOLS`; tests fail when one of them appears, so the merge takes it off the list. Until
  then `online.site_content` and `salon.clients` have no metrics and stop plainly.
- The weekly report (Mondays 07:30 ET and `REPORT` by text) is the next slice.
