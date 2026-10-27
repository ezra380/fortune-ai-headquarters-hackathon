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
- **No HTTP endpoint for the doors** (an outside tool calls the two RPCs with the anon key, or runs `serve.ts`; slice 2).
- **The typed-change schemas are not in `packages/contracts` yet.** `SessionReport` is (slice 2); the manager parses
  reports with it when it reads them (slice 3).
- **Nothing reads `session_reports` yet** (`reviewed_at` is never set), and nothing writes a profile as `manager` or `owner`.
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

## Slice 2 of 3: the door (2026-10-27)

An outside AI tool (Claude Code, Cursor, Codex, Gemini) starts `serve.ts` with a door token, gets the assistant's stored
profile as a read-only MCP server, and files its end-of-work report with one write tool. Full description:
[`docs/manager.md`](../manager.md), "The MCP door".

### What works

`packages/codemode/test/doors-db.test.ts` runs on the real local Postgres, the real Data API with the real anon key, and
starts `serve.ts` as a program over stdio (it skips, saying so, when the local stack is not up). The others use a mock
database or none. Every line names its tests.

- **`serve.ts --profile <id>` with `FAHQ_DOOR_TOKEN` or `--token-file`** reads the profile through `door_profile` with
  `SUPABASE_URL` and `SUPABASE_ANON_KEY` (a service key is refused before any call); `--local` keeps the file profiles
  for offline use. A token is bound to one assistant, so `--profile` is optional and must match. Nothing falls back to the
  files: a bad token, a missing token, an unreachable database or a stored profile that breaks a worker rule stops the
  door with one plain sentence and exit 2. Tests: `door.test.ts` (parseDoorArgs, openDoor --local, openDoor with a token:
  the profile read, the token from a file before the environment, what is missing, the refused token, a rule-breaking
  stored profile), `door-client.test.ts` (POST with the token in the body only, the anon key in the headers, no redirect
  followed, the refused sentence for a 403, the database's own sentence passed on, network failure, a service key, a bad
  token shape), `doors-db.test.ts` ("serves the stored profile of the token's assistant...", "gives each token its own
  assistant...", the five `serve.ts` cases: stored profile over stdio, `--token-file`, refused token, no token, `--local`).
- **The door's tools are exactly the stored profile's reads that the door can serve** (`DOOR_READS`), every one marked
  read-only, plus `file_work_report` when a report can be filed. A stored profile that drops a read drops the tool. Tests:
  `doors.test.ts` ("keeps the skill and the tools in step", "marks every read tool read-only...", "offers the reads of the
  stored profile, not those of the file", "serves a read the stored profile newly lists"), `doors-db.test.ts` ("offers
  exactly the stored reads the door can serve, and no write but file_work_report").
- **No write tool but `file_work_report`**, on every profile, plain and Code Mode; in Code Mode it sits beside `code` and a
  script cannot call it. Tests: `doors.test.ts` ("has no write tool but file_work_report, on every profile, plain and Code
  Mode", "keeps the report out of the sandbox", "offers a plain door its reads and the report...").
- **The skill prompt names only the tools the door offers.** `doorSkill` (`packages/profiles/src/door.ts`) rebuilds "You
  can read" from the door's tools (the skill's own line where it has one), leaves out any other line (and any standing
  lesson) that names a read tool the door lacks, adds the newest ten lessons, and fixes "End of work": it tells the tool to
  call `file_work_report` (also for a stored skill that still has the old wording, or none), or says there is no database
  to file in. Tests: `packages/profiles/test/door.test.ts` (never names a tool the door lacks for every profile x every
  tool set x with/without a report, keeps sections and order, drops the absent-tool line, corrects an old End of work,
  keeps the current one word for word, lessons), `doors.test.ts` ("serves the profile skill as the `skill` prompt...").
- **`file_work_report({ summary, steps?, suggestions?, lessons? })`** (zod at the tool, `SessionReport` in
  `packages/contracts`, 30 KB cap, the database checks again). It names the tool from the MCP client's handshake, never
  throws (one plain sentence for a failure) and returns only `{ filed, id, duplicate }`. The key is the session plus a hash
  of the content, so a retry is stored once and the same words in another session are a second report. Tests:
  `work-report.test.ts` (nine: offered only with a reporter, schema, the contract shape, duplicate, name cut to 60, 12
  out-of-bounds cases file nothing, the biggest report allowed and the size cap, a failure, nothing else returned),
  `packages/contracts/test/session-report.test.ts` (4), `door.test.ts` ("is stored under a key made of the session and
  what it says...").
- **The report lands redacted, under the token's assistant.** Tests (`doors-db.test.ts`): "lands in session_reports under
  the token's assistant, named for the tool, with phone numbers and codes masked" (three phone formats and two six-digit
  codes masked in the summary, a step and a lesson; 12400 and 18600 left alone), "stores a retry once...", "keeps the same
  words filed in two separate sessions as two reports", "files under the assistant of the token it holds, never another",
  "is checked by the database as well" (31 steps, a bad key), "keeps the token itself out of every table".
- **A refused token** gets one sentence that says nothing about why, for an unknown and a revoked token alike, and never
  contains the token. A door whose token is revoked mid-session cannot file (nothing is stored). Tests: "gets one sentence
  that says nothing about why...", "cannot file a report once it is revoked, and nothing is stored", the `serve.ts` refusal
  (exit 2, empty stdout, no token in stderr).
- **"End of work" is rewritten in the five skills** so it is true inside the worker (the worker files the report; the model
  has no tool for it) and at a door (call `file_work_report` once). `packages/profiles/test/profiles.test.ts` is green
  (the six headings, at most 48 lines, each skill names exactly its reads).
- Mutation checks, each caught by tests: report tool reachable from the sandbox, skill not generated from the door's
  tools, absent-tool lines kept, End of work not corrected, redirects followed, service key accepted, stored-profile rules
  not applied, report key ignoring the session, a token of another assistant accepted, no size check, the door serving every
  read of the profile, `serve.ts` forgetting the reporter, tool name not taken from the client, the token in the address,
  the refusal explaining itself, the report tool offered without a reporter. Full `npm test`: 41 files, 688 tests green.

### Not done

- **The HQ Manager does not read `session_reports` yet** (`reviewed_at` is never set) and nothing writes a profile as
  `manager` or `owner`; ADOPT still does not write lessons into the row. That is slice 3. A report is data from an outside
  AI: whoever reads it must treat it as data, never as instructions.
- **The typed-change schemas** are not in `packages/contracts` (slice 3).
- No HTTP endpoint for the doors; stdio only. A tool that cannot run `serve.ts` can still call the two RPCs (curl example in
  `docs/manager.md`).
- The door reads the profile once, at start: a change the manager makes reaches a running door at its next start. There is
  no `salon` metrics read at the door (`get_salon_metrics` is not in `DOOR_READS`; another lane adds reads there).
- The cloud Supabase project was not touched; nothing was run against it.

### What the merge must know

- **`DOOR_READS` and `describeReads`.** When another lane adds a name to `DOOR_READS`, it also needs a tool block in
  `createBrainMcpServer` and a line in `describeReads` (the door's words for the tool; the skill's own line is used when it
  has one). Without a block, the test "keeps the skill and the tools in step" fails and says which profile.
- **`serve.ts` no longer starts without arguments.** It needs a door token (`FAHQ_DOOR_TOKEN` or `--token-file`) or
  `--local`. Anything that starts it bare must change: `README.md` (two lines, edited here), `package.json` `mcp` script (pass
  the arguments after `--`), and the console's note in `docs/CONTRACT-REQUESTS.md` (2026-10-26 row: it says `serve.ts
  --plain`; with the file profiles that is `serve.ts --local --plain`). Nothing in `apps/` starts it.
- **Environment:** `FAHQ_DOOR_TOKEN` (or `--token-file`), `SUPABASE_URL`, `SUPABASE_ANON_KEY` (the public key). `serve.ts`
  still loads `.env.local`, so a `SUPABASE_URL` there is used unless the environment sets one; the anon key is not in it.
- **Reseed after the merge:** `npx tsx scripts/seed-profiles.ts --force` puts the new "End of work" into rows seeded before
  (the door corrects the wording itself in the meantime, so nothing breaks without it). I did not reseed the shared local
  stack: its rows are still version 1 and a `--force` from this worktree would also overwrite any change another lane made
  to its own rows.
- **Edits outside the lane's list:** `packages/codemode/src/index.ts` (`createCodeModeBrainServer` takes a profile object and
  keeps the report tool out of the sandbox), `packages/profiles/src/{index,rows,source}.ts` (small hunks: exports, `overlay`
  exported, `checkProfileRow` takes the three fields it reads), `README.md` (two lines), `packages/codemode/README.md` (one
  bullet), new `packages/contracts/test/session-report.test.ts`. `SessionReport` and `SESSION_REPORT_MAX_BYTES` are
  appended at the end of `packages/contracts/src/schemas.ts`. No migration, no new dependency.
- `doors-db.test.ts` uses `npx supabase status -o env` for the local anon key, makes door tokens and reports and deletes
  them again; it touches no profile (a version is append-only).
