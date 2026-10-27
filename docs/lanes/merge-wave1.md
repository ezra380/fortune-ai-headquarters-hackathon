# Merge wave 1: the four division lanes into `hq/divisions-merge` (2026-10-27, 10:25–11:05 ET)

Branch `hq/divisions-merge`, worktree `~/fahq-merge`, cut from `hq/foundation` at `bb29578`. Nothing pushed;
`hq/foundation`, the main checkout and its live worker, the cloud project, Twilio and Zetaris objects were not touched.
Lane logs: [data.md](data.md), [brief.md](brief.md), [profiles.md](profiles.md); the nightshift lane (two commits)
wrote none. Where this file and a lane log differ about the merged code, this file is newer.

## Order

| Commit | What |
|---|---|
| `9e21262` | merge `hq/div-nightshift` (`MODEL_PROVIDER=meterless`): clean |
| `ec72917` | merge `hq/div-data` (28 commits): clean on top of nightshift |
| `3ab7c4a` | merge `hq/div-brief` (13 commits): clean (textual); semantic fixes below |
| `92074e9` | merge `hq/div-profiles` (16 commits): 14 files in conflict, resolved below |
| `a903983` | the brief lane's three migrations renamed so no two files share a timestamp |
| `5a0d663`, `1874ff6` | tests that hard-coded a lane's tool lists before another lane added tools |
| `5251d38` | merge-time items a–e |
| `c46272b` | `supabase/tests/migrations.test.ts`; the brief's anon test expects a refusal |
| `9744827`, `10cf1c7` | docs and the manager skill brought in line; tidy |

## Conflicts and how each was resolved (every lane's side kept)

- **`packages/profiles/skills/{finance,online,salon}/SKILL.md`**: the profiles lane's new "End of work" (worker files
  it; at a door call `file_work_report`) and the brief lane's "Your brief" section after it. Finance is now at exactly
  48 body lines, the limit in `profiles.test.ts`: a lane that adds a line there must take one out.
- **`packages/profiles/src/index.ts`**: `READ_TOOL_NAMES` holds `list_session_reports` (profiles) and the eight division
  reads (data); the manager reads `list_session_reports` and `get_data_quality`.
- **`packages/profiles/test/profiles.test.ts`, `apps/worker/test/read-tools.test.ts`**: the same two lists combined.
- **`packages/contracts/src/schemas.ts`**: both appended blocks kept (division briefs; session reports and typed changes).
- **`apps/worker/src/common.ts`, `store.ts`**: the type imports of both lanes combined.
- **`apps/worker/src/main.ts`**: the store made once (profiles, `workerProfiles`), then the data port and
  `financePeriod` (data), then the scheduler (brief). `loadProfiles` is no longer imported there.
- **`apps/worker/src/read-tools.ts`**: imports combined (the data lane's division types and the profiles lane's
  `phonePattern` for `scrub`).
- **`packages/codemode/src/brain-mcp.ts`** (four hunks): the door takes a profile object and offers `file_work_report`
  (profiles); the period enum comes from the port (data; the module-level `period` is gone); `registerDivisionReads`
  takes the profile. Found while resolving: the data lane's door tools and `get_salon_metrics` had no read-only
  annotation and no words in `describeReads`, which the profiles lane's door tests require ("marks every read tool
  read-only", "keeps the skill and the tools in step"). Their descriptions moved into `describeReads` and every one
  now carries `READ_ONLY`.
- **`packages/codemode/test/doors.test.ts`**: the data lane's door tests kept, the profiles lane's renamed test kept.
- **`supabase/tests/db.test.ts`**: the brief lane's `division_briefs` row helpers and its table in the anon loop; the
  profiles lane's `denied()` assertion for every table in the loop.
- **Semantic conflicts (no text conflict, tests red after the merge):** five profiles-lane tests and one manager test
  hard-coded Finance's and Online's reads or door tools from before the data lane added the division reads
  (`manager-decides.test.ts` reads change, `changes.test.ts` read change, `doors.test.ts` "a door with a report to
  file", three `doors-db.test.ts` `serve.ts` cases). They now derive the list from the profile or `doorReads`.
  `digest-flow.test.ts` passes the brief lane's two jobs explicitly (with the manager's 09:00 job on the clock it would
  queue review tasks into the shared database).

