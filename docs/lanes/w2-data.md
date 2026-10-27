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
