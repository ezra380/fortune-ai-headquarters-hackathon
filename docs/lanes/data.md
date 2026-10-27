# Lane notes: the division data (branch hq/div-data, worktree ~/fahq-div-data)

Cut from hq/foundation at bb29578. Design of record: the lane's `A-divisions.md`. What is built and how it
is proven: `docs/data.md`. Each slice appends below; nothing above is rewritten.

## Slice 1 of 4: foundation (2026-10-27, 07:37–08:05 ET)

### What works (with the tests that prove it)

- **Slice 0, live Zetaris probe** (`packages/data/scripts/zetaris-probe.ts`, results in `docs/data.md`):
  `AVG() OVER ()` and `LAG(…, 12)` over a grouped REST view, window + `stack()` unpivot, a view `UNION ALL`
  of two sources asked per period (values right: no filter pushdown below the window), a view reading a view,
  a join of two REST views, `DATEDIFF` / `unix_timestamp` / `COUNT(DISTINCT)`, and a two-table Virtual Data
  Mart. All passed live. There is no SQL to drop a schemastore container; a database and a container share
  one namespace.
- **Version 1 frozen** (`frozen-v1.test.ts`): today's rows (sha256), the live view body (sha256) and all 33
  values of `2026-09` and `2026-10-mtd` equal bb29578's, computed by running bb29578's own code; version 2
  reproduces the same 33 values from its thirteen months.
- **Thirteen periods**: `PERIOD_KEYS`, `Period`, `DEFAULT_PERIODS` in `@fahq/contracts`; `DataPort.periods`
  (optional). The six hard-coded places now use `Period`: `read-tools.ts`, `brain-mcp.ts`, `finance.ts` (two),
  `common.ts`, `main.ts`. Read tools and the MCP door offer exactly the port's periods, so version 1's
  signatures are unchanged (`read-tools.test.ts` "offers exactly the periods the data serves…",
  `doors.test.ts` same name).
- **History, Meta, budget sheet** (`year.test.ts`): `generateHistory()`, `generateDivisions()` (each new
  source its own FNV-named stream), `generateYear()`; every source in every period; ids letter-before-digits;
  four planted bad rows only; budget caps in $50 steps with one proposed raise that never counts; no medical or
  hair-loss key or value anywhere; the invented `SEASON` shows.
