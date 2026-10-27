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
  look; Anthropic's Legal plugin skills (`review-contract`, `legal-risk-assessment`, `compliance-check`, `vendor-check`,
  `triage-nda`, `legal-response`) and the commercial-legal plugin (`vendor-agreement-review`, `saas-msa-review`,
  `renewal-tracker`) named with their two GitHub sources, used when the session has them. Tests: `profiles.test.ts`, "the Legal
  Team skill" (what it reviews; the committed read; the plugins and sources; the "You never" rules; no phone number, email or
  other web address) and the loop over every skill (six sections, 48 lines at most, names exactly the tools the profile reads).
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

## What is not done

- **No Legal Team tab in the Admin console.** `apps/console` (`DEPARTMENTS`, `LIVE_ASSISTANTS`, the loader's id check and
  the page's names) lists five assistants and its tests assert exactly those lists; another lane changed the console, so I left it. The
  console's loader throws "unknown department" for `legal`. A Legal Team tab is a small follow-up.
- The Legal Team's work through a door is not visible in `work_reports` (those are the worker's tasks); it shows in
  `session_reports` and, by text, in the receipts of the owner's task (`legal.lookup`, `legal.answer`).
- A text cannot carry a document, so by text it answers in general terms. Reading a document is a door job.
- The Anthropic plugins are installed in the staff member's own session; HQ does not load them. The skill works without them.

## What the merge must know

- **Migrations:** two new files (`20261027130000`, `20261027130010`); on any database that has not had them, apply them in order
  and separately (the enum value has to be committed before the row that uses it). The shared local stack has them.
- **Reseed:** `npx tsx scripts/seed-profiles.ts` (no `--force`) stores the `legal` row; no other row changes.
- **Touched outside the lane, minimally:** `supabase/tests/profiles.test.ts` (the two scratch databases it builds list the
  assistant enum by hand; each gained `'legal'`), `scripts/revert-profile.ts` (the usage line), `apps/worker/src/flows.ts`
  (the owner's label and the plans guard), `apps/worker/src/read-tools.ts` and `packages/codemode/src/brain-mcp.ts`
  (`SERIES_DIVISIONS`, and the assistant names in the read tools' signatures), `apps/worker/src/store.ts` and `reports.ts`
  (the plain lists), and the tests that mirror them (`doors.test.ts`, `store.test.ts`, `changes.test.ts`, `db-source.test.ts`).
- **Merge conflicts to expect:** any lane that adds a line to `AssistantId`-keyed lists or to `profiles.test.ts` expectations
  ("five file profiles", `fromFiles`, `jobs(...)`), and the router prompt.
- **Running the worker tests in a worktree:** the worktree has no `.local/meterless`; set `METERLESS_DIR` to a checkout that
  has it. Run every database-backed file under `flock ~/.fahq-db-test.lock`.
