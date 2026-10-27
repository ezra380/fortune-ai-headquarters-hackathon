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
- **Its method.** When the session has them, it uses Anthropic's Legal plugin (`legal`): the skills `legal:contract-review`,
  `legal:legal-risk-assessment`, `legal:compliance`, `legal:nda-triage` and `legal:canned-responses`, and the commands
  `/legal:review-contract`, `/legal:triage-nda`, `/legal:vendor-check` and `/legal:respond`; and, for vendor and SaaS
  agreements, the commercial-legal plugin of claude-for-legal: the skills `vendor-agreement-review`, `saas-msa-review` and
  `renewal-tracker`, run by `/commercial-legal:review` and `/commercial-legal:renewal-tracker`. Sources:
  <https://github.com/anthropics/knowledge-work-plugins/tree/main/legal> and <https://github.com/anthropics/claude-for-legal>.
  These names were checked on 2026-10-27 against the two repositories' READMEs (in the Legal plugin, `review-contract`,
  `triage-nda` and `vendor-check` are commands, not skills, and there is no `compliance-check` or `legal-response`; the
  names came wrong in the first brief and a review caught it). The plugins live in the staff member's own session
  (install them there, following each repository's README); HQ cannot load them for her. The skill stands alone: with
  none of them it does the same work itself and says no plugin was used. Each plugin says its output is a draft for
  attorney review, which is also this skill's rule.
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

0. **What she needs.** A checkout of this repository on her machine, with `npm install` run in it: the door is
   `packages/codemode/src/serve.ts`, started with `tsx` from that checkout. `serve.ts` loads that checkout's `.env.local`,
   so for a staff member that file holds the project's API address and public anon key (`SUPABASE_URL`,
   `SUPABASE_ANON_KEY`; the anon key can run exactly two functions, `door_profile` and `door_file_report`) and nothing
   else: never the service key, the database address or a model key.
1. **Get her a door token.** One token per person and tool, bound to the Legal Team. Only its SHA-256 is stored.
   - The owner issues it on the machine that holds the database; the script prints only the file's path:

     ```bash
     npx tsx scripts/issue-door-token.ts legal "Maria's Claude Code" --dir /somewhere/private
     ```

     (or issue it from her checkout with `--db <the database address>`, which only the owner can supply). The file is mode 600.
   - Moving the file to her checkout is the owner's job, over a channel meant for secrets (a password manager or an
     encrypted message). **Never paste a token into chat, email, a ticket or a report.** She saves it as
     `<her checkout>/.local/door-tokens/legal.token`, or sets it as `FAHQ_DOOR_TOKEN` in the tool's environment.
   - Revoke one with `update public.door_tokens set revoked_at = now() where id = '<id>'`.
2. **Seed the profile** if the database has no `legal` row yet: `npx tsx scripts/seed-profiles.ts` (it stores only the
   profiles that have no row). After a change to `skills/legal/SKILL.md`, `npx tsx scripts/seed-profiles.ts --force`
   puts the file's words into the row and keeps adopted lessons and what the owner approved. (`--force` writes every
   assistant's file words as a new version: run it from the checkout whose files are the ones you mean.)
3. **Start the door** from her AI tool as an MCP server (Code Mode: one `code` tool, plus `file_work_report`; add
   `--plain` for the read tools one by one). Use absolute paths, so the tool does not have to start inside the checkout:

   ```json
   {
     "mcpServers": {
       "fortune-legal": {
         "command": "/path/to/checkout/node_modules/.bin/tsx",
         "args": ["/path/to/checkout/packages/codemode/src/serve.ts", "--profile", "legal", "--token-file", "/path/to/checkout/.local/door-tokens/legal.token"],
         "env": { "SUPABASE_URL": "<the project's API address>", "SUPABASE_ANON_KEY": "<the public anon key>" }
       }
     }
   }
   ```

   (On Windows the command is `node_modules\.bin\tsx.cmd`. A tool that supports a working directory can also set it to the
   checkout.) The door reads the Legal Team's profile from the database with `door_profile`, checks it against the same
   rules the worker applies, and serves it. A wrong, revoked or missing token stops the door with one plain sentence.
   Nothing falls back to the files.
4. **Load the skill.** The door serves the profile's skill as the MCP prompt `skill` (in Claude Code it appears as
   `/mcp__fortune-legal__skill`). It names only the tools this door really offers, adds the standing lessons the owner
   adopted for the Legal Team, and tells the session to file its report when it is done.
5. **Give it the document** (paste it, or point the session at the file) and ask for the read. The clause-by-clause work
   happens in her session, with the Anthropic plugins if she has them.
