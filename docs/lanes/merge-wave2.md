# Merge, wave 2 (`hq/divisions-merge`, 2026-10-27)

Five wave 2 lanes merged into `hq/divisions-merge` on top of `97a838f`, each with `git merge --no-ff`, in this order,
then the CEO assistant got his name (Joey), the Legal Team got its console tab, and the shared local database's profiles
were reseeded from the merged tree. Synthetic data only. Nothing was pushed; `hq/foundation`, `main`, the cloud project,
Twilio, Postmark, the running worker and the shared Zetaris objects were not touched.

| # | Merge commit | Branch (head) | Conflicts |
|---|---|---|---|
| 1 | `2bc07d7` | `hq/w2-data` (`b97eedb`) | none |
| 2 | `d98027e` | `hq/w2-workers` (`4069077`) | `apps/worker/src/brief.ts` |
| 3 | `27359e0` | `hq/w2-delivery` (`688187a`) | `apps/worker/src/store.ts` (imports, the W1 and W2 sections) |
| 4 | `db9361d` | `hq/w2-manager` (`21aa00b`) | none |
| 5 | `f4df32b` | `hq/w2-legal` (`31d4232`) | `apps/worker/src/read-tools.ts` (`list_lessons`) |
| - | `e19fb7e` | Joey, and the Legal Team's console tab | - |
| - | `019484b` | doors-db compares with the file profile again (after the reseed) | - |
| - | the commit that adds this file | these notes, docs/wave2.md's status, and a flaky console test tag | - |

## 1. `hq/w2-data`

No conflicts. The merge steps from the data lane's notes, done in the merge commit:

- **READ_SCOPE** (`packages/profiles/src/rows.ts`): `get_marketplace_stock`, `get_product_performance`, `get_return_cases`
  and `get_store_journey` are `'online'`. `get_product_performance` and `get_return_cases` (revenue, cost, profit and
  refund amounts) join **MONEY_READS**, so the HQ Manager can never be given them. No other lane added a read tool.
  `changes.test.ts`: "declares a scope for every read tool" pins the four scopes; the wall test checks the salon is walled
  from all four, Online from none, the manager from the two money reads.
- **Checker test** (`packages/data/test/catalog.test.ts`, on the merged checker of `523656f`): a Finance plan that says
  "2 products" and cites no stock count passes against every count Finance reads with their real catalog nouns (the
  marketplace stock counts own qualified phrases only), and "2 amazon low-cover products" is still held to its count.
  Found on the way: `m:online.inventory.low_stock.count` does own the bare "products", but it is Online's, not Finance's,
  so a Finance plan never sees it.
- **doors-db:** after the reseed (below), `packages/codemode/test/doors-db.test.ts` compares the door started from a
  stored profile with the FILE profile's reads again (`fileDoorTools`); the lane's `storedDoorTools` is gone (`019484b`).

## 2. `hq/w2-workers`

- **Conflict, `brief.ts` `approveAction`:** the second-key review (`1544c38`) had added the `nothing` helper and the
  "code spent for another message" check; the workers lane had generalised the lookup to `approvableBehind` (a brief or a
  weekly report). Kept both: the `nothing` helper takes the thing's kind, so its follow-up says "Text REPORT for a new
  report" for a weekly report and "Text BRIEF for a new brief" otherwise; the pinned wording of the review's test is unchanged.
- **PENDING_DATA_PREFIXES** keeps only `m:salon.products.`, `m:salon.products.revenue`, `m:salon.clients.` and
  `m:salon.personalization.` (items 7 and 8, not built). Every family the data lane built is off the list.
- **PENDING_ROW_TOOLS** keeps `get_salon_clients` and `get_personalization`. The four the data lane built already match
  the registry's names and arguments (`{ marketplace }`; `{ period }`; `{ sort: 'worst', period }`; `{ period }`), so the
  registry needed no rename, and "runs only read tools that exist" now requires each in its division's reads (it passes).
- **`workers.test.ts`:** "George's email worker keeps the email money and nothing else" was written before the email split
  existed. docs/wave2.md item 2 says Online and Finance read the split, so the worker now keeps the email money and the
  split (flow and campaign sends and revenue, campaigns, unsubscribe rate), and still never the total sends.

## 3. `hq/w2-delivery`

- **Conflict, `store.ts`:** kept both sections in order (`// ---- worker and weekly reports (W1)`, then
  `// ---- delivery reads (W2)`), and the union of the imports.
- The handshakes the delivery notes ask of W1 are in place and were read in the code: the weekly report's email and
  print rows carry `weeklyReportRef(id)`; `weekly_reports.message_id` is set; each approved choice is an
  `action-decision:<note id>:<rank>` decision note, which the console's loader reads. `workerReportsByIds(division, ids)`
  has no other caller.
- **Left as is (a cleanup, not a defect):** `addEmailOutbox` (W1) beside the widened `addOutbox` (W2); one call site,
  `weekly.ts` `deliver`.

## 4. `hq/w2-manager`

