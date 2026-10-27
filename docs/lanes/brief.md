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

### What was not done in slice 1 (slice 2 did the first two; see below for the rest)

- `scheduler.ts` and `digest.ts` (done in slice 2).
- The console Divisions view (`apps/console`): slice 3.
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

## Slice 2: APPROVE with several ranks, BRIEF, the CEO digest, the daily clock (done)

Design: [../divisions.md](../divisions.md).

### What works (tests)

`apps/worker/test/brief.test.ts` (no database, now 30):
- `APPROVE <ranks> <code>` reads ADOPT's grammar (ranks 1-3, each once, spaces or commas, sorted); repeated ranks, a missing
  or short code, a second command, a stray separator, full-width digits and a command inside a longer text are not
  approvals; the hint names the several-ranks form. `BRIEF` is read exactly, and a request that mentions a brief goes on to
  the router. The brief key can carry the id of the text that asked for it.

`apps/worker/test/digest.test.ts` (no database, 25):
- the digest text: fixed order, a normal division is one fixed sentence (its own words are not repeated), `watch` and
  `act` carry the division's CEO line, "no report yet", an unreadable report, the newest report of a division wins, no
  digits except the date and the CEO lines, never more than 480 characters, a short line keeps all it needs and the long
  ones share the rest, the same text every time.
- `clipWords`: a number is kept whole or left out, never cut; the result ends on a whole word and is never over the room.
- `easternClock`: summer and winter time, the evening before UTC moves on, the hour that repeats, New Year.
- the schedule: 08:00 and 08:30 New York time, nothing earlier, a missed job still queued within four hours and not after,
  a lane's own job added to the table, `FAHQ_SCHEDULE=off`.
- `runDueJobs` / `startScheduler`: each job once a day however often it is asked, a failed job tried again while the
  others go on, a receipt for each, a receipt that cannot be written is logged, a beat that fails is logged, `stop()`.

`apps/worker/test/digest-flow.test.ts` (real local Supabase and Meterless; models, Code Mode and the data port scripted, 16):
- the owner's BRIEF queues three runs keyed `brief:<division>:<date>:<task id>`, a retried text queues no more, the digest
  is queued by the third report and by nobody before it, each head gets her brief, the digest text is exactly the
  expected lines, one text and one stored row however often it runs.
- the same BRIEF and the same digest handled twice at once: three runs, one text, one row.
- a head's BRIEF asks for her own brief only and queues no digest; a second BRIEF the same day is a new brief with its own
  code, and the owner's STATUS shows the later status; a person who is neither owner nor head starts nothing.
- the 08:30 clock queues the three briefs and the digest once (a second clock queues nothing more); the digest with only the
  salon in says "no report yet" for the others; the later reports neither queue nor send a second digest; STATUS shows them.
- the third scheduled report queues the day's digest and the 08:30 clock finds it there.
- no live number for the owner assistant: no text, a refused `digest.send` receipt; STATUS still answers. A division head's
  STATUS is still the open-items count.
- bad payloads (a digest job for another assistant or with a bad date, a brief job whose request is not an id).
- the database accepts a brief key with the asking text's id and refuses any other ending.
- `APPROVE 1 3 <code>`: both actions in the division's memory (one memory each), the World Model (each action is an item
  with its title, cited metrics and the head's approval) and the HQ Manager's mailbox; action 2 untouched; the spent code
  does nothing; two texts with the same code at once record once; a rank the brief lacks is named and not recorded; none of
  the ranks existing records nothing; the text tells the head that several actions can be approved with one code.

I checked that these tests fail without the guards: the digest queued by the third report, one memory per brief instead
of per action, the owner's STATUS, BRIEF runs keyed by the text, the digest never shortened, the late-job limit, APPROVE
recording only the first rank.

### What is not done

- The console Divisions view (`apps/console`): slice 3.
- BRIEF has no rate limit: each text from the owner is three briefs (six model calls and three texts to the heads).
- The scheduler runs only in the worker's normal mode, not with `--once`.
- The Manager's daily review job is not in `SCHEDULE` (the manager lane adds it at the merge).
- The digest is only texted; no printout.
- Items listed as not done in slice 1 (brief printout PDF, the HQ Manager reading briefs, the `brief.write` suggestion).

