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
| Appointments' new columns: `location`, `booked_via`, `labor_cost_usd` | on every one of the 2,902 rows, plus 1 | `generateYear()` (`salonVisits`, its own stream): version 1's columns and values unchanged (a test projects every row onto them); no labor cost for a no-show; planted `demo-a-bad-location` (April, a location the salon does not have) |

The day-to-day systems (`generateOperations(orders)`, each its own stream; the year's orders are only read,
for real order ids). Every source has rows in all 13 periods and exactly one planted bad row.

| Source (Zetaris table) | Mirrors | Rows | Planted bad row |
|---|---|---|---|
| Order fees and shipping (`fortune_demo_online.order_costs`) | the payments export and the label account | 1,300: one per sale, and the bad row | `demo-oc-bad-negative` (May): a voided label exported as a negative cost |
| Refunds (`fortune_demo_online.refunds`) | refunds issued by hand in the store | 78: about one sale in seventeen, 4–24 days after it, never above what was paid | `demo-rf-bad-zero` (June): a zero refund |
| Checkouts (`fortune_demo_online.checkouts`) | abandoned checkouts and the recovery email or text | 1,749: about five a day; recovered ones name a real order of the same line within three days | `demo-ck-bad-recovery` (February): "recovered" by email but names no order |
| Inventory (`fortune_demo_online.inventory`) | stock on hand plus the week's product views and carts | 781: 60 products on each period's last day (the month so far: Oct 26) | `demo-iv-bad-negative` (April): negative stock |
| Support inbox (`fortune_demo_support.messages`, its own database) | support@ email, the shop's two texting numbers, site chat | 4,814: about twelve customer messages a day plus the shop's follow-ups; **no body, subject or text column** | `demo-msg-bad-reply` (August): answered before it arrived |
| Repair tickets (`fortune_demo_salon.repair_tickets`) | the ops app's repair tickets | 321: about one a working day (salon closed Saturdays); online repairs go through Brooklyn and ship back | `demo-rt-bad-dates` (July): finished before it arrived |
| Supplier invoices (`fortune_demo_finance.invoices`) | the factories' invoices (accounts payable), each to one business, never split | 141: each factory invoices each business once or twice a month | `demo-inv-bad-due` (January): falls due before it was issued |

Nothing happens after the data date: a reply, payment, repair step or refund that would fall later has not
happened yet (it is empty), and the support inbox's last moment is Oct 26, 23:59.

