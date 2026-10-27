# Lane notes: profiles (branch `hq/div-profiles`, cut from `hq/foundation` at bb29578)

The assistants' profiles live in Supabase; outside AI tools that call a profile get a read-only API and file their
end-of-work report to the HQ Manager; the HQ Manager reads those reports and decides what changes. Three slices.
Synthetic data only. The full description of what exists is in [`docs/manager.md`](../manager.md), "Profiles in the
database". This file is the lane's log: what works, what is not done, what the merge must know.

## Slice 1 of 3: profiles in Supabase (2026-10-27)

### What works

Every line names the tests that prove it. `supabase/tests/profiles.test.ts` (49 tests) runs on the real local Postgres
and the real Data API; its "profile writes" and "seeding profiles" groups build a throwaway database from the real
migration file (so they can commit versions and race writers) and drop it afterwards.

- **Migration `20261027100000_profiles.sql`**, applied once to the local stack (with `docker exec ... psql`, because
  `psql` is not installed in WSL) and recorded in `supabase_migrations.schema_migrations`. Four tables with RLS on and no
  policies: `assistant_profiles`, `assistant_profile_versions`, `door_tokens`, `session_reports`.
- **One write path.** `save_assistant_profile` (service role only) writes the row and appends the version in one
  transaction, guarded by the version the writer last saw. Tests: "creates a profile once, then only changes it from the
  version the writer last saw", "gives exactly one of two writers racing from the same version the next version",
  "gives exactly one of two writers racing to create the same profile its first version", "numbers versions from the
  history, so a profile removed and made again never reuses a number", "refuses a writer that is not seed, manager or
  owner, and a profile that breaks the table limits", "can be called by the service role (the worker) and by nobody else".
- **History is append-only.** A trigger refuses update, delete and truncate; the service role has no such privilege.
  Tests: "refuses update, delete and truncate, even from the table owner", "is closed to the service role as well",
  "keeps the history append-only on a database that has committed versions".
- **The two doors**, callable by `anon` with a token: `door_profile(token)` and `door_file_report(token, report)`, both
  `SECURITY DEFINER` with `search_path ''`. Tests (through the Data API with the anon key): "gives a valid token the
  profile of its own assistant", "gives each token only its own assistant, so the salon and the online store never see
  each other", "refuses everything that is not a live token, with one answer that says nothing about why", "refuses a
  token sent in a URL (a GET)...", "stores a report under the assistant of the token", "masks phone numbers and
  six-digit codes everywhere in the report, and leaves ordinary numbers alone", "stores a retried report once", seventeen
  "refuses ... with a plain sentence and stores nothing" cases (size limits, unknown field, bad key, depth), "files
  nothing for a token that is not valid", "stops a token after 60 reports in an hour", "stores only the SHA-256 of a
  token, and the database agrees with the hash the script computes", "masks every string and key in a JSON value".
- **What `anon` and `authenticated` can reach.** No table privilege at all (revoked on every table in `public`, today's
  and later ones), and execute on exactly the two doors. Tests: "hold no privilege on any table, today or on a table
  made later", "anon cannot read, insert, change, delete or empty any table in the database" (and the same for
  `authenticated`, every table in the schema), "are refused by the Data API too", "can run exactly the two doors and no
  other function in the schema".
- **`packages/profiles`**: `ProfileRow` and the rules a stored profile must meet (`src/rows.ts`); the profile source
  with a 60 s cache that falls back to the files for a missing or refused row (`src/source.ts`); `seedProfiles`
  (`src/seed.ts`); door token helpers (`src/tokens.ts`). `AssistantProfile` gained `lessons`, `version` and `source`.
  Tests: `db-source.test.ts` (19: overlay, refused rows, the business wall, one read per minute, background refresh,
  failing first read, failing later read, copies, lessons in the skill text), `tokens.test.ts` (5), `profiles.test.ts`
  (+2: file profiles say so; no import cycle).
- **Seeding is idempotent.** Tests: "stores the five file profiles once, each with a version made by seed", "is
  idempotent: running it again changes nothing", "leaves a profile the manager or the owner changed alone, and says it
  differs from the files", "--force puts the files back as a new version and keeps the lessons a person adopted".
