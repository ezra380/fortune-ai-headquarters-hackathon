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
| `layer` | `period` (a total over the period's rows), `derived` (from other metrics of the period), `standing` (as of the data date). Every metric is `period` so far |
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

Not built yet (later slices): the season index (`m:*.season.*`), the derived layer (budget room and used,
MER, contribution), the standing layer, and every source beyond the budget sheet and Meta.

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
| Period view | `fortune_hq.finance_metrics` | `fortune_hq_v2.period_metrics` |
| Mart | `fortune_demo_finance_mart.finance_metrics` | none yet (the division marts come with the divisions slice) |

`npx tsx scripts/zetaris-setup.ts --v2` creates only version 2's objects (whatever is missing), starts a
source server on 18121, and proves every period against `computeAll`. `--v2 --recreate` drops and rebuilds
version 2's views and tables only. **Live run, 2026-10-27 07:58 ET:** created, then 41 of 41 metrics matched
in each of the 13 periods, about 3.3 s per period.

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