- `SEASON` (exported) is the invented seasonality by calendar month, relative to Sept and Oct = 1 (version
  1's rows were drawn at the base rate). It drives history volumes, Meta spend and budget caps.
- Each new source draws from its own seeded stream (FNV-1a of its name), so adding a source later never
  shifts another's rows.
- New ids put a letter right before their digits (`demo-o-h00001`, `demo-ad-m00001`,
  `demo-bu-google202610`, `demo-rt-r00012`, `demo-sku-m04`), so the plan checker's number scan never reads an
  id as an amount.
- **No medical or hair-loss data anywhere** (`no-medical.test.ts`): no column or string value of any source
  (version 1 and 2, bad rows included), no allowed value of any enumerated column (`SOURCE_ENUMS`, which the
  test also proves complete), no metric id, label or note and no view body matches
  `medical|hair.?loss|alopecia|chemo|diagnos|fj_interest|topper_interest`. Message intents are order status,
  repair, consignment, product question, purchase, return and other. Interest counts are product views of the
  store's own four lines only.

## Metrics

`MetricDef` (`packages/data/src/finance-sql.ts`) now carries:

| Field | Meaning |
|---|---|
| `business` | the legal split (salon or online); unchanged, and the validator keeps using it. `combined` only for a count that belongs to neither (`m:combined.dq.rejected_invoices`: rows of a source both businesses share), never for money |
| `test` | a row condition beyond equality (a comparison, NULL, a list), in SQL and in TypeScript, the TypeScript side following SQL's NULL rules |
| `divisions` | who reads it (salon, finance, online, hq); the catalog passes it on as `MetricInfo.divisions` |
| `layer` | `period` (a total over the period's rows), `derived` (from other metrics: `layers.ts`), `standing` (as of the data date, period key `standing`) |
| `about` | thresholds and caveats, kept out of the label so a plan never echoes them |
| `nouns` | for a count, the phrases that name what it counts ("late repairs", "repairs"), for the plan checker's small-count rule |
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

Slice 3 adds 40 more period metrics (81 per period, every period): 6 from the appointments' new columns and
34 from the day-to-day systems (`packages/data/src/operations.ts`). Labels carry no number; thresholds are in
`about`. A source's rejected-rows count goes to every division that reads the source, and to HQ.

| Metrics | Unit | Rule (valid rows, dated in the period) | Divisions |
|---|---|---|---|
| `m:salon.no_show_rate` | ratio | no-shows / booked visits (completed + no-show) | salon, hq |
| `m:salon.revenue.{brooklyn,lakewood}` | usd | completed visits by location | salon, finance |
| `m:salon.booked_online.share` | ratio | completed visits booked through the online store | salon |
| `m:salon.labor_cost`, `m:salon.gross_profit` | usd | stylist labor; price less labor (completed) | salon, finance (+ hq for profit) |
| `m:online.fees.payment`, `m:online.shipping.cost` | usd | sums of the order cost rows, by order date | online, finance |
| `m:online.refunds.total` / `.count` | usd / count | refunds by the day issued | online, finance |
| `m:online.checkouts.abandoned.{count,value}`, `.recovered.{count,value}`, `.recovery_rate` | count / usd / ratio | checkouts by the day left; recovered = names an order | online (+ finance for recovered value) |
| `m:online.inventory.low_stock.count` | count | on hand ≤ reorder point, on the period's last day | online |
| `m:online.inventory.wanted_{low,out_of}_stock.count` | count | low (or none on hand) **and** at least 40 views in the week before | online, hq |
| `m:online.service.inbound.count` | count | customer messages (not the shop's follow-ups) by the day they came | online |
| `m:online.service.replied_{1h,24h}.share` | ratio | first answer within 60 / 1,440 minutes | online |
| `m:online.service.unanswered_48h.count`, `.texts_unanswered_48h.count` | count | no first answer within 2,880 minutes (texts: the two shop numbers) | online |
| `m:online.service.sale_intent.count` | count | messages whose topic is a purchase | online |
| `m:online.service.missed_sale_intent.count` | count | a purchase question with no answer within a day and no order after it | online, hq |
| `m:salon.repairs.received.count` | count | tickets by the day the piece arrived | salon |
| `m:salon.repairs.revenue`, `.cost`, `.margin` | usd / usd / ratio | fees paid; parts and labor on finished repairs; margin on finished, paid ones | salon, finance |
| `m:salon.repairs.within_14d.share` | ratio | finished within 14 days, of the tickets not cancelled | salon, hq |
| `m:salon.repairs.online_intake.share` | ratio | tickets from the online form | salon |
| `m:{salon,online}.ap.invoiced` | usd | supplier invoices by invoice date, each business on its own | finance |
| `m:online.dq.rejected_{order_costs,refunds}`, `m:online.dq.rejected_{checkouts,inventory,messages}`, `m:salon.dq.rejected_repairs`, `m:combined.dq.rejected_invoices` | count | rows the source's rule rejected | the source's readers, hq |

Reply minutes come from `DATEDIFF` on the dates plus the clock digits (`substr`), never from
`unix_timestamp`, so no session time zone can move a message across the hour or the day.

The data-quality rules (each with its planted row): order costs: fee and shipping ≥ 0, a `demo-o-` order
id; refunds: amount > 0, a known reason, a `demo-o-` order id; checkouts: value ≥ 0, a known line and
recovery channel, recovered exactly when it names an order; inventory: all counts ≥ 0, one of the store's
four lines; messages: known channel, direction and intent, the date matches the moment, never answered
before it came; repairs: money ≥ 0, known type, status, channel and location, never finished before it
came; invoices: amount > 0, due on or after issue, paid (if paid) on or after issue, salon or online, a
known factory. Version 2's appointments add: status completed or no-show, a known location and booking
channel, labor ≥ 0 (`specOf('appointments', 2)`; version 1's view keeps its own rule, frozen).

### The derived and standing layers (`packages/data/src/layers.ts`)

Each layer is its own Zetaris view and its own statement, never UNION'd with another (Spark rejects a
statement that reads one exploded view twice). `CATALOG_V2` (`divisions.ts`) holds all three layers: 81
period metrics, 14 derived, 15 standing.

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
| `m:online.refund_rate` | ratio | refunds issued / online revenue, same period | online, finance, hq |
| `m:online.contribution` | usd | gross profit − payment fees − shipping − refunds − ad spend on all three channels, same period (email, staff and rent are not in it) | finance, hq |

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
| `m:online.service.waiting_now.count` | count | customer messages of the last seven days with no answer by the end of the data date | online, hq |
| `m:online.service.waiting_over_24h.count` | count | the same, and came before Oct 26, 00:00 (waiting over a day) | online, hq |
| `m:salon.repairs.open.count` | count | tickets waiting for payment or in repair | salon, hq |
| `m:salon.repairs.open_over_14d.count` | count | the same, arrived more than 14 days before the data date (late) | salon, hq |
| `m:{salon,online}.ap.open` | usd | owed on unpaid supplier invoices, each business | finance |
| `m:{salon,online}.ap.due_30d` | usd | unpaid and due Oct 26 – Nov 25 | finance |
| `m:{salon,online}.ap.overdue` / `.overdue.count` | usd / count | unpaid and due before Oct 26 | finance, hq |

The inbox counts look at the last week because a never-answered message from last winter is not "waiting":
it is already in that month's `unanswered_48h` count.

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
- Ids per division (period / derived / standing), slice 3: salon 24 / 2 / 3; finance 54 / 14 / 11; online
  50 / 5 / 3; hq 19 / 14 / 11. A season pair gives one value per period, so a `2026-10-mtd` read returns
  salon 28, finance 77, online 57, hq 42 metrics. Salon never reads an online id and Online never a salon id
  (a test on every layer). Finance reads no inbox, stock or checkout count; Online reads nothing owed to the
  factories and not the contribution; a `combined` metric is a count, read by Finance and HQ only.

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
| `m:online.service.waiting_over_24h.count` | > 0 | act | Customer messages have waited more than a day for a first answer. |
| `m:online.service.missed_sale_intent.count` | > 0 | watch | Customers who asked to buy got no answer in time and did not order. |
| `m:online.inventory.wanted_out_of_stock.count` | > 0 | act | Products customers are looking at are out of stock. |
| `m:online.inventory.wanted_low_stock.count` | > 0 | watch | Products customers are looking at are low on stock. |
| `m:salon.repairs.open_over_14d.count` | > 0 | act | Repairs have been open longer than two weeks. |
| `m:{salon,online}.ap.overdue.count` | > 0 | act | Supplier invoices are past their due date and unpaid. |

On the synthetic year (2026-10-mtd): the salon sees its late repairs; Online sees the planted order row, the
wanted products low and out of stock, the missed buyers and the messages waiting over a day; Finance sees
the waiting budget change and both businesses' overdue invoices; HQ sees all of them.

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
  - `catalog` lists every layer, each entry with its `layer` (new optional `MetricInfo.layer`), and, when
    the metric has them, its `about`, its `nouns` (what a count counts) and `planUse`.
  - `readRows({ table, …, asOf })` (`packages/data/src/rows.ts`): the rows behind a standing number. A read
    is one of four fixed questions (`RowRead` in `@fahq/contracts`): `repairs` open / late / done in the
    last 30 days; `invoices` open / overdue / due in 30 days, one business or both; `waiting` customer
    messages of the last week with no first answer, older than N hours; `low_stock` on the data date. Its
    one statement reads the source's row view (`fortune_hq_v2.salon_repairs`, `finance_invoices`,
    `support_messages`, `online_inventory`) with the source's data-quality rule and the same fixed
    condition its standing metric counts with; columns are selected by position, from a fixed list (no
    customer, no message text, no name). "Older than N hours" and the row limit are applied after the
    read, so nothing a script passes reaches the SQL. The port adds the totals (count, money per business,
    counts by channel and topic, wanted and out-of-stock), so a Code Mode script never adds numbers
    itself. More than 500 matching rows is refused, never cut short. The hash covers the row view body and
    the statement.
  - `getMetricSeries({ division, metricId, asOf })`: one period or derived metric in every period, from the
    division's own mart table (`SELECT period, value … WHERE metric_id = '<the catalog's id>'`), oldest
    first, with `min`, `max` and `mean12` (the mean of the whole months present: the season index's
    denominator). An id the division does not read, or a standing one, is refused before Zetaris is asked.
- The oracle `oracleRows(year, read)` computes a row read in TypeScript; `rows.test.ts` checks that its
  totals equal the standing and month-so-far metrics computed from the metric definitions (open and late
  repairs, each business's open, overdue and due-soon invoices, waiting and waiting-over-a-day messages,
  low, wanted-low and wanted-out-of-stock products), and setup proves the SQL against it live.

Live timings (08:25 ET, five sources): a division read 1.5–3.1 s; the unsliced read about 9–10 s (its
derived view recomputes the whole period view); one mart table asked for every period at once about 30 s
for derived. **With twelve sources (09:20 ET, slice 3):** a division read 4.5–7.4 s; the unsliced read
about 23 s; the period view about 8 s a period; a derived mart table for every period at once about 77 s.
Every statement still scans every source (a metric filter cannot reach below the unpivot), so the division
reads are the ones the worker should use.

## The read tools and who gets them (design 3.7, without the customer join)

`apps/worker/src/read-tools.ts` (Code Mode inside the worker) and the MCP door
(`packages/codemode/src/brain-mcp.ts`, for outside AI tools) serve the same reads from the same port. The
three metric tools read their division's mart when the port has `getDivisionMetrics` (each metric then
carries its period, `standing` for as-of-now numbers, and the tool returns the attention list), and each
tool's description lists exactly the ids it returns. On a version 1 port they slice by business as before,
and the new tools refuse with a plain sentence.

| Tool | Returns | owner | finance | online | salon | manager |
|---|---|---|---|---|---|---|
| `get_finance_metrics` | the finance division's metrics | ✓ | ✓ | | | |
| `get_online_metrics` | the online division's metrics | | | ✓ | | |
| `get_salon_metrics` | the salon division's metrics | | | | ✓ | |
| `get_budget_room({period})` | per channel cap, spend, room, used; all ad spend; proposed changes; last-year index | ✓ | ✓ | | | |
| `get_metric_series({metricId})` | ≤13 points + min, max, mean12, from the caller's division | ✓ | ✓ | ✓ | ✓ | |
| `get_company_overview({period})` | HQ mart: salon, online and combined side by side, `normal`, attention | ✓ | | | | |
| `get_data_quality({period})` | every rejected-rows count, each under its business (never added up) | | | | | ✓ |
| `get_repair_tickets({status, limit})` | rows + count, fees, cost | ✓ | | | ✓ | |
| `get_supplier_invoices({status, business?, limit})` | rows + count and amount per business | ✓ | ✓ | | | |
| `get_waiting_conversations({olderThanHours?, limit})` | thread, channel, topic, hours waited + counts | ✓ | | ✓ | | |
| `get_low_stock_interest({limit})` | sku, line, on hand, reorder point, views + counts | | | ✓ | | |

The owner reads finance and HQ ids in a series; each department its own division's. The door adds
`get_salon_metrics` (the salon door had no numbers before) and every tool above that needs only the data
port. Plan rounds slice the read by the catalog's `divisions` (`sliceFor`, `departments.ts`): Finance plans
from the money of both businesses side by side, not from every metric; a metric with `planUse: false` is
never planned from.

A failed read (Zetaris down, an HTTP error, SQL text in the body) reaches a script or a door client only as
"Business data could not be read (ZETARIS_READ)."; the detail goes to the log (`worker.zetaris_read_failed`,
`fortune-brain.zetaris_read_failed`) with email addresses and phone numbers masked. The door's own plain
refusals ("it needs data version 2", "not one of the metrics your division reads") still read as before.
The worker refuses a `FINANCE_PERIOD` the data does not serve: it plans for `2026-09` and logs why.

## The plan checker (`packages/contracts/src/validate.ts`)

- **Ids are not amounts** (design 4e): bare digits that end a row id are part of the id: a synthetic row's
  (`demo-rt-01234`, `demo-s-3`) or a supplier number (`SUP-2201`). Anything with a `$`, a unit, a comma or a
  decimal point is still read, and so is any other word before the hyphen: "a sub-$5,000 test", "mid-30%",
  "ROAS-9.5x", "the top-100 buyers". A minus sign or a range still reads (`-$3,000`, `10-20%`).
- **Small counts** (design 4d): a whole number under 100 is a claim when the words after it (up to four, past
  "of the", up to a joining word such as "about" or "and") name what a cited count metric counts. Each count
  carries phrases in the catalog's `nouns` (`counted()` in `sql.ts`: "late repairs", "open repairs",
  "overdue online invoices", then the bare nouns). The most specific phrase that fits picks the metric, and
  the number must be THAT metric's value, one of its own projections or a count lever. A bare noun that two
  cited counts with different values share ("3 repairs" beside 3 late and 16 open) is refused, with a phrase
  of each to choose from. `catalog.test.ts` proves every count has a phrase that names it apart from every
  other count its division reads. `writePlans` passes the phrases from the port's catalog; without them small
  counts are not checked, as before. The final check of a round does not pass them (the departments' own
  checks already did).
- **Seasonal budgets** (design 4g): once a plan cites `m:online.season.last_year_index`, or a projection on an
  approved cap (`m:online.budget.<channel>.cap`) names the season, that projection's factor must be the
  index's value. A bare decimal in the text ("1.35") is a claim like any other number (a ratio may back it).
- `PLAN_SYSTEM` (rules 1, 2 and 4) says that a `standing` metric is as of the data date, that a seasonal
  budget is the projection cap × last-year index, and the small-count rule; the plan writer now sees each
  metric's period. Every one of these is checked by the code above.

## The oracle

`computeAll(rows, version)` returns `Map<Period, Map<metricId, value>>` for every period a version serves,
from the same rows Zetaris reads, applying the same data-quality rules and the same NULL behaviour as the
SQL. It replaces `computeFinanceMetricsLocally`. All periods at once, because a season index needs the year.

## Zetaris objects

| | Version 1 (live, untouched) | Version 2 (beside it) |
|---|---|---|
| Source port | 18120 | 18121 (`FAHQ_SOURCE_PORT_V2`) |
| REST tables | `fortune_demo_salon.appointments`, `fortune_demo_online.orders`, `fortune_demo_marketing.{ads,email}` | `…appointments_v2`, `…orders_v2`, `…ads_v2`, `…email_v2` in the same databases; `fortune_demo_finance.{budgets,invoices}` (database `FORTUNE_DEMO_FINANCE`); `fortune_demo_online.{order_costs,refunds,checkouts,inventory}`; `fortune_demo_salon.repair_tickets`; `fortune_demo_support.messages` (new database `FORTUNE_DEMO_SUPPORT`) |
| Row views | `fortune_hq.*` | `fortune_hq_v2.*` (`salon_appointments`, `online_orders`, `marketing_ads`, `marketing_email`, `finance_budgets`, `online_order_costs`, `online_refunds`, `online_checkouts`, `online_inventory`, `support_messages`, `salon_repairs`, `finance_invoices`) |
| Period view | `fortune_hq.finance_metrics` | `fortune_hq_v2.period_metrics`, twelve sources (its body's sha256 is pinned in `frozen-v1.test.ts` to the body last built live) |
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

**Slice 3, `--v2 --recreate`, 08:56–09:20 ET:** dropped and rebuilt every version 2 object with the seven
new sources (database `FORTUNE_DEMO_SUPPORT` created) and the appointments' new columns; 81 of 81 period
metrics matched in each of the 13 periods; derived 12 of 12 in every period; standing 15 of 15; every mart
table for every period; the DataPort's reads (unsliced 108 of 108; salon 28, finance 77, online 57, hq 42,
in `2026-10-mtd` and `2026-09`): **145 comparisons, all matched, 0 mismatches; version 1's mart listed
exactly as before; "version 2 verified".** Zetaris accepted the nullable columns (JSON `null`), the
boolean equality in the checkout rule, `substr`/`DATEDIFF` reply minutes and the date literals. Attention
that fired in `2026-10-mtd`: Salon, the late repairs; Online, the planted order row, wanted products low and
out of stock, missed buyers, messages waiting over a day; Finance, both businesses' overdue invoices and the
waiting budget change; HQ, all of these. An earlier run of the same session (08:44, without the appointment
columns) matched 27 of 27 period, derived and standing comparisons before it was stopped for the final one.

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
  online side by side. The one `combined` metric is a count of rejected invoice rows.
- Store sessions and landing pages come last, only if time remains.
- Not built: rejected-rows metrics for ads and email (their extra rules from the design), average repair
  turnaround in days and average first-reply minutes (the contract's metric units have no `days` or
  `minutes`; the share metrics carry turnaround and reply speed instead), email flow/campaign splits and
  unsubscribes, Meta campaigns and agents' late reports.
