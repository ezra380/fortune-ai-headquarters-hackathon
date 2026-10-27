# The division data (version 2, built beside version 1)

Every number here is synthetic. **Version 1** is what the live worker reads today: the view
`fortune_hq.finance_metrics` over four REST sources, 33 metrics, two periods. **Version 2** grows the data
for the four divisions (Salon, Finance, Online, HQ) beside it, in its own Zetaris objects, and is read
with `FAHQ_DATA_VERSION=2`. The default stays 1 until the merge, so the live worker never changes
underneath. The design of record is the lane's division design (`A-divisions.md`, written from bb29578).

## Version 1 is frozen

`packages/data/test/frozen-v1.test.ts` holds version 1 still, as of hq/foundation @ bb29578:

- today's rows, byte for byte (`generateBusiness()`, sha256 of its JSON);
- the live view's definition (`financeViewBody(1)`, sha256), so its query hash, a plan's provenance, does not move;
- all 33 metric values of `2026-09` and `2026-10-mtd`, computed by running the bb29578 code itself;
- and the same 33 values again from version 2's thirteen months of rows.

Version 1's Zetaris objects are never named by anything version 2 creates or drops
(`packages/data/test/zetaris-objects.test.ts`).

## Periods

Thirteen non-overlapping keys, `2025-10` … `2026-09` (twelve whole months) and `2026-10-mtd` (Oct 1–26).
`PERIOD_KEYS`, the zod enum `Period` and its type live in `@fahq/contracts`; `PERIODS` in
`packages/data/src/synthetic.ts` gives each its first and last day. A data port says which periods it serves
(`DataPort.periods`); the read tools and the MCP door offer exactly those, and a port that does not say
serves `DEFAULT_PERIODS` (`2026-09`, `2026-10-mtd`), which is version 1. So under version 1 every tool
signature a model sees is unchanged.

## Sources (version 2)

