# Lane notes: briefs (`hq/div-brief`)

Lane: each division manager's brief to its head, the cross-division data requests, and the CEO digest.
Base: `hq/foundation` at `bb29578`. Design: [../divisions.md](../divisions.md).

## Slice 1: briefs core (done)

### What works (tests)

`apps/worker/test/brief.test.ts` (no database):
- `divisionData`: slices the finance read by business when the port has no division read; uses the port's division read and
  its attention; says so, with a failed receipt, when the data is missing, empty, unreadable or for another division.
- `statusOf`: act beats watch beats normal.
- `parseNeeds`: one question per other division, at most two; drops itself, `hq`, invalid items.
- `checkBrief`: untraced number, number words, unknown cited id (but ids inside a reply are known), duplicate ranks, sizes,
  salon number next to an online number (including a salon fact from a reply), medical words, a status from the model is
  dropped.
- `fallbackBrief`: marked, only attention and metric labels/values, passes the schema and the number trace.
- `briefSms`: fits one message and keeps its tail; says when a program wrote the brief.
- `isLiveNumber`, `briefKey`, the `APPROVE` command and its near misses, the `DivisionBrief` sizes.

`apps/worker/test/brief-flow.test.ts` (real local Supabase and Meterless; models, Code Mode and the data port scripted):
- happy path: status from the attention rules, one needs call and one brief call, the text with the code, the printout,
  the CEO line, a receipt per step.
- a cross-division request is answered by the target's own skill, model and tools (not the asker's), as a keyed mailbox
  reply, and is recorded in the World Model.
- an unavailable answer is stored as such and the writer is told; a failed script is a plain reason.
- an untraced number is corrected once, then refused into the marked rule-written fallback; one that passes on the
  correction round is the model's brief; an unreachable writer also falls back, with a failed receipt.
- a task that runs again reuses everything: no model asked twice, one approval, one text, the first code still works and
  a later made-up code does not.
- resumes after a failure while sending the code, and after a failure before the brief was saved (needs and replies reused).
- no text when the assistant has no number, or a `+1555` placeholder, with a `brief.sms` receipt; a brief with no actions
  is texted without a code.
- an unreadable needs answer means no questions (refused receipt); an unreachable needs model stops the task.
- the numbers cannot be read: failed task, failed receipt, no brief. Wrong assistant, unknown division, bad date.
- `enqueueBrief` queues once; the database refuses a brief key that does not match its division and day.
- `APPROVE`: records the decision once, a plain "yes" decides nothing, a code with the wrong command word stays usable,
  a rank the brief lacks records nothing, only the head the code was issued to can use it.

I checked that these tests fail without the guards: reusing the stored brief, the needs note and the reply; treating a
placeholder number as live; trusting a model status; reading the asker's tools instead of the target's.

### What is not done (next slices)

- `scheduler.ts`: nothing queues the briefs each morning yet (`enqueueBrief` is ready); `main.ts` is untouched.
- `digest.ts`: the CEO digest (the very short "things are running normally" summary for the owner, built from the
  `division_status` rows) and its text.
- The console Divisions view (`apps/console`).
- A mailbox route for a `data_request` posted by something other than a brief (the answering function is internal to
  `brief.ts` for now).
- A PDF for the printout: `outbox.ts` skips a `brief:` attachment ("printing is not connected").
- The HQ Manager does not read briefs yet; `reports.ts` does not raise a "needed a correction round" suggestion for
  `brief.write` (it does for plans, reviews and picks).

### What the merge must know

- **Migration** `supabase/migrations/20261027100100_division_briefs.sql`: new table `division_briefs`; widens the
  `approvals_action_check` and re-creates `issue_approval` and `use_approval_code` with the live bodies from
  `20261027000100_manager.sql` plus `'approve_action'`. If another lane also re-creates these two functions to add its own
  action, keep one definition with every action in the list. It was applied once to the shared local database with psql.
- **Contracts**: `BriefStatus`, `DataRequest`, `DivisionBrief` appended to `packages/contracts/src/schemas.ts`.
- **Outside the lane's own files (minimal):**
  - `packages/profiles/skills/{finance,online,salon}/SKILL.md`: a "Your brief" section appended at the end (the profiles
    lane may also edit these files: keep both).
  - `apps/worker/src/store.ts`: `ApprovalAction` gains `approve_action`; new methods `saveDivisionBrief`,
    `divisionBriefByKey`, `divisionBrief`.
  - `apps/worker/src/flows.ts`: the `division_brief` scheduled route, the `approve` command, and the wrong-command replies
    for an `approve_action` code.
  - `apps/worker/src/commands.ts`: the `APPROVE <1-3> <code>` command and its near-miss rules; the hint text gained APPROVE.
- **Known gap in a file this lane does not own:** `manager.ts` (`adoptChanges`) answers an `approve_action` code presented
  with `ADOPT` as "a decision: reply CONFIRM or DECLINE". Nothing is adopted and the code stays usable, but the sentence
  is wrong; one line in `manager.ts` fixes it (use `BRIEF_CODE_FOR` from `brief.ts`).
- **No env vars** are required. Optional: `NEEDS_MAX_TOKENS`, `BRIEF_MAX_TOKENS`.
- **Shared test database:** other tests reset the queue and the outbox globally; mine settle only their own rows and read
  texts and codes from memory, because a flush by another test blanks a code at any moment.
- **Full suite on 2026-10-27 (08:00 ET), three lanes testing at once:** `npm run typecheck` is clean and every brief test
  passes (`brief.test.ts` 27, `brief-flow.test.ts` 22, repeated three times). Two failures are not from this lane:
  - `supabase/tests/db.test.ts`, the two "public (anon) role" tests, fail every time on this local database: the `anon`
    role has no table grants at all (not even on `tasks`), so the test gets "permission denied" instead of zero rows.
  - `chain.test.ts`, `departments.test.ts`, `manager.test.ts` and `store.test.ts` failed in some full runs and passed alone
    (manager 25, departments 24, store 8, chain 11 in three of four runs): they claim whatever is queued in the shared
    database, including another lane's tasks. Run them when the other lanes are quiet before trusting a red.
