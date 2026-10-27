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
  row id or a name such as nemotron-3-ultra"; `answer.test.ts` "skips only the digits that close a row id …".
- **c. Provider text out of failure details.** New `apps/worker/src/data-read.ts` `readData`: a failed read gives
  "Business data could not be read (ZETARIS_READ)." and logs `worker.zetaris_read_failed` with phones, codes and emails
  masked. Used by the read tools (replaces their own copy), the plan round (`rounds.ts`), the plan writer
  (`finance.ts`, whose error the finance mailbox in `flows.ts` keeps as detail) and, as a twin found by search, the
  division brief's read (`brief.ts` `divisionData`). Tests: `units.test.ts` "keeps the data source's own text out of its
  failure …"; `chain.test.ts` "says plainly when business data is not connected, and when it cannot be read" (receipt and
  task error); `brief.test.ts` "says so, with a failed receipt, …"; `brief-flow.test.ts` "fails plainly, with a receipt,
  when the numbers cannot be read …".
- **d. ADOPT checks before it spends.** `adoptChanges` peeks (`peek_approval_code`, action `adopt_change`), finds the
  review, and refuses a command naming a rank the review lacks before the code is spent: "This review has no
  recommendation 3. Nothing was adopted, and your code still works." A wrong code still falls through to the spend and
  is counted. An `approve_action` code under ADOPT now names APPROVE (`BRIEF_CODE_FOR`). The old post-spend handling
  (adopt what exists, name the rest) stays as the safety net for a code taken in the moment between peek and spend.
  Tests: `manager.test.ts` "says which ranks were not adopted, …" (now: refused whole, then the same code adopts rank
  2); `brief-flow.test.ts` "a plain yes decides nothing, and a code used with the wrong command word stays usable"
  (ADOPT case).
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

## Still not done (from the lanes, still true after the merge)

- **Law 10:** no independent second-key review of the data lane's slice 4 and review fixes, of the profiles lane's
  review fixes, or of anything in this merge (conflict resolutions, items a–e). Law 12: this merge is 140 files and
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
  at start; no door-token revoke script; numbers inside a JSON report are not masked; `list_work_reports` is not in
  `NEVER_READS`.
- Nightshift: `MODEL_PROVIDER=meterless` is unit-tested only; not run live in this merge.
- Cloud: none of the new migrations applied; the console's Divisions tab says "could not be read (42P01)" there
  until they are.