No conflicts. Migration `20261027130100_manager_applies.sql` was already applied to the shared local database and recorded
in `supabase_migrations.schema_migrations`; read back at the merge: the version row, `recommendations_kind_check` taking
`retire`, and both new `manager_reviews` columns. Not applied again.

## 5. `hq/w2-legal`

- **Conflict, `read-tools.ts` `list_lessons`:** the manager lane's description (lessons and notes in force) with the legal
  lane's signature (`"legal"` among the assistants).
- **Migrations:** `20261027130000_legal_value`, `20261027130010_legal`, `20261027130020_redact_email` are applied and
  recorded on the shared local database (read back). `redact_text` is defined by the base's `20261027100000_profiles`
  and `20261027100200_profiles_review` and replaced by `20261027130020`; no wave 2 lane redefines it.
- **Merge note 3:** `REVIEW_RULES` rule 1 lists `owner|finance|salon|online|manager|legal`.
- **Merge note 4 (done):** `askQuestion` gives the asker `legal` its own rules, `ANSWER_RULES_LEGAL`: general guidance in
  plain words; never a figure, deadline, citation or case not in the facts. The code holds it, not only the prompt: the
  number trace as before, plus a citation check ("X v. Y", section signs, U.S.C., C.F.R. not in the facts, one correction
  round, then the facts are sent instead). The program ends every Legal Team text with "I have not seen the document;
  this is not legal advice." (never twice). Every other asker keeps `ANSWER_RULES` and gets no closing (a test).
  `legal.test.ts`: the "texts the owner the facts as they are" test and the new guidance test were seen failing first.
- **A real interaction found by the merged suite:** the legal lane's loop test expected a lesson filed at the legal door to
  be applied by the HQ Manager by itself; the manager lane's rule 1 (`holdsWholeReview`) holds every recommendation of a
  review that carried an outside report for the owner's code. The manager lane's safety rule wins: in both apply modes
  the door's lesson now waits for the owner's code (the test says so). The test's apply-mode tables gained `retire`.
- **Merge note 5 (done, small):** the Legal Team's console tab: `DEPARTMENTS`, the loader's id check and `LIVE_ASSISTANTS`
  gain `legal` after the HQ Manager; the page names it and says it has no number (the owner asks it through Joey). The
  console tests that listed five assistants list six.

## Joey, the CEO assistant

Ezra, 2026-10-27: "You could call my CEO assistant by the name of Joey". The assistant id stays `owner`; the HQ Manager
and the database schema are unchanged.

- `packages/contracts/src/reports.ts`: `CEO_ASSISTANT = { name: 'Joey', head: 'Ezra', title: 'CEO' }`, beside `MANAGERS`.
- `packages/profiles/skills/owner/SKILL.md`: title `# Joey (Owner HQ)`; the Job opens "You are Joey, Ezra's CEO assistant.
  You report to Ezra, the owner, and you serve Ezra alone." (body 46 lines of the 48).
- The digest's heading: "Joey: company status for <date>:" and "Joey: weekly reports, week of <date>:".
- The printed proposal: "Prepared by Joey, the CEO assistant".
- The console: the tab "Joey (Owner HQ)", the digest's description and empty state, the HQ Manager's "reaches the owner
  through Joey".
- `supabase/seed.sql`: the owner assistant's display name "Joey (CEO)".
- README, `docs/divisions.md`, `docs/workers.md`, `docs/architecture.md`.
- Tests that pin the name: `packages/profiles/test/personas.test.ts` ("Joey, the CEO assistant": the opening line, the
  title, no manager skill says Joey), the digest and weekly heading tests, the console's tab-name tests.
- Not renamed (internal, not read by people): receipts and log lines that say "Owner HQ", the synthesis model's system
  words, and the router's prompt.

## The shared local database

- Migrations: all wave 2 files were already applied and recorded (see 4 and 5); none was applied by this merge.
- Profiles reseeded from the merged tree only: `npx tsx scripts/seed-profiles.ts --force --db postgresql://postgres:postgres@127.0.0.1:54322/postgres`
  (`SUPABASE_DB_URL` unset, under the lock): owner, finance, salon, online, manager and legal are each at version 4; lessons,
  manager notes and what the owner approved are kept by the script.
- Not changed: `public.assistants.display_name` on the shared stack (the seed file says "Joey (CEO)"; see the deploy list).
- Zetaris: `scripts/zetaris-setup.ts --v2 --verify-only` was NOT run (the machine was not quiet: other suites and this
  merge's own full run; the data lane measured a division read at 20 s to 288 s under load).

## Known gaps (not hidden)

- **Items 7 and 8 of docs/wave2.md are NOT BUILT:** the salon's client segments, product sales and personalization. No
  `m:salon.clients.*`, `m:salon.products.*` or `m:salon.personalization.*` metric and no `get_salon_clients` or
  `get_personalization` tool exists; `PENDING_DATA_PREFIXES` and `PENDING_ROW_TOOLS` keep them, so the `salon.clients`
  worker and the personalization read of `salon.turnaround` stop plainly with a receipt saying the data is not connected.
  George's ask to Cindy for client segments has nothing behind it yet. `channels.test.ts`'s `it.fails` wall test turns red
  the day the metrics land. docs/wave2.md's new "Status at the merge" section says the same.
- Data lane, still open: each division's period table reads the whole period view (a per-division subset view is the next
  fix); the unsliced `getFinanceMetrics` and the full `--v2` comparison over all 13 periods are not proved; version 1's
  ad conversion counts (Google, Meta, Amazon) still own a bare "orders".