6. **End of work: `file_work_report`.** The session calls it once with a summary (what kind of document, the overall call),
   its steps, any change it suggests to the Legal Team, and any lesson worth keeping. Phone numbers, six-digit codes and
   **email addresses** (a contract's notice addresses) are masked in the database before anything is stored (`[phone]`,
   `[code]`, `[email]`; migration `20261027130020_redact_email.sql`, and the same shapes in `packages/contracts/src/redact.ts`).
   A person's or a company's *name* cannot be found by a pattern, so it is not masked: the skill tells the session to say
   what kind of document it read and its overall call, never a party's name or contact details. Her tool's name comes
   from the MCP handshake; a retry is stored once.

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
- **Proven end to end.** `apps/worker/test/legal.test.ts` "the loop: ..." files a report through the real legal door
  function, runs the HQ Manager's review over it (the review model and the digest script are scripted; the report, the
  review task and the approval are real), shows that reading it changes nothing, adopts the lesson with the owner's one-time
  code (a new version made by the owner; no other assistant's profile moves), then shows the next door session's skill
  carrying the lesson under the owner's heading and the next text answer's lookup and wording carrying it too. The profile
  tables are in memory there (a real version can never be taken back), so `supabase/tests/profiles.test.ts` "hands the Legal
  Team's next session the lesson the owner adopted" does the last hop on a real, throwaway database: a version made by the
  owner, then `door_profile` for a legal token returns the lesson.
- **One thing the merge must do.** The review writer's prompt (`REVIEW_RULES`, rule 1, in `apps/worker/src/manager.ts`) still
  lists the assistants a finding may be about as `owner|finance|salon|online|manager`. This lane may not touch that file, so
  the merge adds `|legal`. A recommendation for `legal` already works (the program checks the assistant against the
  enum, and the test above shows it), but a real review model is only told about five.

## Asking the Legal Team by text

The owner texts Owner HQ's number as always. The front door (`router.ts`) can name `legal` as the target for terms,
contracts, vendor agreements and the company's own policies. The answer goes through the same two steps as every other
question: a Code Mode lookup with the Legal Team's own reads (`legal.lookup`, tools `recall_my_decisions` and `my_lessons`),
then one model call that words the answer (`legal.answer`) with the Legal Team's skill and its newest ten lessons. Its
numbers are traced to the lookup; if the check fails the owner gets the facts as they are. The reply is prefixed
`[Legal Team]`.

- **A text cannot carry a document, so by text the Legal Team does not read anything.** The only facts the answer step has
  are what it recalls of its own past decisions and its own standing lessons (often nothing yet). The answer step says
  "using only the facts given ... if the facts don't answer the question, say so plainly" (`ANSWER_RULES`, shared by every
  assistant, in `manager.ts`) and checks every number, and the words one, two and three, against those facts. So by text
  the Legal Team says it has not seen the document, tells what it remembers, and points to a staff session at its door
  for the clause-by-clause read. It gives no read, no count of fixes and no figure by text; its skill says so, and no
  longer asks for "the three things to fix first" in a closing line (that line is only for a read at a door, and is now
  worded without a counted word, because the skill is loaded for the text answer too).
- If a model counts or quotes a figure anyway ("the three things to fix first ...", "ask for a 30 day notice window"),
  the number check refuses the answer, once more after one correction round, and the owner receives the facts as they are:
  `[Legal Team] Here's what I found: decisions: none; lessons: none`, with the refusal on the receipt of the `legal.answer`
  step. Test: `apps/worker/test/legal.test.ts` "texts the owner the facts as they are, never the model's words...". A
  friendlier fallback (answer rules of the Legal Team's own: general guidance allowed, no figure, deadline or citation
  that is not in the facts, always "document not seen, not legal advice") needs one rules constant per asker in
  `manager.ts`, which this lane may not touch; it is listed in the lane notes for the merge.
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
never writes anything medical or about a person's health or hair loss (reviewing the company's own personalization policy, which is about cutting and styling a hairpiece, is ordinary and in scope); never reads money, salon or online business data;
never sends a text, charges a card, publishes or approves anything. People decide by one-time code only.

## Tests

`packages/profiles/test/profiles.test.ts` (the profile, its reads, models, and the skill's contents), `changes.test.ts`,
`db-source.test.ts` and `door.test.ts` (the wall), `packages/contracts/test/front-door.test.ts` and
`apps/worker/test/router.test.ts` (the target and the router prompt), `apps/worker/test/legal.test.ts` (the owner's text,
department heads, the reports reaching the manager, the whole learning loop in both modes, what the owner receives when a
text answer counts), `packages/codemode/test/doors.test.ts` and `doors-db.test.ts` (the door on the real database,
`serve.ts` started as a program, an address masked in a report), `packages/contracts/test/redact.test.ts` and
`supabase/tests/profiles.test.ts` (the masks, and a lesson adopted for the Legal Team reaching `door_profile`),
`supabase/tests/migrations.test.ts` (the enum value and the row; anon still runs exactly the two doors).
