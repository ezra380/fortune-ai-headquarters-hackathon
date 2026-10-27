# Wave 2: named managers, daily workers, weekly reports (spec of record, 2026-10-27)

Ezra's request, 2026-10-27, in short:
- **George** runs Finance and reports to **Alan**.
- **Georgette** runs Online and reports to **Emma**.
- **Cindy** runs the Salon and reports to **Esther**.
- Each manager has recurring daily **workers**, one per segment of the division's work. Every week the manager writes a thorough **weekly report** built from the workers' reports.
- George's report ends with a **profit goal of the week** and **three suggested paths**.
- Managers ask each other for data in the other's field, through the mailbox, as the briefs already do.
- Each report is shown in the head's own view and in the owner's console. It is also printed on the head's printer and emailed.
- **Until real data is connected, every email goes to the owner's address only** (env `HQ_REPORT_TO`). Each email is labeled "For Alan" or "For Emma".
- Synthetic data only. No real names of customers, no message text, no medical or hair-loss data anywhere.

The contracts are fixed in `packages/contracts/src/reports.ts`, and the tables in
`supabase/migrations/20261027120000_division_reports.sql`. A lane that needs a change asks the orchestrator; it never edits them on its own.

## The workers

Each worker is identified by `WorkerId` (contracts). Its division is the part before the dot. Every worker reads only its own division's numbers, through the division's mart. Prefixes are matched against metric ids, and the registry lives in `apps/worker/src/workers.ts` (W1). A test proves that every prefix matches at least one metric its division reads. The new metric ids below are those the data lane adds in this wave.