### What the merge must know

- **Second migration** `supabase/migrations/20261027100110_division_brief_runs.sql`: the `division_briefs_check` constraint
  now also accepts `brief:<division>:<date>:<uuid>` (a BRIEF run). Additive; applied once to the shared local database with a
  small script (there is no `psql` in WSL), after `20261027100100`.
- **Outside the lane's own files (minimal):**
  - `apps/worker/src/common.ts`: `isLiveNumber` moved here from `brief.ts` (which still re-exports it) so `digest.ts` and
    `brief.ts` do not import each other.
  - `apps/worker/src/store.ts`: one new method, `divisionStatusMessages(date)`.
  - `apps/worker/src/flows.ts`: the `ceo_digest` scheduled route, the `brief` command, and the owner's `STATUS` (the digest;
    a division head's `STATUS` is unchanged).
  - `apps/worker/src/main.ts`: starts the scheduler in the normal mode (`FAHQ_SCHEDULE=off` turns it off).
  - `apps/worker/src/commands.ts`: `APPROVE` now takes ranks (`ranks: Rank[]`, was `rank`), `BRIEF` is a command.
  - **Two existing tests changed because the owner's STATUS is no longer the open-items count:** `runner.test.ts` (its fake
    person is a division head, not the owner) and `departments.test.ts` (the five places that texted STATUS from the owner to
    count open items now text it from the finance head). Nothing else in them changed.
- **Where the manager's job goes:** add an entry to the exported `SCHEDULE` array in `scheduler.ts`:
  `{ name: 'manager-review', at: '09:00', enqueue: (deps, date) => ... }` with a task key that names the day.
- **No new env vars** except `FAHQ_SCHEDULE=off` (optional).
- **Known gap in a file this lane does not own (unchanged):** `manager.ts` (`adoptChanges`) answers an `approve_action` code
  presented with `ADOPT` as "a decision: reply CONFIRM or DECLINE".
- **Tests pick random days** (brief-flow in 2100-2199, digest-flow in 2200-6300). After very many runs on one database a pick
  can land on a day an earlier run used, and a test then sees the old rows (it showed once as a missing code); run it again.
- **Full suite on 2026-10-27 (08:30 ET):** `npm run typecheck` is clean; `npm test` 615 passed, 2 failed. The two failures are
  the same `supabase/tests/db.test.ts` "public (anon) role" tests as in slice 1 (this database's `anon` role has no table
  grants), not from this lane.

## Slice 3: the console's Divisions view and the live salon tab (done)

