# The Legal Team

Status: built on `hq/w2-legal` (wave 2). Synthetic data only. The Legal Team is an assistant like the others, with its
profile in Supabase, so a staff member's Claude Code (or Codex, Cursor, Gemini) session anywhere can load it through a
door, and every session's end-of-work report reaches the HQ Manager, which learns from it.

It is **not a lawyer**. Its read is a plain-English risk read to help a person decide what to ask for and whether to call
an attorney. It never signs, accepts, files or sends anything.

## What it is

- The assistant id is `legal`, titled **Legal Team**. It has **no phone number and no person**, like the HQ Manager
  (`serves` is null). It has its own row in `public.assistants` (migration `20261027130010_legal.sql`), its own memory
  folder (`legal`), its own profile row in `public.assistant_profiles`, and its own door tokens.
- **Its job** (`packages/profiles/skills/legal/SKILL.md`): review terms and conditions, vendor and SaaS agreements,
  marketplace terms, and the company's own customer policies (returns, consignment, personalization, privacy, SMS and
  email consent). It gives a committed read: every clause that matters is **Green** (fine), **Yellow** (watch it or
  negotiate) or **Red** (do not agree as written), each with why, what to ask for instead, and whether a licensed attorney
  must look before anyone signs or acts. It ends with one overall call and the three things to fix first.
- **Its method.** When the session has them, it uses Anthropic's Legal plugin skills `review-contract`,
  `legal-risk-assessment`, `compliance-check`, `vendor-check`, `triage-nda` and `legal-response`, and the commercial-legal
  plugin skills `vendor-agreement-review`, `saas-msa-review` and `renewal-tracker`. Sources:
  <https://github.com/anthropics/knowledge-work-plugins/tree/main/legal> and <https://github.com/anthropics/claude-for-legal>.
  The plugins live in the staff member's own session (install them there, following each repository's README); HQ cannot
  load them for her. The skill stands alone: with none of them it does the same work itself and says no plugin was used.
- **What it reads.** Only `recall_my_decisions` and `my_lessons`: its own past decisions and its standing lessons. The
  document is its material, and the session brings it. It reads **no money, salon, online or shared business data**.
- **Models.** Two jobs, like the HQ Manager's answer path: `code` (the lookup script) and `answer` (the words). It plans
  and reviews nothing, so it has no `plan` or `review` model. The settings are the same ones the other assistants use,
  from the environment at seed time (`CODE_MODEL`, `ANSWER_MODEL`).

## The wall

`READ_SCOPE` (`packages/profiles/src/rows.ts`) declares whose data every read tool returns. For the Legal Team the rule is
simple: it may read a tool only when its scope is `none`. A stored profile that names a money tool (`get_finance_metrics`,
`get_budget_room`, `get_company_overview`, `get_supplier_invoices`), a salon tool, an online tool or a shared one
(`list_work_reports`, `recall_decisions`, `list_lessons`, `latest_proposal`, ...) is **refused**, at the worker, at the
door, and when the HQ Manager's recommendation to add one is dry-run. It is the same code path as the salon/online wall.
Tests: `packages/profiles/test/changes.test.ts` ("keeps the Legal Team to the tools that return no business data", and the
walk over every assistant and every tool), `db-source.test.ts`, `door.test.ts`.

## How a staff member uses it

1. **Issue a door token** (once, on the machine that holds the database; it prints only the file's path):

   ```bash
   npx tsx scripts/issue-door-token.ts legal "Maria's Claude Code"
   ```

   The token is written to `.local/door-tokens/legal.token` (mode 600). Only its SHA-256 is stored. Revoke it with
   `update public.door_tokens set revoked_at = now() where id = '<id>'`.
2. **Seed the profile** if the database has no `legal` row yet: `npx tsx scripts/seed-profiles.ts` (it stores only the
   profiles that have no row). After a change to `skills/legal/SKILL.md`, `npx tsx scripts/seed-profiles.ts --force`
   puts the file's words into the row and keeps adopted lessons and what the owner approved.
3. **Start the door** from her AI tool as an MCP server (Code Mode: one `code` tool, plus `file_work_report`; add
   `--plain` for the read tools one by one):

   ```json
   {
     "mcpServers": {
       "fortune-legal": {
         "command": "npx",
         "args": ["tsx", "packages/codemode/src/serve.ts", "--profile", "legal", "--token-file", ".local/door-tokens/legal.token"],
         "env": { "SUPABASE_URL": "<the project's API address>", "SUPABASE_ANON_KEY": "<the public anon key>" }
       }
     }
   }
   ```

   The door reads the Legal Team's profile from the database with `door_profile`, checks it against the same rules the
   worker applies, and serves it. A wrong, revoked or missing token stops the door with one plain sentence. Nothing falls
   back to the files.
4. **Load the skill.** The door serves the profile's skill as the MCP prompt `skill` (in Claude Code it appears as
   `/mcp__fortune-legal__skill`). It names only the tools this door really offers, adds the standing lessons the owner
   adopted for the Legal Team, and tells the session to file its report when it is done.