| Worker | Manager | What it watches | Metric families (prefixes) | Row reads |
|---|---|---|---|---|
| `finance.email` | George | email flows and campaigns: sends, clicks, revenue, unsubscribes | `m:online.email.` | |
| `finance.google_ads` | George | Google Ads spend, return, budget room | `m:online.ads.google.`, `m:online.budget.google.` | budget room |
| `finance.meta` | George | Meta/social ads | `m:online.ads.meta.`, `m:online.budget.meta.` | budget room |
| `finance.amazon` | George | Amazon sales, fees, ads, FBA stock | `m:online.amazon.`, `m:online.ads.amazon.`, `m:online.budget.amazon.` | marketplace stock |
| `finance.walmart` | George | Walmart sales, fees, ads, WFS stock | `m:online.walmart.`, `m:online.ads.walmart.` | marketplace stock |
| `finance.online_money` | George | the online store's money: revenue, gross profit, fees, shipping, refunds, contribution, MER, supplier bills | `m:online.revenue`, `m:online.gross_profit`, `m:online.fees.`, `m:online.shipping.`, `m:online.refund`, `m:online.contribution`, `m:online.mer`, `m:online.ads.total.`, `m:online.ap.`, `m:online.season.` | invoices (online) |
| `finance.salon_money` | George | the salon's money, kept apart: revenue by location, labor, profit, repairs money, product sales, supplier bills | `m:salon.revenue`, `m:salon.gross_profit`, `m:salon.labor_cost`, `m:salon.repairs.revenue`, `m:salon.repairs.cost`, `m:salon.repairs.margin`, `m:salon.products.revenue`, `m:salon.ap.`, `m:salon.season.` | invoices (salon) |
| `online.messages` | Georgette | email, text and chat: reply speed (Emma's too), waiting, ignored, duplicated messages, missed buyers | `m:online.service.` | waiting conversations |
| `online.journey` | Georgette | the store journey: sessions by source, cart and conversion rates, abandoned and recovered checkouts | `m:online.web.sessions`, `m:online.web.conversion_rate`, `m:online.web.cart_rate`, `m:online.checkouts.` | store journey |
| `online.inventory` | Georgette | stock on hand against what customers look at, products that earn and lose | `m:online.inventory.`, `m:online.products.` | low stock interest, product performance |
| `online.returns_reviews` | Georgette | returns, the reasons, repeat returners, reviews | `m:online.refunds.`, `m:online.returns.`, `m:online.reviews.` | return cases |
| `online.site_content` | Georgette | site speed, broken links, the blog | `m:online.web.slow_pages`, `m:online.web.lcp`, `m:online.web.broken_links`, `m:online.blog.` | |
| `salon.clients` | Cindy | clients and their segments: frequent, sale-only, summer-only, Mazali buyers, standard; salon product sales | `m:salon.clients.`, `m:salon.products.` | clients |
| `salon.turnaround` | Cindy | repairs and personalization: how long each stage takes, what is late | `m:salon.repairs.`, `m:salon.personalization.` | repair tickets, personalization |
| `salon.appointments` | Cindy | visits by location, no-shows, online bookings, labor | `m:salon.revenue`, `m:salon.no_show`, `m:salon.booked_online`, `m:salon.labor_cost`, `m:salon.appointments` | |

The cross-division asks Ezra named are the reason some numbers are **not** in a division's own reads. The data lane must keep it that way, and a test checks it:
- **George asks Cindy** for client segments. The `m:salon.clients.*` metrics are read by salon and hq, never by finance. Salon product money (`m:salon.products.revenue`, `.mazali.revenue`) is read by finance too.
- **George asks Georgette** for product performance, cost against profit, returns and the reasons for them. `m:online.products.*` (apart from the money totals), `m:online.returns.*` and `m:online.reviews.*` are read by online and hq.
- **Georgette asks George** for Amazon and Walmart stock, to know when to send goods or restock. `m:online.amazon.stock.*`, `m:online.walmart.stock.*` and `m:online.marketplace.*` are read by finance and hq, never by online.
- **Georgette asks Cindy** how long repairs and personalization take at the salon. Online never reads `m:salon.*`.

## New synthetic sources and metrics (data lane, D2)

The rules follow version 2 as it stands:
- each source draws from its own seeded stream;
- each source has exactly one planted bad row and a data-quality rule;
- money never adds salon and online together;
- every metric has an oracle value, is proved live in Zetaris and is routed to divisions;
- no `planUse` unless the plan checker can check its unit.

Where a new source re-counts something an existing metric already counts, the new numbers must **add up to the existing ones exactly** (a test). Examples: page orders against the order count, order lines against order revenue and cost, and email flow plus campaign sends against today's email sends.

New units in `Metric.unit` (contracts): `minutes`, `days`, `seconds`, `score`. Metrics in these units carry `planUse: false`.

1. **Marketplaces** (business online, read by finance and hq): `fortune_demo_marketplace.{sales,ads,stock}`.
   - Period metrics: `m:online.amazon.{revenue,orders.count,fees}`, `m:online.walmart.{revenue,orders.count,fees}`, `m:online.ads.walmart.{spend,revenue,roas,conversions}` (like the Google family; online reads the ad family too).
   - Standing: `m:online.{amazon,walmart}.stock.low_cover.count` (under 21 days of cover), `m:online.{amazon,walmart}.stock.out.count`, `m:online.marketplace.inbound_units`.
   - Row read `marketplace_stock`: sku, marketplace, on hand, inbound, 28-day daily units, days of cover.
2. **Email split** (online; read by online and finance): `fortune_demo_marketing.email_messages`, with one row per send of a named flow or campaign from a fixed list of names.
   - `m:online.email.{flow,campaign}.{sends,revenue}`, `m:online.email.campaign.count`, `m:online.email.unsubscribe_rate`.
   - Flow plus campaign sends equal the existing daily email sends.
3. **Product performance** (online): `fortune_demo_online.order_lines` (order, sku, units, price, unit cost). Each order's lines add up to its revenue and its cost.
   - `m:online.products.cogs` (online, finance), `m:online.products.negative_margin.count` (online, hq).
   - Row read `products`: per sku for a period, units, revenue, cost, profit, margin, refunds and refund rate, views, average rating. Sorted by profit, best or worst first, with a limit.
4. **Returns and reviews** (online):
   - Version 2 orders gain a `customer_id` (`demo-cu-…`, its own stream).
   - New `fortune_demo_online.reviews`: order, customer, sku, rating 1–5, and a topic from a fixed list (fit, color, quality, shipping, service, other). No text.
   - Metrics: `m:online.reviews.{count,low_rating.count}`, `m:online.reviews.avg_rating` (score), and the standing `m:online.returns.repeat_customers.count` (two or more refunds in 365 days).
   - Row read `return_cases`, per refund in a period: order, customer id, sku, reason, amount, days after the sale, the customer's refunds in 365 days, their reviews (count, lowest rating, topics) and their messages (count, topics). The port adds the totals by reason.
5. **Inbox extras** (online): messages gain `customer_id` and `answered_by` (`emma`, `salon`, `auto`, `other`). Add planted duplicates: the same customer and topic on a second channel within 24 h, before the first message was answered.
   - `m:online.service.emma.replied_1h.share`, `m:online.service.emma.first_reply_minutes` (median, minutes), `m:online.service.duplicate.count`, `m:online.service.answered_twice.count`.
6. **Site, journey and blog** (online):
   - `fortune_demo_web.page_days` (date, page from a fixed list, page type, source: organic, google, meta, email, direct or social; sessions, carts, checkouts, orders, LCP ms). Orders per day equal the online order count.
   - `fortune_demo_web.crawl` (a weekly crawl: page, link, status).
   - `fortune_demo_web.blog_posts` (published, last updated, topic, 28-day sessions).
   - Metrics: `m:online.web.{sessions,conversion_rate,cart_rate}`, `m:online.web.slow_pages.count` (average LCP over 2.5 s), `m:online.web.lcp_avg_seconds` (seconds), the standing `m:online.web.broken_links.count` (latest crawl, 404 or 5xx), the standing `m:online.blog.stale.count` (not updated in 180 days), and `m:online.blog.published.count`.
   - Row read `journey`, by source: sessions, carts, checkouts, orders and the rates.
7. **Salon clients and product sales** (salon):
   - Version 2 appointments gain a `client_id` (`demo-sc-…`).
   - `fortune_demo_salon.product_sales`: date, client, location, line (mazali, fortune, tuni, care), amount, during-sale flag.
   - `fortune_demo_salon.sale_events`.
   - Segments are standing, over the last 365 days, and every client is in exactly one, taken in this order: frequent (6 or more visits), sale-only (two or more purchases, all during sale events), summer-only (every visit in June to August), Mazali buyer, standard.
   - Metrics: `m:salon.clients.active.count`, `m:salon.clients.{frequent,sale_only,summer_only,mazali,standard}.{count,revenue}` (salon, hq), `m:salon.products.{revenue,mazali.revenue}` (salon, finance), `m:salon.products.sale_share` (salon).
   - Row read `clients`: the segment table and the top clients by 365-day spend (visits, last visit, segment, months visited). No names.
8. **Personalization** (salon): `fortune_demo_salon.personalization` (intake online or salon; received, priced, paid, started, video sent, approved and shipped dates; fee).
   - `m:salon.personalization.{received.count,revenue,within_21d.share,online_intake.share}`, the standing `m:salon.personalization.{open.count,open_over_21d.count}`, and average days per stage: `m:salon.personalization.avg_days` and `m:salon.repairs.avg_days` (days).
   - Row read `personalization`: like repairs (open, late, done in the last 30 days) with the days each stage took.

New attention rules (plain sentences with no numbers):

| Rule | Level |
|---|---|
| marketplace stock out | act |
| low cover | watch |
| broken links | act |
| slow pages | watch |
| stale posts | watch |
| repeat returners | watch |
| duplicated messages | watch |
| low ratings | watch |
| personalization open over 21 days | act |

## Reports (workers W1, delivery W2)

- **Daily worker report** (07:00 ET, key `worker:<id>:<YYYY-MM-DD>`):
  - A program reads the worker's metrics and row totals and sets the status from the attention rules.
  - A model writes a headline and up to five findings that cite metric ids. Every number in them must trace to what was read. One correction round is allowed; otherwise a program writes the report from the rules (`writtenBy: 'rule'`).
  - Stored in `worker_reports`. No text message.
- **Weekly report** (Mondays 07:30 ET, plus `REPORT` by text: the owner may ask for any division, a head for their own):
  - Takes the latest worker report from each worker in the last seven days, running a worker now if it has none.
  - Asks the other divisions, with the briefs' data-request route.
  - Writes the summary, one section per worker, what was asked and answered, and the CEO line.
  - **Finance only:** a goal of the week (a metric, from, to, by when) and three profit paths as `ProfitPlans`, checked by `checkPlans`.
  - **Online and salon:** up to three actions, as in the brief.
  - The head approves a path or an action with `APPROVE <n> <code>`, and nothing is carried out by the program.
  - Stored in `weekly_reports`. The outbox then gets an SMS to the head, an email (to `HQ_REPORT_TO` only, with the subject "For <head>: <manager>'s weekly report") and a printout on the head's printer if one is set.
- **Email** goes through Postmark, using the `POSTMARK_HQ_SERVER_TOKEN` and `POSTMARK_HQ_FROM` env settings.
  - A recipient other than `HQ_REPORT_TO` is refused before any network call.
  - Each outbox item is sent at most once.
  - The weekly report's PDF goes along as an attachment.
  - With no token, the item is skipped with the reason and never fails.
- **Console**: each division's tab shows its workers' latest reports (and the last seven days) and its weekly report, with a PDF link. `?division=<d>` gives the head's own view. In production, the heads' sites go into the Fortune Hub.

## Lanes and the files each owns

Anything outside its own files a lane changes as little as it can, and says so in its notes.

- **D2 (data):**
  - `packages/data/**` and `scripts/zetaris-setup.ts`;
  - `docs/data.md`;
  - `packages/contracts/src/ports.ts`: the `RowRead` union only;
  - `packages/contracts/src/validate.ts`, if a new unit needs it;
  - `apps/worker/src/read-tools.ts` and `packages/codemode/src/brain-mcp.ts`: the new row tools and `DOOR_READS`;
  - the "You can read" lists in the department `SKILL.md` files.
- **W1 (workers and weekly reports):**
  - new files `apps/worker/src/workers.ts` and `weekly.ts`, with their tests;
  - `scheduler.ts`, `commands.ts`, `flows.ts` (the REPORT route), `brief.ts` (exports to reuse), `digest.ts` (the weekly CEO lines);
  - `store.ts`, in a section headed `// ---- worker and weekly reports (W1)`;
  - the department `SKILL.md` persona and "Your weekly report" sections;
  - `scripts/seed*` (display names);
  - `docs/workers.md`.
- **W2 (delivery and console):**
  - `packages/delivery/**` (the report PDFs and Postmark);
  - `apps/worker/src/outbox.ts`;
  - `store.ts`, in a section headed `// ---- delivery reads (W2)`, placed after W1's;
  - `apps/console/**`;
  - `.env.example` (the Postmark and `HQ_REPORT_TO` lines);
  - `docs/delivery.md`.

**The shared local database:** any test run that touches the database must run under `flock ~/.fahq-db-test.lock`. Use `flock ~/.fahq-db-test.lock npm test`, and the same for any single DB-backed test file. The worker's DB tests cancel every queued task, so two runners at once break each other.

## Status at the merge (2026-10-27, `hq/divisions-merge`)

All five wave 2 lanes are merged (data, workers, delivery, manager, legal); the record is `docs/lanes/merge-wave2.md`.

- **Built:** items 1 to 6 of "New synthetic sources and metrics" (marketplaces, the email split, order lines, the site
  journey and speed, returns and reviews, the blog), every worker but the two below, the weekly reports, the PDFs, email
  and print, the console's division tabs, the HQ Manager's own applies, and the Legal Team.
- **NOT BUILT (a known gap, not hidden): items 7 and 8**, the salon's client segments, the salon's product sales and
  personalization. No metric `m:salon.clients.*`, `m:salon.products.*` or `m:salon.personalization.*` exists and the row
  tools `get_salon_clients` and `get_personalization` do not exist. `apps/worker/src/workers.ts` keeps those prefixes in
  `PENDING_DATA_PREFIXES` and those tools in `PENDING_ROW_TOOLS`, so the `salon.clients` worker (and the personalization
  read of `salon.turnaround`) stops plainly and its receipt says the data is not connected yet; it never guesses. Finance's
  ask to Cindy for client segments has no data behind it until item 7 is built. `packages/data/test/channels.test.ts`
  holds an `it.fails` wall test that turns red the day those metrics land, so whoever builds them turns it into `it`.
- **The CEO assistant is Joey** (Ezra, 2026-10-27): assistant id `owner`, head Ezra (`CEO_ASSISTANT` in
  `packages/contracts/src/reports.ts`).
