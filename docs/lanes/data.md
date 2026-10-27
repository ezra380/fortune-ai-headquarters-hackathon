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

## Slice 2 of 4: divisions in Zetaris (2026-10-27, 08:04–08:35 ET)

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