- **The worker uses the source** (`apps/worker/src/profiles.ts`, `main.ts` profile lines, `store.assistantProfiles()`).
  Tests: `apps/worker/test/profiles.test.ts` (7: a stored profile with lessons, no model for a job, a table that cannot
  be read stops the worker with the fix in the message, `PROFILES_SOURCE=files`, a refused row keeps the file profile,
  and on the real store and table: the five rows pass the checks and every read tool of every row can be built), and
  "feeds the worker profile source: every assistant from its row, and the files for a row that is missing" (real table).
- **Scripts**, run end to end against the throwaway database ("runs as the two scripts"): `scripts/seed-profiles.ts`
  (`--force`, `--db`) and `scripts/issue-door-token.ts <assistant> [label]` (`--replace`, `--dir`, `--db`): the token goes
  to `.local/door-tokens/<assistant>.token` with mode 600, only its hash to the database, only the path to stdout.
- The local stack is seeded (five profiles at version 1, made by `seed`).
- Mutation checks, each caught by a test: no append-only trigger, `save_assistant_profile` ignoring the expected
  version, the source without the business wall, the source without its cache, `anon` granted `select` on `people`.

### Not done (later slices, or left out on purpose)

- **ADOPT does not write into the profile row yet.** A lesson the owner adopts still goes to the recommendations table
  and H-MEM. The row's `lessons` stay empty until slice 2 writes them through `save_assistant_profile`; a row that has
  lessons already gets them into the skill text a model sees (`skillWithLessons`).
- **No HTTP or MCP wrapper for the doors** and no client: an outside tool calls the two RPCs with the anon key
  (curl example in `docs/manager.md`). `serve.ts` and `brain-mcp.ts` still read the file profiles.
- **`SessionReport` and the typed-change schemas are not in `packages/contracts` yet.** The door validates in SQL; slice 2
  adds the schema and parses reports when the manager reads them.
- **Nothing reads `session_reports` yet** (`reviewed_at` is never set), and nothing writes a profile as `manager` or `owner`.
- **The "End of work" sections of the five skills are unchanged.**
- No revoke script for door tokens (one SQL line in `docs/manager.md`). Numbers inside a JSON report are not masked
  (only strings and keys), the same as `scrub` in `read-tools.ts`.
- The cloud Supabase project was not touched: the migration is not applied there, and the profiles are not seeded there.

### What the merge must know

- **Order of release:** apply `supabase/migrations/20261027100000_profiles.sql`, run `npx tsx scripts/seed-profiles.ts --db <url>`,
  then start the worker. A worker on this branch refuses to start when `assistant_profiles` cannot be read (the message
  says what to run); `PROFILES_SOURCE=files` runs on the files alone. The running worker in the main checkout is unaffected.
- **Once seeded, a row beats the file** for title, skill, reads and models. When another lane changes `SHAPES`, a
  `SKILL.md` or the model defaults, run `seed-profiles.ts --force` (keeps lessons) to put the files into the rows. Model
  environment variables (`CODE_MODEL`, `NEMOTRON_PLAN_MODEL` ...) are read at seed time only.
- **The migration takes every table privilege away from `anon` and `authenticated` on all of `public`**, other lanes'
  tables included, and on tables made later by `postgres`. A test that expects `anon` to see "zero rows" now gets
  "permission denied". I changed the two such assertions in `supabase/tests/db.test.ts` (the only file outside the lane's
  list that I edited, apart from the changes below).
- **A new function in `public` must `revoke all ... from public, anon, authenticated`** (every existing migration does),
  or the test "can run exactly the two doors and no other function in the schema" fails and says which one.
- Edits outside the lane's own files: `packages/profiles/src/index.ts` (the `AssistantProfile` fields, the `Shape` type,
  `loadProfiles` adds `lessons`/`version`/`source`, new exports at the bottom: small hunks, away from `SHAPES`),
  `apps/worker/src/main.ts` (profile loading lines only), `apps/worker/src/store.ts` (one new method,
  `assistantProfiles`), new `apps/worker/src/profiles.ts`.
- `npm run typecheck` covers `packages/` and `apps/` only, not `supabase/tests` or `scripts/`.
- The shared local database makes `apps/worker/test/departments.test.ts` ("the lease of a task that takes long") fail
  now and then in a full `npm test` while another lane's tests run at the same moment; it passed 3 of 3 alone.
- No new dependency; no migration other than the one above; no environment variable except the optional
  `PROFILES_SOURCE=files`.