Design and plain-words explanation: [../divisions.md](../divisions.md) (rewritten: "In plain words" first, the step-by-step
reference after it, and a section on the console's Divisions view). Code: `apps/console/src/divisions.ts` (types),
`loader.ts` (`createDivisionsLoader`), `shape.ts` (`shapeDivisions`), `server.ts` (`GET /api/divisions`), `page.ts`.

### What works (tests)

`apps/console/test/divisions.test.ts` (no database, 42):
- the briefs: three divisions in the digest order with their heads; the latest brief's status, day, headline, findings with the
  metrics they cite, ranked actions and the CEO line; a rule-written brief; no brief yet; a brief that could not be read, and a
  division the source forgot, shown as unread and never as "no brief yet".
- where each action stands: no code sent; waiting (and a waiting code past its time shown as expired); expired; locked; code used
  for other actions; approved whatever became of the code; only an approved verdict counts; unknown when the approvals could not
  be read (an approval already read still shows); an unfamiliar code status; who approved, the code hash and row ids never leave.
- the data requests: each question paired with its answer under the division that asked and the one that was asked, newest first;
  the plain reason an answer gave and nothing of its facts; the outcome read as a flag or as text; unanswered; requests between
  unknown parties, not a data request, or with a blank question left out with a note; an unreadable answer; every question
  unreadable when no answer could be read; at most ten each way.
- the digest: its words, day and what each division had reported; none yet; one that cannot be read is left out with a note and a
  bad report line costs only itself.
- scrubbing and bad data: no code, phone, key or hash in any text of the view; every text and list cut to its limit after
  cleaning; a brief of the wrong shape, an unknown status, JSON text, a source that sends lists of the wrong kind.
- the loader against a recording fake: named columns only, newest first, limits of 100 or less, only the tables and key patterns
  it needs (`division_briefs`, `assistant_messages`, `approvals`); answers selected as outcome and reason only; each approval and
  decision goes with its own brief and the newest code wins; nothing asked about approvals or answers when there is nothing to
  ask about; every part that fails is named by code, shown as unread and the rest kept; a database that is down.
- the server: the shaped view, read once, nothing secret; 502 in plain words without the cause and a log line of codes only;
  read only; 404 for a trailing slash.
- the page drawn in a fake browser: the digest, each division's brief with the standing of each action, the questions asked and
  received; "no brief yet", "none" and "could not be read" for empty and unread parts; markup in a brief shown as the characters
  it is; the salon tab, live, with the note that Cindy's own app keeps her personal data.

`apps/console/test/divisions-db.test.ts` (real local database through the real query builder, 5; skips itself when the local
API is not running): every part is read without a note; the newest brief of each division is the one just written; where each
action stands (a used code and the one action approved, a locked code, no code); each question with its answer, and an answer's
facts never read; the newest digest; no person id, code hash or phone in the view. Its rows are written with SQL in the year 8000s
and 9000, so they are the newest in every list, and removed afterwards (checked: none left).

`apps/console/test/console.test.ts` (53, was 53): updated for the live salon (it is read like the others, no placeholder),
the Divisions tab first in the tab order, and five live assistants in the HQ Manager's usage table.

I checked that these tests fail without the guards: a waiting code never lapsing, any verdict counting as approved, answers read
as whole bodies, unread answers shown as unanswered, texts not trimmed, unread actions shown as "no code sent", the oldest code
winning, approvals not filtered by action.

I looked at the page in the browser pane, with made-up data through the real server (no database): desktop and phone width
(no sideways scroll at 375 pixels), the digest, a normal, a watch and an act division, a rule-written brief, approved, waiting
and not-approved actions, answered, unanswered and could-not-answer questions, and the live salon tab.

### What is not done

- Only each division's latest brief is shown (no history), and nothing about a text's delivery (sent, skipped, no live number).
- The Divisions tab has not been run against the live worker's own rows: the proof of the database path is
  `divisions-db.test.ts` with rows written by SQL in the shape the worker writes them, and the worker tests prove the worker
  writes that shape.
- The HQ Manager still does not read briefs (slice 1's note); the console shows only the actions the head approved, not what the
  manager did with them.

### What the merge must know

- **Files outside the lane's own, minimal:** `docs/architecture.md` (the sentence about the salon placeholder), `README.md` (one
  table cell). Everything else is in `apps/console` (listed in the lane) and `docs/`.
- **Removed from `apps/console`:** `LiveDepartmentId`, `PlaceholderView`, `placeholderView`, `SALON_MESSAGE`, and the `placeholder`
  field of a department (in `/api/departments` and in a department's view): the salon is live, so none of it applies. `ConsoleDeps`
  has a new required `loadDivisions`. Nothing outside `apps/console` used any of these (`grep` over the repo).
- **Test helpers moved** out of `console.test.ts` so two files can use them: `test/draw.ts` (`drawTab`, the page in a fake
  browser) and `test/recorder.ts` (`recorder`, the recording fake of the Supabase client). `divisions-db.test.ts` imports
  `../../worker/test/localdb.ts` (the same local-API helper the worker's database tests use).
- **The cloud project:** the Divisions tab reads `division_briefs` (migrations `20261027100100` and `20261027100110`, which have
  to be applied there first). Until they are, the tab says the briefs "could not be read right now (42P01)" and shows the
  questions and digest it can read. No new env var, no new dependency.
- **A hazard worth knowing for any test that holds a waiting code on the shared database:** a wrong code tried by any other test
  adds a failed attempt to every waiting code of that person, and the fifth locks it. The database test therefore uses a locked
  code, not a waiting one (the waiting case is covered without a database).
- **Full suite on 2026-10-27 (08:52 ET), other lanes testing too:** `npm run typecheck` is clean; `npm test` 662 passed, 2 failed.
  The two failures are the same `supabase/tests/db.test.ts` "public (anon) role" tests as in slices 1 and 2 (this database's
  `anon` role has no table grants), not from this lane.