| Source | Rows | Where they come from |
|---|---|---|
| Orders, appointments, Google and Amazon ad days, email days | 1,301 / 2,902 / 2,737 / 1,228 (version 1's three bad rows included) | `generateHistory()` (Oct 1, 2025 to Aug 31, 2026; its own seed) then version 1's rows unchanged |
| Meta ad days | 1,173 (3 a day, all 13 periods) | `generateDivisions()`, its own named stream |
| Budget sheet (finance owner's monthly caps) | 41 | `generateDivisions()`, its own named stream: 13 months × google, meta, amazon approved; one proposed October Google raise that must never count; one planted bad row (`demo-bu-bad-negative`, March) |

- `SEASON` (exported) is the invented seasonality by calendar month, relative to Sept and Oct = 1 (version
  1's rows were drawn at the base rate). It drives history volumes, Meta spend and budget caps.
- Each new source draws from its own seeded stream (FNV-1a of its name), so adding a source later never
  shifts another's rows.
- New ids put a letter right before their digits (`demo-o-h00001`, `demo-ad-m00001`,
  `demo-bu-google202610`), so the plan checker's number scan never reads an id as an amount.
- No source has a medical or hair-loss field or value (`year.test.ts` scans every key and string).

## Metrics

`MetricDef` (`packages/data/src/finance-sql.ts`) now carries:

| Field | Meaning |
|---|---|
| `business` | the legal split (salon or online); unchanged, and the validator keeps using it |
| `divisions` | who reads it (salon, finance, online, hq); the catalog passes it on as `MetricInfo.divisions` |
| `layer` | `period` (a total over the period's rows), `derived` (from other metrics: `layers.ts`), `standing` (as of the data date, period key `standing`) |
| `about` | thresholds and caveats, kept out of the label so a plan never echoes them |
| `nouns` | for a count, the words that name what it counts (for the small-count check to come) |
| `planUse` | `false` keeps a metric out of plan writing until the validator can check its kind of number |
| `since` | `2`: served by version 2 only |

Divisions: each business's own division reads all of its metrics; Finance reads the money of both
businesses side by side (revenue, profit, ad spend and returns, budget caps, counts used in projections);
HQ reads the headline (online revenue and gross profit, salon revenue) and every rejected-rows count. A
salon metric never lists Online and an online metric never lists Salon (`catalog.test.ts`).

Version 2 adds 8 metrics to version 1's 33 (41 per period, every period):

- `m:online.ads.meta.{spend,revenue,roas,conversions}`: as Google's family, `channel = 'meta'`.
- `m:online.budget.{google,meta,amazon}.cap`: the approved monthly cap (`status = 'approved'`), also for
  the month so far. Finance only.
- `m:online.dq.rejected_budgets`: budget rows rejected by the data checks. The design named it
  `m:combined.dq.rejected_budgets`; the synthetic sheet lists only online ad channels, so it is online
  business here. If the sheet ever carries salon lines, it becomes combined.

### The derived and standing layers (`packages/data/src/layers.ts`)

Each layer is its own Zetaris view and its own statement, never UNION'd with another (Spark rejects a
statement that reads one exploded view twice). `CATALOG_V2` (`divisions.ts`) holds all three layers: 41
period metrics, 10 derived, 3 standing.

**Derived** (`fortune_hq_v2.derived_metrics`): the period view read once, pivoted to one row per period,
the formulas over it, then unpivoted.

| Metric | Unit | Formula | Divisions |
|---|---|---|---|
| `m:online.budget.{google,meta,amazon}.room` | usd | approved cap − spend, same period (below zero: overspent) | finance, hq |
| `m:online.budget.{google,meta,amazon}.used` | ratio | spend / approved cap | finance, hq |
| `m:online.ads.total.spend` | usd | Google + Meta + Amazon spend | online, finance, hq |
| `m:online.mer` | ratio | online revenue / ad spend, all channels | online, finance, hq |
| `m:{salon,online}.season.month_index` | ratio | the month's revenue / the average of the twelve whole months (2025-10 … 2026-09); none for `2026-10-mtd` | the business's own, finance, hq |
| `m:{salon,online}.season.last_year_index` | ratio | the month index twelve periods back; only `2026-10-mtd` has one (2025-10's) | the business's own, finance, hq |

The season index's average is `AVG(...) OVER ()` over all thirteen rows, so asking one period still
averages the year (the filter is not pushed below the window; proved live). The last-year index is
`LAG(…, 12) OVER (ORDER BY period)` in a select of its own, because a window cannot sit inside another.
Ratios divide by `NULLIF(…, 0)`; a missing input gives no row, as in the oracle.

**Standing** (`fortune_hq_v2.standing_metrics`), as of the data date `AS_OF = 2026-10-26`: one select per
source over all of its rows, period `'standing'`, no GROUP BY.

| Metric | Unit | Rule | Divisions |
|---|---|---|---|
| `m:online.revenue.last_7d` | usd | valid orders dated Oct 20–26, net | online, finance, hq |
| `m:salon.revenue.last_7d` | usd | valid completed appointments dated Oct 20–26 | salon, finance, hq |
| `m:online.budget.proposed.count` | count | valid budget lines with status `proposed` for this month or later (1: the October Google raise) | finance, hq |

Not built yet (later slices): every source beyond the budget sheet and Meta (repairs, invoices, messages,
inventory, …), their standing counts, contribution and refund rate.

## The divisions in Zetaris (`packages/data/src/divisions.ts`)

- **Filter views**, generated from the catalog's `divisions`: for each division and layer,
  `fortune_hq_v2.<division>_<layer>_metrics` = `SELECT period, metric_id, value FROM <layer view> WHERE
  metric_id IN (<that division's ids>)`. Twelve views; none computes anything. Every division reads at
  least one metric in every layer (a test), so no list is empty.
- **Four Virtual Data Marts** (no copy of the data), each with three tables `period_metrics`,
  `derived_metrics`, `standing_metrics` over its own filter views: `fortune_demo_v2_salon_mart`,
  `fortune_demo_v2_finance_mart`, `fortune_demo_v2_online_mart`, `fortune_demo_v2_hq_mart`. The names
  neither equal nor start with version 1's mart (`fortune_demo_finance_mart`). Mart table names are per
  mart (four `period_metrics` tables coexist; seen live).
- Ids per division (period / derived / standing): salon 11 / 2 / 1; finance 36 / 12 / 3; online 26 / 4 / 1;
  hq 6 / 12 / 3. A season pair gives one value per period, so a `2026-10-mtd` read returns salon 13,
  finance 49, online 30, hq 19 metrics. Salon never reads an online id and Online never a salon id (a test
  on every layer).

### The attention list

`ATTENTION` is a fixed list of rules. A rule looks at metrics by id, says when a value needs a look, its
level (`watch` or `act`) and a plain sentence with no number in it; `attentionFor(metrics)` returns
`{ metricId, level, rule }` for the rules that fire on the metrics a division already has. It never makes a
number: the number is the metric's own value.

| Metrics | Fires when | Level | Sentence |
|---|---|---|---|
| any `*.dq.rejected_*` | > 0 | watch | Some rows failed the data checks and were left out of the numbers. |
| `m:online.budget.*.used` | > 1 | act | Ad spend went over the approved budget. |
| `m:online.budget.*.used` | over 0.9, up to 1 | watch | Ad spend is close to the approved budget. |
| `m:online.budget.proposed.count` | > 0 | act | A proposed ad budget change is waiting for the finance owner's decision. |

## The DataPort

- **Version 1** (default): `getFinanceMetrics` is unchanged: one statement on `fortune_hq.finance_metrics`,
  its hash `sha256(view body + "\n--\n" + query)` exactly as at bb29578 (a test pins it). No
  `getDivisionMetrics`, so the worker falls back to slicing by business.
- **Version 2** (`FAHQ_DATA_VERSION=2`):
  - `getFinanceMetrics({ asOf, period })` reads the three layer views unsliced (period and derived for the
    period, standing as of the data date), three statements run together, one hash over the three view
    bodies and the three queries. It still serves every division's numbers, so today's callers (the
    rounds, the read tools, the door), which slice its result by business, lose nothing.
  - `getDivisionMetrics({ division, period, asOf })` reads only that division's mart: three statements,
    `view` = the mart, each metric's `source.view` = its mart table, standing metrics with period
    `standing`. The hash covers the three layer view bodies, the division's three filter view bodies, its
    three mart table statements and the three queries. A row outside the division's own ids, a metric
    twice, an unknown division or period, or no rows at all fail the read. `attention` is
    `attentionFor(metrics)`.
  - `catalog` lists every layer, each entry with its `layer` (new optional `MetricInfo.layer`).

Live timings (08:25 ET): a division read 1.5–3.1 s; the unsliced read about 9–10 s (its derived view
recomputes the whole period view); one mart table asked for every period at once about 30 s for derived.

## The oracle

`computeAll(rows, version)` returns `Map<Period, Map<metricId, value>>` for every period a version serves,
from the same rows Zetaris reads, applying the same data-quality rules and the same NULL behaviour as the
SQL. It replaces `computeFinanceMetricsLocally`. All periods at once, because a season index needs the year.

## Zetaris objects

| | Version 1 (live, untouched) | Version 2 (beside it) |
|---|---|---|
| Source port | 18120 | 18121 (`FAHQ_SOURCE_PORT_V2`) |
| REST tables | `fortune_demo_salon.appointments`, `fortune_demo_online.orders`, `fortune_demo_marketing.{ads,email}` | `…appointments_v2`, `…orders_v2`, `…ads_v2`, `…email_v2` in the same databases, and `fortune_demo_finance.budgets` (new database `FORTUNE_DEMO_FINANCE`) |
| Row views | `fortune_hq.*` | `fortune_hq_v2.*` (`salon_appointments`, `online_orders`, `marketing_ads`, `marketing_email`, `finance_budgets`) |
| Period view | `fortune_hq.finance_metrics` | `fortune_hq_v2.period_metrics` (unchanged since its live build; its body's sha256 is pinned in `frozen-v1.test.ts`) |
| Derived and standing views | none | `fortune_hq_v2.derived_metrics`, `fortune_hq_v2.standing_metrics` |
| Division filter views | none | `fortune_hq_v2.{salon,finance,online,hq}_{period,derived,standing}_metrics` (twelve) |
| Marts | `fortune_demo_finance_mart.finance_metrics` | `fortune_demo_v2_{salon,finance,online,hq}_mart.{period,derived,standing}_metrics` |

`npx tsx scripts/zetaris-setup.ts --v2` creates only version 2's objects (whatever is missing; a mart
table is added only when `SHOW DATAMART TABLES` does not list it, and a failed add stops the setup),
starts a source server on 18121, and proves: the period view for each of the 13 periods; the derived and
standing views and every one of the twelve mart tables for every period in one statement each; and the
DataPort's own reads (`getFinanceMetrics` and `getDivisionMetrics` for every division, `2026-10-mtd` and
`2026-09`), against the oracle's division slice, printing the attention that fired. It lists version 1's
mart before and after (metadata only: reading version 1's data would call the live worker's source
server) and fails if the listing changed. `--v2 --recreate` drops and rebuilds version 2's marts, views
and tables only.

**Live runs:** 2026-10-27 07:58 ET (slice 1): created, then 41 of 41 metrics matched in each of the 13
periods, about 3.3 s per period. **08:19–08:25 ET (slice 2):** created the derived and standing views, the
twelve filter views and the four marts with their twelve tables; 145 comparisons, all matched, 0
mismatches; version 1's mart listed exactly as before. Attention that fired: Finance and HQ, the waiting
budget change (act) in both periods; Amazon spend close to its budget in 2026-09 (watch); the planted bad
rows (watch) where each division sees them.

Version 1 was not re-proved live in this slice: its REST tables read port 18120, and starting a server there
could race the live worker. Its view text is byte-identical to bb29578 (frozen test), and no version 2
statement names a version 1 object.

## Slice 0: what the local Zetaris accepts (live test, 2026-10-27)

Script: `packages/data/scripts/zetaris-probe.ts` (`npx tsx packages/data/scripts/zetaris-probe.ts`). It
serves its own tiny invented source on a free port, creates only `fortune_demo_probe*` objects, checks
every answer against values computed from the same rows, and drops what it made. It never touches the
live source server (port 18120) or any version 1 object. Result of the run at 07:44 ET: every check
passed.

| Shape | Works | Notes |
|---|---|---|
| `AVG(...) OVER ()` on a REST view grouped by period | yes | 0.35 s warm |
| `LAG(idx, 12) OVER (ORDER BY period)` on top of that | yes | period keys sort correctly as strings |
| Window columns, then `stack()` unpivot, then `WHERE value IS NOT NULL` | yes | the exact shape of `sourceSelect()` |
| A view: windowed source `UNION ALL` a second source | yes | |
| That view asked for one period (`WHERE period = …`) | yes, values right | the filter is not pushed below the window, so the season index still averages all twelve months |
| A view that reads another view (`MAX(CASE …) GROUP BY period`, then `stack`) | yes | about 3 s: it re-runs the whole period view underneath |
| Two different REST views joined in one statement | yes | |
| `DATEDIFF`, `unix_timestamp` differences in minutes, `COUNT(DISTINCT …)` | yes | for the later repair and message metrics |
| A Virtual Data Mart with two tables (period view, and the view that reads it) | yes | `SHOW DATAMART TABLES` lists both; each answers alone and per period |
| `DROP DATAMART`, `DROP VIEW`, `DROP LIGHTNING DATABASE TABLE`, `DROP LIGHTNING DATABASE` | yes | |
| Dropping a schemastore container | **no SQL for it** | `DROP SCHEMASTORE CONTAINER` and `DROP CONTAINER` are parse errors; the empty container `fortune_demo_probe` stays |

Two things learned the hard way:

- **A Lightning database and a schemastore container share one namespace, case-insensitively.** After the
  first run left the container `fortune_demo_probe`, `CREATE LIGHTNING DATABASE FORTUNE_DEMO_PROBE`
  failed with "A container named FORTUNE_DEMO_PROBE already exists". Never give a database and a
  container the same name.
- Because window functions work, the season index can stay in Zetaris (computed from the grouped rows in
  the period view), not in TypeScript. The oracle computes the same number independently.

## Future work, by owner decision

- **No salon–online customer join yet** (Ezra, 2026-10-27). The "xjoin" database, the customer segments
  and the client profiles wait for a matching rule both owners agree. Until then no metric, view or tool
  links a salon client to an online customer.
- **No combined money metrics** (`m:combined.revenue.*`, `m:combined.gross_profit`): HQ shows salon and
  online side by side.
- Store sessions and landing pages come last, only if time remains.