## Migrations

Two lanes had used `20261027100100` (`division_briefs` and `manager_decides`). The profiles lane's three files are
recorded under their own versions on the shared stack, so the brief lane's three were renamed, contents unchanged:

```
20261026200000_core … 20261027000200_extend_lease          (foundation, unchanged)
20261027100000_profiles              (profiles)  revokes every table privilege from anon/authenticated, the doors
20261027100100_manager_decides       (profiles)  recommendations.kind/detail/applied_*, session_reports.review_id
20261027100200_profiles_review       (profiles)  create or replace redact_text, door_check_list
20261027100300_division_briefs       (brief, was 100100)  division_briefs; approve_action; issue_approval/use_approval_code
20261027100310_division_brief_runs   (brief, was 100110)
20261027100320_division_brief_peek   (brief, was 100120)  peek_approval_code (service role only)
```

- **Functions re-created by two lanes:** none in fact. `issue_approval` and `use_approval_code` are re-created only by
  the brief lane (its bodies equal `20261027000100_manager.sql` plus `'approve_action'`, checked line by line); the
  profiles lane does not touch them. `redact_text` and `door_check_list` are re-created only by the profiles lane. The
  last file for each holds every action and change. `migrations.test.ts` checks the four actions in the constraint and
  both bodies on a database built from the files.
- **Shared local database:** every function body on it equals the body in the last file that defines it, and the
  brief lane's objects were all there, but its three migrations had never been recorded in
  `supabase_migrations.schema_migrations` (applied by a script). They are now recorded under `20261027100300/100310/100320`
  (rows inserted, nothing re-run; re-running `create table` would fail). No other migration needed applying.
- **New test** `supabase/tests/migrations.test.ts`: every file has its own timestamp (seen failing with the lanes'
  names); the whole set applies in order to an empty scratch database with Supabase's default grants; anon is then
  refused on every table (no grant left), can run exactly the two doors, and the approval functions take all four
  actions. The scratch database is dropped afterwards (checked: none left).
- The cloud project has none of the `202610271…` files applied (not checked; not touched). Apply them in the order
  above before a worker from this branch runs against it.

## The two "public (anon) role" tests in `db.test.ts`

They failed on `bb29578`'s own code because of the **shared database, not the test or the migrations**: the
profiles lane had applied `20261027100000_profiles.sql` there, which revokes every table privilege from `anon` and
`authenticated`, so `bb29578`'s expectation of "zero rows" met "permission denied". Proof, with throwaway databases
built from the migration files the way the profiles lane's tests build theirs: from `bb29578`'s 7 files, anon reads
`tasks` and `work_reports` as 0 rows (168 table grants held by anon/authenticated); from the merged 13 files, anon is
refused on every table (0 grants). The merged test (the profiles lane's `denied()`) therefore passes on the shared stack
and on a database built from the files, and keeps its meaning (anon sees no row and calls nothing). The brief lane's
"either zero rows or refused" test was tightened to the refusal for the same reason.

## Merge-time items (each test seen failing before its fix)

- **a. The HQ Manager's daily review on the clock.** `SCHEDULE` gains `{ name: 'manager-review', at: '09:00' }`, which
  calls `queueDailyReview` (key `review:daily:<New York day>`, quiet). A job that answers nothing is marked queued, as
  before. Tests: `digest.test.ts` "holds the HQ Manager's daily review at 09:00, after the briefs and the digest", "queues
  one quiet review task keyed by the New York day, however often the clock asks, from one worker or a restarted one".
- **b. Row-id twins of the data lane's 4e.** `isRowId` is exported from `@fahq/contracts` as the one rule.
  `reports.ts` `numberTrace`: the look-behind `\p{L}-` is gone; after a word and a hyphen, digits are skipped only when
  they close a row id or sit inside a name (`nemotron-3-ultra`, `lightning-30b`, which the existing tests pin as names);
  "high-35%", "ROAS-9.5x", "the top-100 buyers" are read. `answer.ts` `figuresIn`: bare digits that close a row id
  ("SUP-2201") are skipped. Tests: `units.test.ts` "reads a figure written after a word and a hyphen, and skips only a
  row id or a name such as nemotron-3-ultra"; `answer.test.ts` "skips only the digits that close a row id …". This let
  any id-shaped name pass untraced; fixed in the second-key review below (the id itself must be given).
- **c. Provider text out of failure details.** New `apps/worker/src/data-read.ts` `readData`: a failed read gives
  "Business data could not be read (ZETARIS_READ)." and logs `worker.zetaris_read_failed` with phones, codes and emails
  masked. Used by the read tools (replaces their own copy), the plan round (`rounds.ts`), the plan writer
  (`finance.ts`, whose error the finance mailbox in `flows.ts` keeps as detail) and, as a twin found by search, the
  division brief's read (`brief.ts` `divisionData`). Tests: `units.test.ts` "keeps the data source's own text out of its
  failure …"; `chain.test.ts` "says plainly when business data is not connected, and when it cannot be read" (receipt and
  task error); `brief.test.ts` "says so, with a failed receipt, …"; `brief-flow.test.ts` "fails plainly, with a receipt,
  when the numbers cannot be read …".
