# Lane notes: the division data (branch hq/div-data, worktree ~/fahq-div-data)

Cut from hq/foundation at bb29578. Design of record: the lane's `A-divisions.md`. What is built and how it
is proven: `docs/data.md`. Each slice appends below; nothing above is rewritten.

## Slice 1 of 4: foundation (2026-10-27, 07:37–08:20 ET)

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