- **MetricDef** gains `divisions`, `layer`, `about`, `nouns`, `planUse`, `since`; the catalog carries
  `divisions` (`catalog.test.ts`: business stays separate, every count has nouns, no digits in labels, each
  division's slice). Version 2 adds Meta's four ad metrics, three approved budget caps and
  `m:online.dq.rejected_budgets`: 41 metrics per period.
- **Oracle** `computeAll(rows, version)` → `Map<Period, Map<id, value>>` (replaces
  `computeFinanceMetricsLocally`).
- **Version 2 in Zetaris, beside version 1** (`zetaris-objects.ts`, `zetaris-setup.ts --v2`,
  `zetaris-objects.test.ts`): `*_v2` REST tables, `FORTUNE_DEMO_FINANCE.budgets`, container `fortune_hq_v2`,
  row views and `fortune_hq_v2.period_metrics`, served on port 18121. **Proved live at 07:58 ET: 41 of 41
  metrics in each of the 13 periods.** `FAHQ_DATA_VERSION=2` makes the DataPort read it
  (`zetaris.test.ts` "reads version 2 only when FAHQ_DATA_VERSION=2…"); the default is 1.

Test counts at the end of the slice: `npm run typecheck` green; `packages/data` 47 tests in 7 files green;
`read-tools.test.ts` 19 and `doors.test.ts` 13 green. Full `npm test`: 535 passed, 19 failed, all in
real-database files (`supabase/tests/db.test.ts`, `chain.test.ts`, and on one run `departments.test.ts` and
`manager.test.ts`). Tier 0: on bb29578's own code in this worktree, `db.test.ts` fails the same two RLS tests
and `chain.test.ts` fails four (a different four), so these come from the shared local database (other
lanes' tables and concurrent runs), not from this branch. `departments` and `manager` pass when run alone.

### Not done (next slices)

- Season index metrics (`m:{salon,online}.season.{month_index,last_year_index}`): the probe shows the
  window shape works in Zetaris; add the window layer to `sourceSelect()` for orders and appointments, and
  the same numbers to `computeAll`.
- Derived layer (`fortune_hq_v2.derived_metrics`: budget room and used, MER) and the DataPort reading it as
  a second statement, with the query hash covering both bodies.
- Standing layer, division marts and per-division filter views, `getDivisionMetrics`, `sliceFor` by
  `divisions`, the new read tools (`get_budget_room`, `get_metric_series`, …), SKILL.md "You can read"
  lists, `READ_TOOL_NAMES`/`SHAPES`, `DOOR_READS` (adds `get_salon_metrics`), `PLAN_SYSTEM` rules.
- The other new sources (repairs, clients, refunds, checkouts, messages, invoices, inventory; sessions last)
  and their data-quality metrics (`rejected_ads`, `rejected_email`, …).
- Version 1 was not re-proved live (its tables read port 18120, where the live worker's server runs).
- By Ezra's cut: no salon–online customer join (xjoin, segments, client profiles) and no combined money
  metrics.

### What the merge must know

- **Outside packages/data:** `packages/contracts/src/schemas.ts` (`PERIOD_KEYS`, `Period`,
  `DEFAULT_PERIODS`), `packages/contracts/src/ports.ts` (`DataPort.periods?`, imports `Period`),
  `apps/worker/src/{read-tools,finance,common,main}.ts` (the `Period` type; read tools offer the port's
  periods), `packages/codemode/src/brain-mcp.ts` (the door's period enum comes from the port; the module-level
  `period` constant is gone), `apps/worker/test/read-tools.test.ts` and `packages/codemode/test/doors.test.ts`
  (one test each), `scripts/zetaris-setup.ts` (`--v2`).
- `computeFinanceMetricsLocally` is gone; use `computeAll(rows, 1).get(period)`.
- `MetricInfo` in the catalog now carries `divisions` under both versions (only `read-tools.ts` reads the
  catalog today, by business).
- `main.ts`: `FINANCE_PERIOD` may now name any of the 13 periods; under version 1 anything but the last two
  makes the port refuse with "unknown period" (a typo still falls back to `2026-09`, as before).
- Env: `FAHQ_DATA_VERSION` (1 default, or 2), `FAHQ_SOURCE_PORT_V2` (default 18121). Nothing live changes
  until the worker runs with `FAHQ_DATA_VERSION=2`; rollback is unsetting it.
- Zetaris now holds version 2's objects (listed in `docs/data.md`) and an empty container
  `fortune_demo_probe` (no SQL can drop a container). Version 1's objects were never named or touched.

## Slice 2 of 4: divisions in Zetaris (2026-10-27, 08:04–08:30 ET)

### What works (with the tests that prove it)

- **Season, derived and standing layers** (`packages/data/src/layers.ts`, `layers.test.ts`, 11 tests): the
  derived view `fortune_hq_v2.derived_metrics` reads the period view once and makes budget left and share
  used per channel, total ad spend, revenue per ad dollar (`m:online.mer`), and the season index per
  business (month against the twelve-month average by `AVG() OVER ()`; same month last year by
  `LAG(…, 12)` in its own select). The standing view `fortune_hq_v2.standing_metrics` (as of 2026-10-26,
  period `standing`): last seven days of salon and online revenue, proposed budget changes waiting (1).
  The oracle `computeLayers()` is checked against the rows directly ("budget left is the approved cap
  minus spend…", "averages the twelve whole months' season index to one…", "counts the proposed October
  Google raise…"). The live v2 period view was not rebuilt: its body's sha256 is pinned
  (`frozen-v1.test.ts` "keeps version 2's period view as it was built live…").
- **Divisions in Zetaris** (`packages/data/src/divisions.ts`, `divisions.test.ts`, 12 tests): twelve filter
  views from the catalog's `divisions`, four marts `fortune_demo_v2_{salon,finance,online,hq}_mart`
  (tables `period_metrics`, `derived_metrics`, `standing_metrics`), the queries and hash text of a
  division read, `divisionSlice()` (the oracle's answer per division), and `ATTENTION` + `attentionFor()`
  ("has a level and a plain sentence without numbers…", "only picks out values it is given…", "fires on the
  synthetic year where the data says so…").
- **DataPort** (`zetaris.test.ts`, "division reads (version 2)", 3 tests, plus the updated version tests):
  `getDivisionMetrics({ division, period, asOf })` exists only under `FAHQ_DATA_VERSION=2`, reads the
  division's mart in three statements, returns `{ division, metrics, attention, queryHash, view }`, refuses
  a row outside the division, a duplicate, an unknown division or period and an empty answer. Version 2's
  `getFinanceMetrics` reads the three layer views unsliced (54 metrics a period). Version 1's read and its
  hash formula are unchanged (pinned by a test). `MetricInfo.layer` (optional) is new; `catalog` lists every
  layer under version 2.
- **Setup** (`scripts/zetaris-setup.ts --v2`): builds what is missing including the marts, proves every
  layer view, every mart table for all periods and the DataPort's reads for every division, and checks
  version 1's mart listing before and after. **Live run 08:19–08:25 ET: all created, 145 comparisons all
  matched, 0 mismatches, version 1's mart listed exactly as before.** Division reads take 1.5–3.1 s live.
- Catalog invariants now run over all three layers (`catalog.test.ts`); object-safety checks cover the marts
  and drop order (`zetaris-objects.test.ts`, 5 tests).

Test counts: `npm run typecheck` green; `packages/data` 75 tests in 9 files green. Full `npx vitest run`:
580 passed, 2 failed, both in `supabase/tests/db.test.ts` (the two RLS tests slice 1's tier-0 run showed
failing on bb29578's own code against the shared local database).

### Not done (next slices)

- The worker does not call `getDivisionMetrics` yet: `rounds.ts` and the read tools still read
  `getFinanceMetrics` and slice by business; `sliceFor` by divisions, the new read tools
  (`get_budget_room`, `get_metric_series`, `get_company_overview`…), the SKILL.md "You can read" lists,
  `READ_TOOL_NAMES`/`SHAPES`, `DOOR_READS` and the `PLAN_SYSTEM` rules ("period standing means as of the
  data date", seasonal budget = cap × last-year index).
- `getFinanceMetrics` under version 2 is not an alias of `getDivisionMetrics('finance')` (the design said
  alias): it stays the unsliced read so the rounds and read tools, which slice it by business, keep every
  department's numbers. Make it the finance slice once the worker reads divisions.
- The other new sources (repairs, invoices, messages, checkouts, inventory, …), their standing counts and
  attention rules; contribution and refund rate.

### What the merge must know

- **Outside packages/data:** `packages/contracts/src/ports.ts` (`MetricInfo.layer?`, additive);
  `scripts/zetaris-setup.ts` (the v2 proof). Nothing in the worker, profiles or door changed this slice.
- Under version 2 a metric's `period` may be `standing` and its `source.view` names the layer view or mart
  table it came from (not the top-level `view`).
- Zetaris now also holds `fortune_hq_v2.{derived,standing}_metrics`, the twelve
  `fortune_hq_v2.<division>_<layer>_metrics` views and the four `fortune_demo_v2_*_mart` marts. Mart table
  names are per mart (four `period_metrics` coexist). Nothing of version 1 was named or changed.
- Env: unchanged (`FAHQ_DATA_VERSION`, `FAHQ_SOURCE_PORT_V2`). No migration.

## Slice 3 of 4: new sources (2026-10-27, 08:29–09:22 ET)

### What works (with the tests that prove it)

- **Seven new sources**, each its own seeded stream (`generateOperations(orders)` in `synthetic.ts`; the
  year's orders are only read, for real order ids), its own row view and REST table, its data-quality rule
  (`OPS_SOURCES` in the new `packages/data/src/operations.ts`), exactly one planted bad row and a
  rejected-rows metric: order fees and shipping (`order_costs`), refunds, checkouts (abandoned and
  recovered), inventory with product views, the support inbox (new database `FORTUNE_DEMO_SUPPORT`; no body,
  subject or text column), salon repair tickets, supplier invoices. `operations.test.ts` "reject exactly the
  one planted row of each source, and count it in its own month only", "say in SQL what they say in
  TypeScript…"; `year.test.ts` "point every order a row names at a real sale…", "let nothing happen after
  the data date…", "keep the salon closed on Saturdays…, plus one in each new source".
- **Appointments' new columns** (`location`, `booked_via`, `labor_cost_usd`, own stream, version 1's
  columns and values unchanged): version 2's rule checks them (`specOf('appointments', 2)`; version 1's
  rule and view are frozen), planted `demo-a-bad-location`. Six metrics: no-show rate, revenue per location,
  online-booked share, labor cost, salon gross profit after labor (salon, finance, hq). `frozen-v1.test.ts`
  "carries version 1's rows unchanged among its own: every version 1 column and value…";
  `operations.test.ts` "check version 2's appointment columns by version 2's rule only…".
- **Metrics:** 81 period (was 41), 14 derived (adds `m:online.refund_rate`, `m:online.contribution` =
  gross profit − fees − shipping − refunds − all ad spend), 15 standing (adds messages waiting now and over a
  day from the last week, repairs open and open over two weeks, per business AP open, due within thirty days,
  overdue amount and count). Every new number is checked against the rows directly in `operations.test.ts`
  (online, salon and finance blocks). `MetricDef.test` (a `Cond`: SQL + TypeScript with SQL's NULL rules)
  and `business: 'combined'` (only `m:combined.dq.rejected_invoices`, a count read by Finance and HQ) are new.
  The oracle returns no value for a ratio over a zero denominator, as Zetaris does.
- **Routing:** salon 24/2/3, finance 54/14/11, online 50/5/3, hq 19/14/11 ids per layer;
  `divisions.test.ts` "route the day-to-day systems: repairs to the Salon, the inbox, checkouts and stock to
  Online, what is owed and what sales cost to Finance" (also: HQ reads every rejected-rows count; a combined
  metric is a count read only by Finance and HQ; Finance reads no inbox or stock; Online nothing owed).
- **Attention:** six new rules (messages waiting over a day, act; missed buyers, watch; wanted out of stock,
  act; wanted low stock, watch; repairs open over two weeks, act; overdue supplier invoices, act).
  `divisions.test.ts` "fires on the day-to-day systems where their rows say so…"; `zetaris.test.ts`
  "reports the attention rules that fired, each on the division's own numbers…".
- **No-medical guard** (`no-medical.test.ts`, 4 tests): every column and string value of all 16 routes
  (bad rows included), every allowed value of every enumerated column (`SOURCE_ENUMS`, proven complete
  against the good rows), the inbox's columns (no body/text/subject), every metric id/label/about and every
  view body.
- **Proved live, `--v2 --recreate` 08:56–09:20 ET:** 145 comparisons, all matched, 0 mismatches; 81 of 81
  period metrics in each of the 13 periods; DataPort unsliced 108, salon 28, finance 77, online 57, hq 42;
  version 1's mart listed exactly as before; "version 2 verified". The version 2 period view pin in
  `frozen-v1.test.ts` moved to that body (`e8198a3c…`).

Test counts: `npm run typecheck` green; `packages/data` 96 tests in 11 files green. Full `npx vitest run`
(09:00 ET): 601 passed, 2 failed, both in `supabase/tests/db.test.ts` (the same two RLS tests slice 1's
tier-0 run showed failing on bb29578's own code against the shared local database).

### Not done

- The worker still reads none of this: read tools (`get_repair_tickets`, `get_supplier_invoices`,
  `get_waiting_conversations`, `get_low_stock_interest`, `get_company_overview`, …), `sliceFor` by divisions,
  SKILL.md "You can read" lists, `READ_TOOL_NAMES`/`SHAPES`, `DOOR_READS`, `PLAN_SYSTEM` rules.
- Rejected-rows metrics and extra rules for ads and email; email flow/campaign split and unsubscribes;
  Meta campaigns and late agent reports; store sessions and landing pages.
- Average repair turnaround in days and average first-reply minutes: `Metric.unit` has no `days`/`minutes`
  (the design's validator step 4c); the `within_14d` and `replied_1h/24h` shares carry them meanwhile.
- No salon–online customer join and no combined money metric (Ezra's cut, unchanged).

### What the merge must know

- **Outside packages/data:** nothing this slice (contracts, worker, profiles, door and setup script
  unchanged; `scripts/zetaris-setup.ts` proves the new metrics because its proof is generic).
- New files: `packages/data/src/operations.ts` (new sources' rules and metrics), `packages/data/src/sql.ts`
  (shared `Row`, `Field`, `Cond`, `SourceSpec`, `quoted`, …; `finance-sql.ts` re-exports `quoted` and
  `Row`). `aggregate(d, rows, version)` now takes the version; `AS_OF` and `LAST_WEEK` live in
  `synthetic.ts` (`layers.ts` re-exports `AS_OF`). `SyntheticYear.salon.appointments` is `SalonVisit[]`.
- A metric's `business` can now be `combined` (one count). Anything that groups the catalog by business
  must expect it (the worker's read tools filter by `salon`/`online`, so it shows only to Finance and Owner
  through `get_finance_metrics`).
- Zetaris: version 2 was dropped and rebuilt in place (all `fortune_hq_v2.*`, the four `fortune_demo_v2_*`
  marts, the `*_v2` and new REST tables); new database `FORTUNE_DEMO_SUPPORT`. Version 1 untouched. Reads
  are slower with twelve sources (division read 4.5–7.4 s, unsliced 23 s): prefer `getDivisionMetrics`.
- Env: unchanged. No migration.

## Slice 4 of 4: tools and profiles (2026-10-27, 09:21–09:55 ET)

### What works (with the tests that prove it)

- **Row reads on the data port** (`packages/data/src/rows.ts`, `DataPort.readRows`, `RowRead`/`RowsData` in
  `@fahq/contracts`): four fixed questions (repairs open / late / done in 30 days; unpaid invoices open /
  overdue / due in 30 days, one business or both; waiting customer messages older than N hours; low stock on
  the data date). One statement each over the source's existing row view, with the source's data-quality
  rule and the standing metric's own condition; columns by position from a fixed list; "older than" and the
  row limit applied after the read; totals added by the port (money per business, never across). No new
  Zetaris object. `rows.test.ts`: "count exactly what the standing and month-so-far numbers count", "keep
  money per business…", "never return a planted bad row, a customer, a message text or a name", "build their
  SQL only from fixed conditions…", "refuse anything off the fixed lists…", and the port tests ("returns the
  rows and totals of each read…", "applies 'older than' to the rows it read…", "refuses a read too large…",
  "is not offered by a version 1 port").
- **Series** (`DataPort.getMetricSeries`, `seriesQuery`/`seriesHashText`/`seriesOf` in `divisions.ts`): one
  period or derived id over every period from the division's own mart, oldest first, with min, max and
  mean12 (the season index's denominator); refuses an id outside the division, a standing id, an unknown
  division, a repeated or unknown period. `rows.test.ts` "DataPort metric series" (4 tests, including "the
  yearly mean is the season index's denominator").
- **Proved live, `--v2 --verify-only` 09:41–09:46 ET:** every earlier comparison matched again, plus 9 row
  reads (0.3–0.4 s each; e.g. 16 open repairs, 2 late, 4 overdue invoices, 4 waiting messages, 2 over a day,
  21 low-stock products, 5 wanted, 4 wanted and out) and 5 series (2.4–2.9 s each) all equal to the oracle;
  "version 1: mart … listed exactly as before"; "version 2 verified".
- **Read tools** (`apps/worker/src/read-tools.ts`): `get_budget_room`, `get_metric_series`,
  `get_company_overview`, `get_data_quality`, `get_repair_tickets`, `get_supplier_invoices`,
  `get_waiting_conversations`, `get_low_stock_interest`; the three metric tools read their division's mart
  when the port has `getDivisionMetrics` (metrics carry their period, plus the attention list) and list
  exactly the ids they return. `read-tools.test.ts` "division read tools (data version 2)" (6 tests) and
  "writes every signature as valid TypeScript…".
- **Who gets what** (`packages/profiles` SHAPES, READ_TOOL_NAMES, each skill's "You can read"): design 3.7
  without the customer join. `profiles.test.ts` "gives each division its own rows and the company view to HQ
  only (design 3.7)"; every skill still within 48 lines (owner 44).
- **Plan slices by division** (`departments.ts` `sliceFor(department, metrics, catalog)`, planUse false left
  out; `writePlans` passes the port's catalog; a round passes its port). `rounds.test.ts` "gives each
  department its division's metrics when the data names divisions…", `units.test.ts` "for a department,
  plans from its division's metrics when the port's catalog names divisions, even from a round's source".
- **Door** (`brain-mcp.ts`): DOOR_READS adds `get_salon_metrics` and every new tool. `doors.test.ts` "gives
  the salon door salon numbers only", "serves the division data from a version 2 port…".
- **Validator**: 4e (`numbersIn` "reads the digits of an id after a letter and a hyphen…", seen failing
  first; `checkPlans` "lets an action name a row by its id…"); 4d (`validate.test.ts` "checkPlans and small
  counts next to what a cited count counts", 2 tests; `units.test.ts` "holds a plan's small counts to what
  the catalog says…"). PLAN_SYSTEM rules 1, 2 and 4 carry 4g (standing, seasonal budget, small counts); the
  plan writer now sees each metric's period.

Test counts: `npm run typecheck` green; `packages/data` 109 tests in 12 files green (rows.test.ts 13); full `npm test`
(09:47 ET): 631 passed, 3 failed: the two `supabase/tests/db.test.ts` RLS tests that fail on bb29578's own
code (slice 1's tier 0), and one `chain.test.ts` test. `chain.test.ts` + `departments.test.ts` passed 35 of
35 at 09:49:34 ET on this code, then failed 5 to 21 of 35 on three reruns within two minutes while other lanes
ran real-database tests on the shared local stack (four of their vitest processes were running), so those
failures come from the shared database, not this branch.

### Not done

- No independent second-key review of this slice (no reviewer was available to this lane); the merge
  should get one.
- `main.ts` still defaults `FINANCE_PERIOD` to `2026-09` (design 4g: `2026-10-mtd`, so budget room and the
  last-year index mean "this month"); not this lane's file.
- Rounds still read `getFinanceMetrics` once, unsliced (about 23 s live under version 2), and slice by
  catalog; per-division mart reads in `rounds.ts` and `explain.ts` (design 4h, option 1) are not built.
- Durations (4c: `days`/`minutes` units) and the synthetic-join guard (4f) are not built; no metric has
  `planUse: false` yet.
- Twin of 4e not fixed (not this lane's file): `packages/codemode/src/answer.ts` `FIGURE` reads
  "SUP-2201" as 2201. Every row id this lane serves has a letter right before its digits, so answers that
  name them are unaffected.

### What the merge must know

- **Outside this lane's files (unavoidable, minimal):** `packages/contracts/src/ports.ts` (`RowRead`,
  `RowsData`, `MetricSeries`, `DataPort.readRows?`, `DataPort.getMetricSeries?`, `MetricInfo.about/nouns/
  planUse`); `packages/contracts/src/index.ts` (exports `CountNouns`); `apps/worker/src/finance.ts` beyond
  PLAN_SYSTEM: `sliceFor(…, deps.data?.catalog)`, `checkPlans(…, countNouns(deps.data?.catalog))`, `period`
  in the metrics sent to the plan writer, one doc comment; `apps/worker/src/rounds.ts` (passes `data` to
  `writePlans`, one field); `packages/codemode/src/brain-mcp.ts` beyond DOOR_READS (handlers for the new
  door reads; the metric tools read divisions); tests updated for the new tool lists and Finance's line:
  `apps/worker/test/departments.test.ts`, `chain.test.ts`, `units.test.ts`, `rounds.test.ts`,
  `packages/codemode/test/doors.test.ts`, `packages/data/test/zetaris.test.ts`.
- **Behaviour change under version 1 too:** the catalog has carried `divisions` since slice 1, so plan
  rounds now slice by division on the live default: Finance plans from 28 of 33 metrics (no longer email
  sends, email click rate, salon no-shows and the two rejected-rows counts); Salon 11 and Online 22 as
  before. Under version 2: Finance 79, Salon 29, Online 58 (of 110).
- **Stricter plan check:** with the port's catalog, a plan writing "5 late repairs" when the cited count is
  3 is rejected (one correction round, then the department fails plainly). The round's final check passes
  no nouns.
- Skills: owner's SKILL.md is at 44 of 48 lines; another lane adding lines there must keep `profiles.test.ts`
  green. Only the "You can read" lists changed.
- Zetaris: nothing created or changed (the row reads use the existing `fortune_hq_v2` row views). Env:
  unchanged. No migration.