- Delivery lane, still open: the Twilio and PrintNode 5xx retry; the weekly report's delivery state on the division tab.
- Workers lane, still open: the daily brief's `checkBrief` still accepts reply values without sources.
- The console's "latest CEO digest" shows the weekly digest on a Monday (it reads the newest `digestdoc:%`); filtering
  `body->>weekOf is null` there is the owner's call.

## Fixed on the way

- `apps/console/test/reports-db.test.ts`: its tag was six random hex characters, and the console masks any six digits as a
  code (`redactCodes`), so an all-digit tag ("783407") failed this merge's console run once. The tag is letters only now.
  Twin searched (`randomBytes(n).toString('hex')` in the console, worker and package tests): `divisions-db.test.ts`'s
  `FACT_MARKER` feeds absence checks the mask could make vacuous; made letters only too. The worker's random markers do
  not pass through `redactCodes`.

## Tests

- `npm run typecheck`: clean after every merge and on the final tree.
- Full suite on `019484b`, `flock ~/.fahq-db-test.lock npm test` (16:02:43 to 16:08:14 ET, load 1.7 at the start), with the
  Meterless engines present (`.local/meterless/engines`), so nothing skipped: **87 files passed; 1,641 tests passed, 1
  expected fail (the `it.fails` items 7 and 8 wall test), 0 skipped, 0 failed.** Among them `apps/worker/test/departments.test.ts`
  24 passed (the data lane asked for its count), `apps/worker/test/profiles.test.ts` 7 passed (its two "real store" cases
  had failed on every branch without `legal` in `AssistantId`), `packages/codemode/test/doors-db.test.ts` 21 passed (against
  the file profile), `apps/worker/test/legal.test.ts` 10 passed, `supabase/tests/profiles.test.ts` 65 passed.
- After that run, only the two console test tags changed (below): `reports-db.test.ts` and `divisions-db.test.ts` rerun
  under the lock, 2 files, 9 passed; typecheck clean.
- Seen failing first: the legal answer rules (2 tests red before `manager.ts` changed); the Legal Team console tab (the
  console's five-assistant tests red with the tab in and the tests not yet updated); the Finance "2 products" checker test
  first ran red with an over-wide metric set (it named `low_stock`), which is how the Online-only bare noun was found.

## What the deploy must do (cloud, in order; Ezra's yes first)

1. **Migrations**, in order, every file newer than the cloud's last applied `20261027000200_extend_lease`:
   1. `20261027100000_profiles.sql`
   2. `20261027100100_manager_decides.sql`
   3. `20261027100200_profiles_review.sql`
   4. `20261027100300_division_briefs.sql`
   5. `20261027100310_division_brief_runs.sql`
   6. `20261027100320_division_brief_peek.sql`
   7. `20261027120000_division_reports.sql`
   8. `20261027130000_legal_value.sql` (alone, committed: it adds the enum value the next file uses)
   9. `20261027130010_legal.sql`
   10. `20261027130020_redact_email.sql` (replaces `public.redact_text`)
   11. `20261027130100_manager_applies.sql`
2. **Reseed the profiles** from this merged tree: `npx tsx scripts/seed-profiles.ts --force --db <the cloud's URL>`
   (keeps lessons, manager notes and the owner's approvals). Optionally set the display names the seed file now carries:
   `update public.assistants set display_name = 'Joey (CEO)' where id = 'owner'` (and the managers' names, as the workers
   lane's notes say).
3. **Install**: `npm ci` (the worker now depends on `@fahq/delivery`).
4. **Environment** of the worker (and the console where it applies):
   - `FAHQ_DATA_VERSION=2` (version 2 sources and metrics; Zetaris must hold the version 2 objects: run
     `npx tsx scripts/zetaris-setup.ts --v2 --verify-only` on a quiet machine first);
   - `MODEL_PROVIDER` (Meterless) and `GUARD_PROVIDER` (the safety screen: NVIDIA directly or through Meterless);
   - `METERLESS_BASE_URL`, `METERLESS_TOKEN` or `METERLESS_TOKEN_FILE`, `METERLESS_DIR`;
   - `POSTMARK_HQ_SERVER_TOKEN`, `POSTMARK_HQ_FROM`, `HQ_REPORT_TO` (every report email goes to this one address);
   - `PRINTNODE_PRINTER_ONLINE`, `PRINTNODE_PRINTER_SALON` (the online and salon heads' printers, new in this wave);
   - optional `WEEKLY_MAX_TOKENS` (default 12000).
5. **Restart the worker** on the merged code (after the migrations), then a live acceptance on synthetic data only.