- **d. ADOPT checks before it spends.** `adoptChanges` peeks (`peek_approval_code`, action `adopt_change`), finds the
  review, and refuses a command naming a rank that is not open in the review before the code is spent: "This review has
  no open recommendation 3. Nothing was adopted, and your code still works." A wrong code still falls through to the
  spend and is counted. An `approve_action` code under ADOPT now names APPROVE (`BRIEF_CODE_FOR`). After the spend, ADOPT
  and APPROVE record nothing when a rank is missing or the code spent is not the one looked at (see "Second-key review"
  below; the first version of this item adopted the ranks that existed and wrongly called that a safety net for a code
  taken between peek and spend, a case in which the spend itself refuses). Tests: `manager.test.ts` "says which ranks
  were not adopted, …" (refused whole, then the same code adopts rank 2) and "ADOPT is applied whole or not at all";
  `brief-flow.test.ts` "a plain yes decides nothing, and a code used with the wrong command word stays usable" (ADOPT
  case).
- **e. FINANCE_PERIOD default.** `financePeriod` keeps the data lane's refusal and falls back to `2026-10-mtd` when the
  port serves it (design 4g), else to the latest period the port serves. `.env.example` no longer sets `2026-09`.
  Tests: `units.test.ts` "defaults to 2026-10-mtd when the data serves it, else to the latest period it serves; …" and
  the updated "uses a period the data serves, …". The main checkout's `.env.local` does not set `FINANCE_PERIOD`, so a
  worker from this branch plans for `2026-10-mtd` there.
- **f. `MANAGER_APPLIES`** is unchanged: all false (`typed-change.test.ts` tripwire green).

## Profiles reseeded

`npx tsx scripts/seed-profiles.ts --force --db <local>`: the five rows went from version 1 to 2 with the merged files,
then to 3 after the manager skill's `get_data_quality` line was corrected. No owner choices or lessons existed to keep.
The stored rows now carry the new End of work, Your brief, `list_session_reports` (manager) and the division reads.

## Proof

- `npm run typecheck` clean on `10cf1c7`.
- Full `npm test` on the shared stack, nothing else testing: run 1 (before the semantic test fixes) 1207 passed,
  5 failed (the five hard-coded tool lists above); run 2 on `1874ff6` 1212 of 1212; runs 3 and 4 on `10cf1c7`
  1212 of 1212 each (64 files, about 87 s).
- Zetaris, read-only: `npx tsx scripts/zetaris-setup.ts --v2 --verify-only` (no create or drop on that path; it starts
  the local source server on 18121 and closes it): 145 comparisons all match, 9 row reads and 5 series equal to the
  oracle, version 1's mart listed exactly as before, "version 2 verified" (10:53–10:57 ET).

## Found wrong (and fixed here unless said)

- The duplicate migration timestamp, and the brief lane's migrations applied but not recorded (fixed).
- The data lane's door tools without the read-only annotation or door words (fixed in the merge).
- The manager skill said `get_data_quality` gives "the total" after the data lane's review removed it (fixed; reseeded).
- README's HQ Manager row still said the manager applies lessons and notes itself (fixed).
- `brain-mcp.ts` `logDetail` masks phone numbers with its own pattern, not `maskPhonesAndCodes` (a log only; left).

