# Lane notes: wave 2, the Legal Team (branch `hq/w2-legal`, cut from `hq/divisions-merge` at 523656f)

Ezra's words (2026-10-27): he wants "a legal profile matching the same level of advanced setup as Gideon, Helena, Marisol,
and Noemi", named "Legal Team", that "knows how to properly scan and analyze terms and conditions", works "the same way
as those other profiles through Supabase", with staff sessions "in whichever account" spreading the information back to
the manager HQ, which has persistent memory and learns. What is built is described in [`docs/legal.md`](../legal.md).
Synthetic data only; the skill stands alone with generic company context and reads none of Ezra's real files.

## What works (with the tests that prove it)

Every behaviour below has a test that was written first; where a test passed only after the code, the line says how the
failure was seen.

- **A new assistant id `legal`, title Legal Team, no phone number and no person.**
  - Migrations `20261027130000_legal_value.sql` (the enum value alone in its file) and `20261027130010_legal.sql` (its row
    in `public.assistants`, `sms_from` null). No check, function or table lists assistant ids, so nothing else needed
    widening: `door_tokens`, `session_reports`, `assistant_profiles`, `work_reports` and `recommendations` all use the enum.
  - Applied once, additively, to the shared local database with `docker exec ... psql` (`psql` is not installed in WSL) and
    recorded in `supabase_migrations.schema_migrations` as `20261027130000 legal_value` and `20261027130010 legal`.
  - Tests: `supabase/tests/migrations.test.ts` "makes the Legal Team a real assistant with no phone number, so its door
    token, its profile and its reports have a row to point at" (every migration file, in order, on an empty database), and the
    existing "lets anon run exactly the two doors" and "leaves the public roles no table privilege" still pass with it.
  - `AssistantId` (`packages/contracts/src/schemas.ts`) gains `legal`; the typecheck then listed every `Record` of assistants
    (`SERIES_DIVISIONS` in `read-tools.ts` and `brain-mcp.ts`, the front door's label in `flows.ts`, `doors.test.ts`), and the
    plain lists got it too (`store.ts` ASSISTANTS for open items, `reports.ts` ORDER for usage).
- **The skill** `packages/profiles/skills/legal/SKILL.md`, in the shape of the other five (six sections, "read-only", "You
  never", "End of work"): Green/Yellow/Red per clause with why, what to ask for instead and whether a licensed attorney must
  look; Anthropic's Legal plugin (skills `legal:contract-review`, `legal:legal-risk-assessment`, `legal:compliance`,
  `legal:nda-triage`, `legal:canned-responses`; commands `/legal:review-contract`, `/legal:triage-nda`, `/legal:vendor-check`,
  `/legal:respond`) and the commercial-legal plugin (skills `vendor-agreement-review`, `saas-msa-review`, `renewal-tracker`;
  commands `/commercial-legal:review`, `/commercial-legal:renewal-tracker`) named with their two GitHub sources, used when the
  session has them (the names were wrong in the first brief and were corrected in the review fixes below). Tests:
  `profiles.test.ts`, "the Legal Team skill" (what it reviews; the committed read; the plugins and sources; the "You never"
  rules; no phone number, email or other web address) and the loop over every skill (six sections, 48 lines at most, names
  exactly the tools the profile reads).
- **Reads: only tools with no business data.** The profile reads `recall_my_decisions` and `my_lessons`.
  `walled()` in `rows.ts` refuses, for the Legal Team, every tool whose `READ_SCOPE` is not `none`, so a stored legal profile
  that names a money, salon, online or shared tool is refused by the worker, by the door and by the manager's dry run, exactly
  like the salon/online wall. Tests: `changes.test.ts` "keeps the Legal Team to the tools that return no business data..."
  and "walls every division read by its scope" (every assistant against every tool, now including legal);
  `db-source.test.ts` (nine legal cases: the stored row is refused with "may never read"); `door.test.ts` (the door refuses to
  serve it).
- **Models per job.** `code` and `answer`, the same settings as the manager's (it plans and reviews nothing). Test:
  `profiles.test.ts` "assigns each assistant its model jobs".
- **The owner can ask it by text.** The front door's target gains `legal` and the router prompt a line for terms,
  contracts and policies; the answer is the same two steps (`legal.lookup` with `recall_my_decisions` and `my_lessons`,
  then `legal.answer`, numbers traced), prefixed `[Legal Team]`. A "plans" request routed to it is a question for it (no round).
  Department heads still ask only their own assistant, whatever the router names. Tests: `contracts/test/front-door.test.ts`,
  `worker/test/router.test.ts` "sends terms, contracts and policies to the Legal Team", `worker/test/legal.test.ts` (four
  flow tests on the real database and Meterless: the owner's question, plans routed to legal, a salon head's question routed
  to legal, a salon head's plans request).
- **Seed, token, door, report.** `scripts/seed-profiles.ts` and `scripts/issue-door-token.ts` already looked at
  `AssistantId.options`, so they store and accept `legal` with no code change (comments only). Proof on the local database:
  `doors-db.test.ts` "the Legal Team door" (the stored profile, the door's tools, the skill prompt, the report landing under
  `legal` masked and stored once per retry), "starts the Legal Team door the way a Claude Code session on a staff laptop would"
  (`serve.ts` as a program), and `worker/test/legal.test.ts` "lands under the legal assistant ... and shows in the manager's
  list_session_reports" (the manager reads it; the Legal Team reads its own door; salon, online, finance and owner do not).
  `manager.ts` is untouched: the manager already reads every door's reports.
- **Docs.** `docs/legal.md`.

### Seen failing (Law 5)

- Before the code: with `legal` in `AssistantId` and no profile for it, every profile test crashed in `loadProfiles` ("Cannot
  destructure property 'jobs' of 'SHAPES[id]'").
- After the code, each guard was taken out again and put back (`git checkout`), and the test that guards it failed:
  - the wall line in `rows.ts`: four tests failed (`changes.test.ts` twice, `db-source.test.ts`, `door.test.ts`);
  - the `target !== 'legal'` guard in `flows.ts`: `legal.test.ts` "answers a request for plans that the router sends to the
    Legal Team as a question" failed (the owner got "I couldn't get plans ..." instead of a Legal Team answer);
  - the `assistants` row in `20261027130010_legal.sql`: `migrations.test.ts` "makes the Legal Team a real assistant ..." failed.

### Verification (all under `flock ~/.fahq-db-test.lock`, 2026-10-27)

- `npm run typecheck`: clean on every commit.
- Full suite, first run: 1246 passed, 4 failed. The four counted the file profiles by hand (five) and were fixed in the last
  commit (`supabase/tests/profiles.test.ts` three seed tests, `apps/worker/test/profiles.test.ts` the start-up log line); both
  files then passed (70 tests).
- Full suite, second run (66 files, 1250 tests): 1249 passed, 1 failed:
  `apps/worker/test/manager-decides.test.ts` "lessons come from the database > reach the next Code Mode answer ..." (no
  `finance.answer` call was recorded). The file is the manager lane's, it passed in the first full run, and it passed on its own
  afterwards (36 of 36), so I read it as a flake under the afternoon's load; it is not touched by this lane, but the merge
  run should watch it.
- Local database: `legal` enum value and `assistants` row applied; `legal` profile row seeded by the doors-db test's
  `seedProfiles`; door tokens and reports made by the tests are deleted again.

## Review fixes (2026-10-27, after an independent review of this lane)

Seven findings (three major, four minor). Each fix has a test that was seen failing first. Nothing was found wrong with the
review itself; two findings are met by documenting the limit, because the code that would change is the manager lane's.

1. **Major: the skill named plugin skills that do not exist. Fixed.** I read both READMEs raw on 2026-10-27 (not a summary):
   `anthropics/knowledge-work-plugins/legal` has the skills `contract-review`, `nda-triage`, `compliance`, `canned-responses`,
   `legal-risk-assessment`, `meeting-briefing` and the commands `/review-contract`, `/triage-nda`, `/vendor-check`, `/brief`,
   `/respond`; `anthropics/claude-for-legal` `commercial-legal` has the skills `vendor-agreement-review`, `nda-review`,
   `saas-msa-review`, `renewal-tracker` and the commands `/commercial-legal:review` and `/commercial-legal:renewal-tracker`. So
   `compliance-check` and `legal-response` never existed, and `review-contract`, `triage-nda` and `vendor-check` are commands.
   The Method line now names what exists, with the plugin prefix (`legal:contract-review`, `/legal:review-contract`, ...).
   Tests: `profiles.test.ts` "names the Anthropic Legal plugin skills and commands that really exist..." (all fourteen names,
   and a check that the invented ones and the bare command names are gone; seen failing against the old skill) and
   `doors-db.test.ts` "serves the stored Legal Team profile ..." (the skill a door really serves; it failed against the stale
   stored row until the row was reseeded, which is how the stored words were proved to change). The stored `legal` row on the shared
   database was reseeded (v1 -> v2, by the seed) with a one-off that touches only `legal`: `seed-profiles.ts --force` would have
   written every assistant's file words from this branch's older files over whatever other lanes have stored.
2. **Major: a text answer for the Legal Team could not follow its own skill. Fixed by changing what is promised (option b).**
   The answer step (`askQuestion`, `ANSWER_RULES`) uses only the lookup's facts (the Legal Team's past decisions and lessons,
   almost always none) and number-traces the answer, words "one, two, three" included; "the three things to fix first" and "a
   30 day notice window" were refused twice and the owner got "Here's what I found: decisions: none; lessons: none". Now:
   the skill's closing line has no counted word, its "How you work with the others" says that a text carries no document so by
   text it recalls its own decisions and lessons, says it has not seen the document, points to a staff session at its door, and
   gives no read, count or figure; `docs/legal.md` no longer promises "general terms". Tests: `profiles.test.ts` ("keeps the
   closing call free of counted words..." and "says plainly what the Legal Team does by text..."; both seen failing) and
   `legal.test.ts` "texts the owner the facts as they are, never the model's words, when its Legal Team answer counts the fixes
   or quotes a notice period" (what the owner really receives, and the refused receipt). Option (a), answer rules of the Legal
   Team's own, needs a per-asker rules constant in `manager.ts` (`askQuestion` builds `${skill}\n\n${ANSWER_RULES}` for every
   asker), which this lane may not touch; the merge can add it (see "What the merge must know").
3. **Major: the learning loop was proven only up to `list_session_reports`. Fixed (test) and flagged (prompt).** One end-to-end
   test, `legal.test.ts` "the loop: a Legal Team session reports, the HQ Manager reviews, ...": a report filed through the real
   legal door function; the owner asks for REVIEW; the (scripted) review recommends a lesson for `legal`; reading the report
   changes nothing; `ADOPT 1 <code>` writes a version made by the owner for `legal` only; the next door session's skill has the
   lesson under the owner's heading; the next text answer's lookup and wording carry it; the salon's skill does not. The profile
   tables are in memory (a real version can never be taken back, the pattern `manager-decides.test.ts` uses), so the last hop on a
   real table is `supabase/tests/profiles.test.ts` "hands the Legal Team's next session the lesson the owner adopted" (a version
   made by the owner on a throwaway database, then `door_profile` for a legal token returns it). Not changed here:
   `REVIEW_RULES` in `manager.ts` still lists `owner|finance|salon|online|manager` for findings; add `|legal` at the merge (the
   program accepts a `legal` recommendation already, which the test shows).
4. **Minor: contract notice addresses were not masked in door reports. Fixed.** `public.redact_text` (migration
   `20261027130020_redact_email.sql`, applied once to the shared local database and recorded) and `maskContactDetails` in
   `packages/contracts/src/redact.ts` mask an email address as `[email]`, before the phone and code shapes, so the digits in
   `user123456@example.com` are not read as a code. `maskPhonesAndCodes` (the lesson rules, the read tools) is unchanged. A
   name cannot be found by a pattern and is not masked: the skill's rule against a party's name and contact details stands.
   Tests: `contracts/test/redact.test.ts` (`EMAIL_SAMPLES` and the plain-masks-unchanged check), `supabase/tests/profiles.test.ts`
   (the same strings through the stack's `redact_text`, through `maskContactDetails`, and through a scratch database built from the
   migration files, including the new one), `doors-db.test.ts` "files a Legal Team report under legal, masked ..." (an address in the summary).
5. **Minor: the "never write ... health or hair" rule was wider than the brief. Fixed.** It now reads "anything medical, or about
   a person's health or hair loss ... Cutting, styling and matching a client's hairpiece is ordinary policy and in scope", so the
   personalization policy can be reviewed. Test: `profiles.test.ts` "forbids anything medical or about hair loss, and still
   covers the company's own personalization policy".
6. **Minor: the staff setup left out the checkout and the token's journey. Fixed (docs only).** `docs/legal.md` step 0 to 3: she needs
   a checkout with `npm install`; `serve.ts` loads that checkout's `.env.local` (public address and anon key only); the token is
   issued by the owner and moved over a secret channel, or set as `FAHQ_DOOR_TOKEN`; the MCP config uses absolute paths.
7. **Minor: the Admin console knows nothing of `legal`. Not done, by the finding's own advice** (follow up after the console lane
   merges): add a Legal Team tab to `DEPARTMENTS`, the loader's id check and `LIVE_ASSISTANTS`, and update the console tests that
   assert the five-assistant lists.

## What is not done

- **No Legal Team tab in the Admin console.** `apps/console` (`DEPARTMENTS`, `LIVE_ASSISTANTS`, the loader's id check and
  the page's names) lists five assistants and its tests assert exactly those lists; another lane changed the console, so I left it. The
  console's loader throws "unknown department" for `legal`. A Legal Team tab is a small follow-up.
- The Legal Team's work through a door is not visible in `work_reports` (those are the worker's tasks); it shows in
  `session_reports` and, by text, in the receipts of the owner's task (`legal.lookup`, `legal.answer`).
- A text cannot carry a document, so by text the Legal Team reads nothing: it recalls its own decisions and lessons, says it has
  not seen the document, and points to a door (review fix 2). Reading a document is a door job. By text the owner currently gets
  little when the Legal Team has no decisions or lessons yet; better wording needs the per-asker answer rules below.
- The Anthropic plugins are installed in the staff member's own session; HQ does not load them. The skill works without them.

## What the merge must know

- **Migrations:** two new files (`20261027130000`, `20261027130010`); on any database that has not had them, apply them in order
  and separately (the enum value has to be committed before the row that uses it). The shared local stack has them.
- **Migrations, third file:** `20261027130020_redact_email.sql` (review fix 4) replaces `public.redact_text` only; apply it after the
  other two (it needs nothing from them). It is on the shared local database, recorded in `schema_migrations`. Check that no other
  lane also redefines `redact_text` (the later file wins). `supabase/tests/profiles.test.ts` lists it in `MIGRATIONS`.
- **Reseed:** `npx tsx scripts/seed-profiles.ts` (no `--force`) stores the `legal` row on a database that has none; no other row changes.
  On a database that already holds the v1 `legal` row (the shared local one did), the row carries the OLD plugin names until it is
  reseeded: run `--force` once at the merge from the merged tree (it writes every assistant's file words as a new version and keeps
  lessons, manager notes and what the owner approved). On the shared local database only `legal` was reseeded (v2), by a one-off.
- **Merge edits that belong to the manager lane's file (`apps/worker/src/manager.ts`):**
  1. `REVIEW_RULES` rule 1: add `|legal` to `"assistant":"owner|finance|salon|online|manager"` (findings). Without it a real review
     model is never told the Legal Team exists, although a `legal` recommendation is accepted and applied (see the loop test).
  2. Optional, for a better text answer: a rules constant per asker, e.g. `ANSWER_RULES_LEGAL` used by `askQuestion` when
     `asker === 'legal'`: general guidance from the skill allowed; no figure, deadline or citation that is not in the facts;
     always "I have not seen the document; this is not legal advice". Keep `numberTrace`. Add a test beside the
     "texts the owner the facts as they are" test in `legal.test.ts`, which then changes.
- **Console (`apps/console`):** `legal` is not in `DEPARTMENTS`, the loader's id check or `LIVE_ASSISTANTS` (`shape.ts`); the loader
  throws "unknown department" for it. Add a Legal Team tab after the console lane merges, and update the console tests that assert
  the five-assistant lists. (`apps/console/src/divisions.ts` was not touched, as told.)
- **Touched outside the lane, minimally:** `supabase/tests/profiles.test.ts` (the two scratch databases it builds list the
  assistant enum by hand; each gained `'legal'`), `scripts/revert-profile.ts` (the usage line), `apps/worker/src/flows.ts`
  (the owner's label and the plans guard), `apps/worker/src/read-tools.ts` and `packages/codemode/src/brain-mcp.ts`
  (`SERIES_DIVISIONS`, and the assistant names in the read tools' signatures), `apps/worker/src/store.ts` and `reports.ts`
  (the plain lists), and the tests that mirror them (`doors.test.ts`, `store.test.ts`, `changes.test.ts`, `db-source.test.ts`).
- **Merge conflicts to expect:** any lane that adds a line to `AssistantId`-keyed lists or to `profiles.test.ts` expectations
  ("five file profiles", `fromFiles`, `jobs(...)`), and the router prompt.
- **Running the worker tests in a worktree:** the worktree has no `.local/meterless`; set `METERLESS_DIR` to a checkout that
  has it. Run every database-backed file under `flock ~/.fahq-db-test.lock`.