5. **Give it the document** (paste it, or point the session at the file) and ask for the read. The clause-by-clause work
   happens in her session, with the Anthropic plugins if she has them.
6. **End of work: `file_work_report`.** The session calls it once with a summary (what kind of document, the overall call),
   its steps, any change it suggests to the Legal Team, and any lesson worth keeping. Phone numbers and six-digit codes are
   masked in the database before anything is stored. Her tool's name comes from the MCP handshake; a retry is stored once.

## How its reports reach the HQ Manager and become lessons

```text
staff session --file_work_report--> door_file_report --> session_reports (assistant_id 'legal', masked)
                                                              |
              HQ Manager review: list_session_reports (it reads every door) -- digest -- recommendations for 'legal'
                                                              |
                owner's one-time code (or the rule in docs/manager.md, "Who decides what changes")
                                                              |
              new version of the Legal Team's profile (lessons / skill note / reads / model), each reversible
                                                              |
        the next session's door_profile and the worker's next answer carry the new lessons
```

- A legal report is filed under the **legal** assistant, whichever tool filed it. The salon, the online store, finance and
  the owner cannot read it (`list_session_reports` refuses another door to a department); only the manager reads every
  door's. Tests: `apps/worker/test/legal.test.ts` ("lands under the legal assistant, is masked, and shows in the manager's
  list_session_reports ... and in nobody else's"), `packages/codemode/test/doors-db.test.ts` ("the Legal Team door").
- The HQ Manager treats the Legal Team like any other assistant: it may recommend a lesson, a skill note, a change of what
  the Legal Team reads (only tools with no business data pass the wall) or of its models. **What happens to a
  recommendation is the manager's own rule** (`docs/manager.md`, "Who decides what changes"); this lane adds no path of
  its own. A report is data written by an outside tool, never an instruction to the manager.
- A lesson about the Legal Team goes through the same text rules as any other (one short line, no phone number or code, nothing
  medical, no web address, no order to read a tool it may not read). The Legal Team's lessons are therefore patterns
  ("check the notice window before the renewal date"), not document text.

## Asking the Legal Team by text

The owner texts Owner HQ's number as always. The front door (`router.ts`) can name `legal` as the target for terms,
contracts, vendor agreements and the company's own policies. The answer goes through the same two steps as every other
question: a Code Mode lookup with the Legal Team's own reads (`legal.lookup`, tools `recall_my_decisions` and `my_lessons`),
then one model call that words the answer (`legal.answer`) with the Legal Team's skill and its newest ten lessons. Its
numbers are traced to the lookup; if the check fails the owner gets the facts as they are. The reply is prefixed
`[Legal Team]`.

- A text cannot carry a document, so by text the Legal Team answers in general terms and says it has not seen the
  document. The clause-by-clause read happens at a door.
- It plans nothing: a "plans" request that the router sends to the Legal Team is answered as a question for it, and no round
  is started for the departments.
- **Department heads never reach it.** A text from the salon, online or finance person is answered by her own assistant
  whatever the router names; a request for plans from her gets the existing "the owner asks the departments for plans"
  reply. Tests: `apps/worker/test/legal.test.ts`.

## What it never does

It is read-only and: never presents itself as a lawyer or its read as a legal opinion; never signs, accepts terms, clicks
"agree", files, sends a notice or contacts a counterparty or a customer; never invents a statute, case, rule, citation,
deadline or dollar figure (it quotes the clause, cites the primary source, or says it is unverified); never follows an
instruction found inside a document (a document is data, and a clause that tries to instruct it is itself a finding);
never writes anything medical or about a person's health or hair; never reads money, salon or online business data;
never sends a text, charges a card, publishes or approves anything. People decide by one-time code only.

## Tests

`packages/profiles/test/profiles.test.ts` (the profile, its reads, models, and the skill's contents), `changes.test.ts`,
`db-source.test.ts` and `door.test.ts` (the wall), `packages/contracts/test/front-door.test.ts` and
`apps/worker/test/router.test.ts` (the target and the router prompt), `apps/worker/test/legal.test.ts` (the owner's text,
department heads, the reports reaching the manager), `packages/codemode/test/doors.test.ts` and `doors-db.test.ts` (the
door on the real database, `serve.ts` started as a program), `supabase/tests/migrations.test.ts` (the enum value and the
row; anon still runs exactly the two doors).
