# Lane D2 (wave 2 data): notes

Branch `hq/w2-data`, worktree `~/fahq-w2-data`, cut from `hq/divisions-merge` at `16449bf`. Spec: `docs/wave2.md`,
"New synthetic sources and metrics". The design of record for the data is `docs/data.md`; this file says what each
slice did, what is not done, and what the merge must know.

## Slice 1 of 3: the finance sources (items 1 to 3), 2026-10-27 11:07 ET onward

### What works (each with its tests)

- **Marketplaces** (`fortune_demo_marketplace.{sales,ads,stock}`, new database `FORTUNE_DEMO_MARKETPLACE`): Amazon and
  Walmart sales, orders and fees; Walmart's ads (the Google family's four numbers); each warehouse's stock with the
  standing out-of-stock and low-cover counts and the inbound units. `channels.test.ts`: "the marketplaces" (four tests:
  totals from the rows, the store's revenue unmoved; 28-day units equal the sales; out, low (never both) and inbound
  on the data date, and the attention that fires; Walmart's ads, the all-channel spend unmoved).
- **Email split** (`fortune_demo_marketing.email_messages`): flow and campaign sends and revenue, campaigns sent,
  unsubscribe rate. `channels.test.ts`, "the email split adds up to the email rows exactly": per email row, and per
  period flow + campaign sends = `m:online.email.sends` and their revenue = `m:online.email.revenue`, to the cent.
- **Order lines** (`fortune_demo_online.order_lines`): `m:online.products.cogs`, `m:online.products.negative_margin.count`.
  `channels.test.ts`, "the order lines add up to the orders exactly": per order (revenue, cost, refunds, units, its own
  line, distinct products), per period (cogs = the orders' cost, lines' revenue = online revenue), and the losing
  products counted product by product.
- **Rules and planted rows**: "the channels: data-quality rules" (one planted row per source, rejected in its own
  month only; SQL says what TypeScript says; each source read once by the period view; every metric in every period).
- **Nothing else moved**: "every number the base served keeps its value" pins the 1,224 values of `16449bf`, computed
  by running that commit's own code (`git archive 16449bf packages/data/src`). Version 1 stays frozen (`frozen-v1.test.ts`).
- **The asks** (who must not read what): "the asks of docs/wave2.md" (three tests) in `channels.test.ts`.
- **Row reads** `marketplace_stock` and `products` (`RowRead` in `packages/contracts/src/ports.ts`, `rows.ts`):
  `rows.test.ts` "count the marketplace warehouses' stock as the standing numbers do…", "add each product's money up to
  the period's numbers, best or worst first", the refusals in "refuse anything off the fixed lists…", and the port test
  "returns the rows and totals of each read…" (both new reads among `READS`).
- **Read tools** `get_marketplace_stock` (owner, finance) and `get_product_performance` (owner, online), worker
  (`read-tools.ts`) and door (`brain-mcp.ts`, `DOOR_READS` and their words): `read-tools.test.ts` "reads the rows behind
  the standing numbers as fixed reads…", "refuses a status, business or hours off the fixed lists…"; `doors.test.ts`
  "offers each profile only the tools it may read", "passes each row read on as asked…"; `profiles.test.ts` "gives each
  assistant exactly its reads and writes", "gives each division its own rows…" (the two new readers lines).
- **Live proof**: see "Proof" below.

### Not done in this slice

- The products read has no average rating yet: the reviews source is item 4 (slice 2).
- `apps/worker/test/departments.test.ts` (its two tool lists updated like the profile tests) is skipped in this
  worktree: Meterless engines are not under `.local/meterless` here. Run it where they are.
- Items 4 to 8 (returns and reviews, inbox extras, site and journey, salon clients, personalization) and their
  attention rules: slices 2 and 3.

### What the merge must know

- **Files outside the lane's list, changed minimally:**
  - `packages/profiles/test/profiles.test.ts`, `packages/codemode/test/doors.test.ts`, `apps/worker/test/read-tools.test.ts`,
    `apps/worker/test/departments.test.ts`: the hard-coded tool lists gain the two new reads.
  - `packages/codemode/test/doors-db.test.ts`, the two `serve.ts` cases: they compared the door started from the
    STORED profile (shared database) with the FILE profile's reads, so any new read failed them until the profiles
    were reseeded. They now compare with the stored profile's reads (`storedDoorTools`), which is what the door serves.
    The shared database's stored profiles were **not** reseeded by this lane (other lanes test against them).
- **Skill line budget:** finance stays at its 48 body lines (the new `get_marketplace_stock` line in, `latest_proposal`
  and `explain_proposal` merged into one line). Online goes from 47 to 48 lines (the limit). A lane that adds a line
  to either must take one out. Owner goes to 46.
- **Profiles to reseed at the merge** (`npx tsx scripts/seed-profiles.ts --force --db <local>`): owner, finance and online
  read the new tools.
- `m:online.email.sends` has new noun phrases ("total emails", "marketing emails") so the plan checker can tell it from
  the flow and campaign sends; its value is unchanged.
- No contract or migration change. `RowRead` gains two variants (the lane's own part of `ports.ts`). `validate.ts` is
  unchanged (no new unit in this slice).
- The Zetaris period view body changed (`frozen-v1.test.ts` pins the body last built live; see Proof). The shared
  local Zetaris now holds this branch's version 2 objects; a worker on `FAHQ_DATA_VERSION=2` from an older branch
  would read views with more metrics than its catalog knows and refuse them ("a metric this adapter does not know").
  Version 1's objects were not touched.

### Proof

- `npm run typecheck` clean.
- `npx vitest run packages/data packages/contracts`: 19 files, 256 tests, all passed. `apps/worker/test/read-tools.test.ts`,
  `packages/profiles`, `packages/codemode/test/doors.test.ts`: 8 files, 208 tests, all passed. Under the lock,
  `packages/codemode/test/doors-db.test.ts`: 18 of 18 (before its fix, 2 failed: the serve.ts cases, seen failing).
- Seen failing first: the row-read, read-tool, door and profile tests (typecheck errors and "no such row table"
  before the code); the channel tests were written beside the code and bitten by mutating the email split's remainder
  and the losing-products count (the file then fails to load); the base-values hash was computed from `16449bf`'s own code.
- Full `flock ~/.fahq-db-test.lock npm test` (11:27 ET, before the pin and the doors-db fix): 1,061 passed, 3 failed
  (the period-view pin, then fixed by the live rebuild; the two serve.ts door cases, then fixed), 173 skipped (9 files
  that need Meterless engines: their own skip, since `.local/meterless/engines` is absent from this worktree).
- Full `flock ~/.fahq-db-test.lock npm test` again at 11:59 ET on the committed code: 57 files passed, 9 skipped
  (Meterless); 1,064 tests passed, 173 skipped, 0 failed.
- Live, `npx tsx scripts/zetaris-setup.ts --v2` after a stopped `--v2 --recreate`, 11:24–11:58 ET: 145 comparisons, all
  matched; 13 row reads and 7 series equal to the oracle; version 1's mart listed exactly as before; "version 2
  verified" (details in `docs/data.md`, "Live run").
- Not done: a second-key review (the merge's), and `departments.test.ts` here (skipped without Meterless).

## Slice 2 of 3: the online sources (items 4 to 6), 2026-10-27 12:00 ET onward

All three items were built (4 and 5 first, then 6) and proved live in one rebuild.

### What works (each with its tests)

- **Customers on the store's rows** (item 4): version 2 orders, refunds and support messages carry `customer_id`
  (`demo-cu-c…`, `demo-cu-r…` for six invented serial returners, `demo-cu-p…` for people who only wrote), from the
  streams `customers` and `message_people`, which only read the rows. `customers.test.ts` "names a synthetic customer
  on every order, refund and message, and never moves a row"; the base-values hash in `channels.test.ts` ("the
  channels, the customers and the site add numbers of their own and move none of the others") still holds the 1,224
  values of `16449bf`.
- **Reviews** (`fortune_demo_online.reviews`) and **repeat returners**: `customers.test.ts` "reject exactly the one
  planted row of the reviews…", "count, rate low and average each period from its own reviews", "counts the customers
  refunded twice or more in the 365 days to the data date, and the rule fires" (7 on the synthetic year).
- **Inbox extras** (item 5): `answered_by` (`customers.test.ts` "says who answered exactly the messages that were
  answered…"), Emma's share within the hour and median minutes ("Emma's share answered within the hour and her median
  minutes…"), planted duplicates and answered-twice ("counts each period the messages sent again on another channel…":
  104 duplicates and 81 answered twice over the year, counted by brute force against the oracle's LAG window), the
  window in SQL ("reads the inbox once in the period view, through the window…").
- **Row read `return_cases`** (`rows.test.ts` "list each refund of the period with its customer's year, reviews and
  messages, adding up to the refund numbers"; the port test "returns the rows and totals of each read…"; the privacy
  test now allows a customer only there, only as `customerId` = `demo-cu-…`). **`products` gains the rating**
  (`avgRating`, `reviews`; "add each product's money up to the period's numbers…").
- **The store site** (item 6, `web.test.ts`): page days whose orders add up to the order count per day and per period
  ("share out each day's store orders exactly…"), sessions, cart and conversion rates, average LCP, slow pages per page
  ("total the visits, carts and orders of each period, and count the pages that drew slowly on average"), the weekly
  crawl's broken links and the blog ("count the broken links of the latest crawl…", "count the posts published each
  period, and the posts not updated in half a year"), planted rows and one read per source. **Row read `journey`**
  (`rows.test.ts` "give the store journey of a period by source, adding up to the site numbers, most visits first").
- **Attention**: repeat returners, duplicated messages, low ratings, slow pages, stale posts (watch), broken links
  (act); `divisions.test.ts` "fires on the day-to-day systems…" (Online's `2026-10-mtd` list, the planted rows' months).
- **Read tools** `get_return_cases` and `get_store_journey` (owner, online), worker and door: `read-tools.test.ts`
  "reads the rows behind the standing numbers as fixed reads…", "refuses a status, business or hours off the fixed
  lists…"; `doors.test.ts` "offers each profile only the tools it may read", "passes each row read on as asked…";
  `profiles.test.ts` "gives each assistant exactly its reads and writes", "gives each division its own rows…".
- **Seen failing first**: the existing tests failed on the new sources before they were updated (counts, the pin, the
  attention list, the tool lists); the new tests were bitten by mutation (13 mutations, 12 caught at once: duplicates
  ignoring the first answer, the lower median, repeat needing three, no planted duplicates, auto replies on texts,
  refunds in the year off by one, ratings counting the planted review, the refund rule without the customer, slow pages
  by total, a day's orders one short, the journey's cart rate from orders, no broken links; "broken without server
  errors" survived, so the rule itself is now pinned: 404, 500 and 503 broken, 301, 200 and 410 not).

### Not done in this slice

- `apps/worker/test/departments.test.ts` (its online tool list updated) is still skipped here: no Meterless engines.
- Items 7 and 8 (salon clients and product sales, personalization) and their attention rule: slice 3.
- `RowRead` gains `return_cases` and `journey`; the W1 worker registry (`apps/worker/src/workers.ts`) is W1's: its
  `online.returns_reviews` and `online.journey` rows may now name these reads.

### What the merge must know

- **Files outside the lane's list, changed minimally:** `packages/data/test/*` are the lane's; outside it, the same
  hard-coded tool lists as slice 1 (`packages/profiles/test/profiles.test.ts`, `packages/codemode/test/doors.test.ts`,
  `apps/worker/test/read-tools.test.ts`, `apps/worker/test/departments.test.ts`) gain the two new reads. No contract
  or migration change: `RowRead` (the lane's part of `ports.ts`) gains two variants; `Metric.unit` already had
  `minutes`, `seconds` and `score`, and the data package's own `MetricAbout.unit` now allows them (every such metric
  has `planUse: false`); `validate.ts` is unchanged (it treats those units as counts in the number pool).
- **Skill line budget:** Online stays at 48 body lines (`get_waiting_conversations` and `get_low_stock_interest` share
  a line, so do `recall_my_decisions` and `my_lessons`). Owner's wave 2 reads share one line (46 lines). Finance is
  unchanged at 48.
- **Profiles to reseed at the merge** (`npx tsx scripts/seed-profiles.ts --force --db <local>`): owner and online read
  the two new tools. The shared database's stored profiles were not reseeded by this lane.
- **The shared local Zetaris** now holds this branch's version 2 objects (the period view pin in `frozen-v1.test.ts`
  is `8e8feb1f…`). The orders, refunds and messages REST tables and row views were dropped and recreated with their
  new columns; the new database `FORTUNE_DEMO_WEB` holds the site's three tables. Version 1's objects were not touched.
  A worker on `FAHQ_DATA_VERSION=2` from an older branch reads views with metrics its catalog does not know.
- **Performance:** a version 2 source server now generates the year in about a second (the site's 14,077 page days
  are the largest route, 2.7 MB of JSON). `sourceRows` works out the inbox's previous-message window once per
  messages array (a `WeakMap`), because a row-read test that calls the oracle 501 times timed out without it.
- The privacy rule changed on purpose: `return_cases` returns a synthetic customer id (docs/wave2.md, item 4); every
  other read still returns none (the test pins both).
- **Names that differ from docs/wave2.md:** the return cases' products are `skus` (an order of several accessories has
  several, comma-joined); the crawl's status column is `http_status` (a numeric `status` would collide with the
  enumerated `status` columns the no-medical guard checks by name). `refunds` also gained `customer_id` (the spec names
  it on orders only): the repeat returners are counted per customer in the refunds' one read.
- **BLOCKER for version 2 reads (must read before W1/W2 rely on them):** one period of the period view took 2 to
  3.5 minutes live (slice 1: about 12 s), a series through a mart about 4.5 minutes, and the online division read
  (`getDivisionMetrics`, three statements, one of them the derived table over the whole period view) failed with
  "Cannot reach Zetaris" after about five minutes. Row reads stay quick. Suspects, not yet measured per source: the
  page days (14,077 rows, 2.7 MB fetched on every read) and the inbox's window; the machine was also loaded. A fix that
  keeps every test: fewer page-day rows (for example weekly rows, or one source group per page and day), then the
  period, layer and filter views and the marts rebuilt and proved again. Version 1 (what the live worker reads) is
  untouched and as fast as before.
- **Zetaris drops the connection on a long `ADD DATAMART TABLE`** (about five minutes, the derived tables): the table
  is still created; re-list with `SHOW DATAMART TABLES` before retrying (the setup script's `ensureMartsV2` stops on
  the dropped connection; rerunning it carries on).

### Proof

- `npm run typecheck` clean at every commit. `npx vitest run packages/data packages/contracts apps/worker/test/read-tools.test.ts
  packages/profiles packages/codemode/test/doors.test.ts`: 29 files, 482 tests, all passed (12:33 ET, before the return
  cases fix); `npx vitest run packages/data` again after it: 15 files, 146 tests, all passed (13:51 ET).
- Live, 12:19–14:08 ET: see `docs/data.md`, "Live run, 2026-10-27 12:19–14:08 ET": the period view 121 of 121 in four
  periods, the standing view 23 of 23, the six row reads and two series (duplicates, slow pages) equal to the oracle
  after the return-cases fix. **Failed:** the online division read (dropped connection after five minutes). Not run in
  the time box: the other nine periods, the derived view, the full `zetaris-setup.ts` comparison.
- Not run: the full `flock ~/.fahq-db-test.lock npm test` (it would have competed with the live proof for the machine
  and the source port 18121); run it at the merge.