## Second-key review (2026-10-27 afternoon)

An independent review of this merge found two majors and four minors. All six were taken; none was judged wrong.
Every test named below was seen failing on the unfixed code (7 unit tests, 5 database tests), except one marked as a
pin. No migration; the stored profiles still pass the new wall (no reseed).

1. **Major: an invented row id passed every trace (item b).** `rowIdsIn(text)`, beside `isRowId` in `@fahq/contracts`,
   lists the ids a text names (exactly those whose digits `isRowId` skips). `answer.ts` `traceNumbers` objects
   `"SUP-9999" is not in the facts` unless a string of the facts holds the id (any case; a key does not count).
   `reports.ts` `numberTrace` does the same against the data (`is not in the data`): the manager's review and answers,
   the division brief and Owner HQ's synthesis all go through it. `checkPlans` refuses every row id in a plan, memory
   notes included (`is not in the data: a plan cites metrics, never a row`). Tests: `answer.test.ts` "refuses a row id the
   facts do not hold, as it refuses a number" (the old line 191 now names an id the facts hold); `units.test.ts` "refuses a
   row id that is not in the data, and passes one that is" (the old line 374 case, now refused); `validate.test.ts`
   "refuses a row id in a plan …" (replaces design 4e's "lets an action name a row by its id") and "rowIdsIn names exactly
   the ids …". Judgment: the id must be in the facts, not only in the question, so "SUP-9999 is not in the data" is
   refused too and the person gets the plain facts after the correction round (fails closed). Twins: `rg
   "isRowId|rowIdsIn"` finds the three, all fixed; `untracedResultNumbers` (answer.ts) is a hint shown next to the
   script, never a gate, and still lists numbers only (left).
2. **Major: the salon/online wall missed the division reads.** `READ_SCOPE` (salon, online, both or none, for each of the
   22 read tools) and `MONEY_READS` live in `packages/profiles/src/rows.ts`, keyed by `ReadToolName`, so a tool added to
   `READ_TOOL_NAMES` does not compile without a scope. `checkProfileRow` derives the wall from them: the salon reads only
   salon or none tools, the online store only online or none, the manager no money tool; a name without a scope is
   walled. Not in `index.ts` as the review suggested: `rows.ts` enforces the wall and `index.ts` imports `rows.ts`, so
   `rows.ts` takes the names as a type only (no run-time import cycle). None means no business data, or only the
   caller's own: `my_lessons`, `recall_my_decisions`; `get_timeline`, `usage_summary`, `open_items` (ids, times and
   counts); `get_metric_series` and `list_session_reports` (wall themselves by caller). `get_budget_room` is online (the
   online ad budgets) and money. Beyond the review's minimum, the salon and the online store also lose `recall_decisions`,
   `list_lessons`, `list_work_reports`, `latest_proposal` and `explain_proposal` (both); no shipped profile reads them.
   Left as shipped: the manager reads `explain_proposal`, which returns cited metric values; finance and the owner have
   no wall. Tests: `changes.test.ts` "walls every division read by its scope …" (every assistant against every tool,
   and the review's cases through `applyProfileChange`) and "declares a scope for every read tool, and for nothing
   else".
3. **Minor, open question 3 (ADOPT after the spend): decided as the review proposed.** ADOPT now matches APPROVE: a
   command is applied whole or not at all. A rank missing after the spend adopts nothing, writes a failed receipt, answers
   "This review has no recommendation N, and the code was already used up, so nothing was adopted. Text REVIEW for a new
   review and code." and fails the task. The spend is bound to the look in both commands: when the look found a code and
   the spend used another message, nothing is recorded ("Your code was used up, but not for the review it was checked
   against, …"). The message ids are compared; `peek_approval_code` is unchanged (no migration). Tests: `manager.test.ts`
   "adopts nothing when a spent code finds a rank missing …" and "adopts nothing when the code spent is not the one the
   look checked"; `brief-flow.test.ts` "records nothing when the code spent is not the one the look checked". APPROVE's
   missing-rank case already recorded nothing and keeps its test.
4. **Minor: a closed rank passed the look.** The look refuses a rank whose status is not `proposed` unless the manager
   already applied it: "This review has no open recommendation N. Nothing was adopted, and your code still works." The
   comment on `adoptChanges` now names its test. Test: `manager.test.ts` "refuses a rank the program closed before the
   code is spent, …"; the replies in "says which ranks were not adopted" now say "no open recommendation", and
   `manager-decides.test.ts` "closes a recommendation the stored profile will not take …" (which pinned the old
   "Not applied" after the spend) now expects the refusal before it.
5. **Minor: the safety-net claim.** Item d reworded. The `brief.ts` comment that said "if the code was taken a moment
   earlier" now names what reaches the branch: a replayed task or a hash collision (a code taken between look and spend
   makes the spend refuse).
6. **Minor: uncited small counts (data lane 4d).** `checkPlan` builds the phrase map from every count metric the catalog
   names among the metrics passed, cited or not. Judgment: when the best phrase fits a cited and an uncited count ("16
   repairs" with open repairs cited, late repairs not), the cited one is meant, so a plan that passed on its cited count
   still passes; between uncited counts of different values the plan must name which. Memory notes still get no
   small-count check (they belong to no plan). Tests: `validate.test.ts` "holds a small number to the uncited count its
   words name" and, a pin that passed before the fix too, "lets a bare noun mean the count the plan cites …".

Proof: before the fixes, the four unit files ran 7 failed of 221 and the two database files 5 failed of 61, each the
new or changed test named above. After them `npm run typecheck` is clean and the full `npm test` on the shared stack,
under the test lock, ran 1230 of 1230 (65 files, about 124 s); the first full run found one more test that pinned the
old ADOPT reply (`manager-decides.test.ts`, item 4). A probe of `rowIdsIn` on 100,000-character hostile strings (hyphen
runs, one long segment, many starts) took 3 ms or less, and a full-width `ＳＵＰ－９９９９` is read and refused as
`SUP-9999`.

## Still not done (from the lanes, still true after the merge)

- **Law 10:** the second-key review above read this merge (and the data lane's rule 4d); its fix-ups need their own
  re-review. No independent review yet of the data lane's other slice 4 and review fixes or of the profiles lane's
  review fixes beyond what it touched. Law 12: this merge is 140 files and
  about 20,000 added lines; Ezra's OK on size (or a split) is still needed, and Class 1 parts (migrations, approval
  codes) need his approval before any merge to a live branch.
- Data: rounds read `getFinanceMetrics` once, unsliced (about 20 s live under version 2); per-division mart reads in
  `rounds.ts` and `explain.ts` (design 4h) not built; durations (4c) and the synthetic-join guard (4f) not built; no
  metric has `planUse: false`; the plan writer is not shown the count phrases up front; version 1 not re-proved live;
  rejected-rows metrics for ads and email, Meta campaigns, store sessions not built; no salon–online join (Ezra's cut).
  Zetaris still holds the empty `fortune_demo_probe` container (no SQL drops one).
- Briefs: a customer's name in a question is not caught; BRIEF has no rate limit; the clock runs only in the normal
  mode, not `--once`; the digest is only texted (no printout, the brief PDF is skipped); the HQ Manager does not read
  briefs and `reports.ts` has no `brief.write` correction suggestion; the console shows only each division's latest brief
  and was not run against the live worker's rows; a worker started after about 10:30 whose briefs then stick sends no
  partial digest.
- Profiles: the manager applying a lesson or note by itself stays off until Ezra approves it in writing and the two
  "at minimum" conditions are built; one successful `saveProfile` through PostgREST on the shared stack is not proven;
  lessons adopted before profiles were stored are not copied into rows; doors are stdio only and read the profile once
  at start; no door-token revoke script; numbers inside a JSON report are not masked. (`list_work_reports` is now walled
  from the salon and the online store by its scope; see the second-key review.)
- Nightshift: `MODEL_PROVIDER=meterless` is unit-tested only; not run live in this merge.
- Cloud: none of the new migrations applied; the console's Divisions tab says "could not be read (42P01)" there
  until they are.
