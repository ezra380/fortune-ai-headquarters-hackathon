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
  a rank the brief lacks records nothing (that was true of the records only: the code was spent too, which the review found; fixed,
  see "Review fixes"), only the head the code was issued to can use it.

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
- [replaced in the review fixes: the digest now waits for the briefs] the 08:30 clock queues the three briefs and the digest
  once (a second clock queues nothing more); the digest with only the salon in says "no report yet" for the others; the later
  reports neither queue nor send a second digest; STATUS shows them.
- the third scheduled report queues the day's digest and the 08:30 clock finds it there.
- no live number for the owner assistant: no text, a refused `digest.send` receipt; STATUS still answers. A division head's
  STATUS is still the open-items count.
- bad payloads (a digest job for another assistant or with a bad date, a brief job whose request is not an id).
- the database accepts a brief key with the asking text's id and refuses any other ending.
- `APPROVE 1 3 <code>`: both actions in the division's memory (one memory each), the World Model (each action is an item
  with its title, cited metrics and the head's approval) and the HQ Manager's mailbox; action 2 untouched; the spent code
  does nothing; two texts with the same code at once record once; [replaced in the review fixes: a rank the brief lacks now refuses
  the whole command and keeps the code usable]; the text tells the head that several actions can be approved with one code.

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

## Review fixes (2026-10-27, after an independent review)

Eight findings, four of them major. All are fixed except where said below. Every fix has a test that I saw fail on the code
before the fix (the flow tests were run first on the unfixed code and failed for the reasons below; the unit tests were
checked by taking each guard out again: the trace on raw reply facts, the renumbering and the question screen each made one or
two tests fail).

### 1. A wrong action number no longer spends the code (major)

- **Cause.** `approveAction` spent the code (`use_approval_code`) and only then looked at the brief, so `APPROVE 3 <code>` on a
  two-action brief answered "no action 3" but left the approval signed. My earlier note "a rank the brief lacks records
  nothing" was true of the records only.
- **Fix.** New migration `20261027100120_division_brief_peek.sql`: `peek_approval_code(phone, code, action, now)`, a read-only
  look at a pending code (same match as `use_approval_code`: the person's phone, pending, not expired, the hash of the
  approval's id with the code). It changes nothing and counts no failed attempt. `approveAction` peeks, finds the brief the
  code hangs from, and refuses a command naming a rank the brief lacks BEFORE spending: "This brief has no action 3. Nothing was
  recorded, and your code still works." A command with one good and one missing rank is refused whole (nothing half done).
  A wrong code still falls through to the spend and is counted as before. If the peek misses and the spend then finds a rank
  missing (the code taken a moment earlier), the code is spent, nothing is recorded, the head is told so and the task fails
  with a receipt; that branch is a safety net the peek makes unreachable in practice.
- **Tests.** `brief-flow.test.ts`: "APPROVE for an action the brief does not have records nothing and does not spend the
  code..." (also `APPROVE 1 3`), "a wrong code is still counted, and a wrong action number does not count against the right
  one", "a spent code that finds the brief lacking an action records nothing and says so", "looks at a code without spending
  it..."; `digest-flow.test.ts`: "a rank the brief does not have is named and nothing is recorded, not even the ranks it
  has...", "APPROVE 2 3 for a brief with one action..."; `supabase/tests/db.test.ts`: "peek_approval_code" (2 tests).

### 2. Another division's reply can no longer carry an untraced or untagged number (major)

- **Cause.** Any Code Mode result became reply facts; a number no tool returned was only counted in the receipt, and
  `numberTrace` counted every number in the facts as given. A finance script returning a salon plus online sum, or a salon
  reply `{ appointments: 310 }` with no id, passed the trace and the salon/online check.
- **Fix.** `replyMetrics(facts, from)` keeps only `{ id, value, unit? }` for ids `m:salon.*` / `m:online.*`, only for the business
  that answered (salon: salon ids, online: online ids, finance: both; `combined` never; at most 40; the three shapes the lane
  already read). Every other number and word is dropped. `answerDataRequest` refuses the whole answer, with a plain reason and a
  `refused` receipt, when `untracedResultNumbers` finds a number no tool returned, or when no metric value with an id is left.
  The reply is stored reduced; `replyOf` reduces a stored reply again when it is read (so a reply stored before this fix, or one
  posted by anything else, is held to the same rule). `checkBrief` takes the cited ids, the trace source and the business of each
  reply number only from `replyMetrics`, so the label text of a metric ("30 days") no longer counts as a given number either.
  The three division skills and the lookup question now tell the answering model to return the tools' metrics as `{ id, value,
  unit }` and not to add anything up.
- **Where I did something different from the finding's wording.** The finding suggested treating every number in a salon or
  online reply as that division's business. I made it stricter: a number with no id is not accepted as data at all (it is
  neither traced nor attributed), which also refuses the case the finding's wording would have attributed.
- **Tests.** `brief.test.ts`: "replyMetrics" (4), "another division's numbers count only as metric values with an id" (3);
  `brief-flow.test.ts`: "a reply carrying a number no tool returned...", "a reply whose numbers carry no metric id is
  refused...", "a reply keeps only the metric ids and values of the business that answered..."; the existing cross-division
  test now expects the reduced facts.

### 3. The digest can no longer go ahead of the briefs (major)

- **Cause.** A worker started between 08:30 and 12:00 found both jobs due in one tick and queued the digest next to three
  briefs that take minutes; the digest then went with "no report yet" and, because the third brief queues the same key, the
  full digest never followed. (My digest-flow test encoded that as expected.)
- **Fix.** `ScheduledJob.enqueue` may answer `{ waiting }` (a job that is not ready: it is not marked queued, is asked again
  every tick, and reports its wait once a day in a `scheduler.enqueue` receipt). The 08:30 job is now `enqueueDayDigest`: all
  three scheduled reports in -> `digest:<date>` (same key as the third brief's); some missing and any of the day's three briefs
  still queued, running or waiting -> wait, for at most two hours after they were queued (`DIGEST_WAITS_MINUTES`, counted from
  the briefs' `run_after`, so a worker started at 10:45 still waits); otherwise -> a PARTIAL digest, `digest:<date>:partial`
  (payload `partial: true`), with "no report yet" for the missing. The complete digest still follows as a second text when the
  last report arrives. New store method `openTasksByKey(keys)` (count and earliest queue time); `allReported` in `brief.ts` is
  the one place that says whether the three scheduled reports are in (the third brief uses it too).
- **I did not use the finding's option (a)** (the digest task throws a retryable error while briefs run): a task has three
  attempts 30 seconds apart, so it would be failed long before a brief finished.
- **Tests.** `digest-flow.test.ts`: "at 08:30 ... the digest waits for them...", "a worker that starts late finds the briefs
  and the digest due at once..." (the owner gets the digest only after the three reports are in), "a worker that starts after
  10:30 still holds the digest...", "a brief that is still not in two hours after the briefs were queued..." (partial, then
  the complete one), "when the briefs that are not in have stopped for good... the partial digest does not wait";
  `digest.test.ts`: "a job that is not ready..." (1), "the 08:30 digest" (8), the partial key.

### 4. Questions are screened before they are posted (major)

- **Cause.** The prompt said a program checked rule 4 (no phone numbers, codes, names or medical/hair-loss words) but
  `parseNeeds` only checked the schema, the division and the count.
- **Fix.** `parseNeeds` drops a question with medical or hair-loss wording (the same word list the brief uses), a US phone
  number (ten digits with or without a country code and any of the usual separators, so an ISO date is not one) or a run of
  exactly six digits (a code), and returns `dropped` (the reasons, never the words). A dropped question is never posted: no
  mailbox row, no World Model record, no lookup. The `brief.needs` receipt says how many were dropped and why; the needs note
  keeps the reasons. The stored note goes through the same rules when reused.
- **Not caught:** a customer's name (a program cannot tell a name from another word). Stated in `divisions.md`.
- **Tests.** `brief.test.ts`: three `parseNeeds` tests; `brief-flow.test.ts`: "a question with medical wording, a phone number
  or a code is never posted...", "a question that passes the rules is still posted when another one is dropped".

### 5 to 8. The minor findings

- **Gapped ranks.** `checkBrief` renumbers the actions 1, 2, 3 in order when it accepts a brief (a repeated rank is still an
  objection), and the text's example is built from the brief's own ranks. Tests: `brief.test.ts` "renumbers the actions...",
  `brief-flow.test.ts` "a brief whose actions are ranked 1 and 3 is stored as 1 and 2...".
- **BRIEF's day.** `requestBriefs` uses the day the text arrived (`receivedAt`, the same helper `approveAction` uses), so a
  retry after midnight asks for the same runs. Test: `digest-flow.test.ts` "a BRIEF text handled again after midnight...".
- **Tests for the new behaviour.** `division_briefs` is in the anon loop of `db.test.ts`, and a new test shows the public
  role no brief and no way to look at a code ("no rows or no access at all"). The anon loop itself is still red on this
  local database, as before (below), because its first table (`work_reports`) is refused first; the new test passes on both
  kinds of database. The refused-rank, scheduler late-start, question and untagged-number tests are listed above.
- **Claims in the docs.** `divisions.md` now has a table of what the program refuses with the test that keeps each line
  true, and says what the checks cannot do. The old claims in slices 1 and 2 above are annotated.

### Twins searched (Law 4)

- **Spend before checking, `manager.ts` `adoptChanges` (not my file, NOT fixed).** `ADOPT 3 <code>` on a review with two
  recommendations spends the code, adopts nothing and says "Nothing was adopted". It is the same bug as finding 1. The fix is
  the same shape: `store.peekApprovalCode({ action: 'adopt_change', ... })`, check the ranks against the review's open
  recommendations, then spend. `forwardPlan` (SEND) cannot hit it (a proposal always holds plans 1 to 3), `decidePlan` has no rank.
- **Untraced numbers from a Code Mode result, `manager.ts` (`askQuestion`, the review digest).** They only count untraced
  numbers in the receipt. A head's questions go to her own assistant on her own tools, so the wall holds there by the tools;
  the owner may see both businesses. Not changed.
- **Model text posted unscreened.** The only model-chosen text posted between assistants in this lane was the question
  (fixed); the brief's own words were already screened.
- **The day taken from `now`.** `currentDigest` (STATUS) means "now" by design; no other place in the lane derives a key's day
  from the clock instead of from the text.

### What is not done

- A customer's name in a question or a brief is not caught (stated above).
- The digest wait polls the database once a minute (two small reads) while a brief is open; cheap, but not free.
- A worker that starts after about 10:30 and whose briefs then get stuck sends no partial digest (the digest job is due only
  until four hours after 08:30); the work reports and receipts show the stuck brief.
- `manager.ts` `adoptChanges` (above), and its known gap with `approve_action` codes, are for the manager lane.
- BRIEF has no rate limit, as before.

### What the merge must know

- **Third migration** `supabase/migrations/20261027100120_division_brief_peek.sql`: one new function, `peek_approval_code`
  (execute for `service_role` only). Additive; applied once to the shared local database with a small node script, after
  `20261027100110`. It touches no existing function, so it does not collide with another lane's re-creation of
  `issue_approval` / `use_approval_code`.
- **Outside the lane's own files:** `apps/worker/src/store.ts` (two new methods: `peekApprovalCode`, `openTasksByKey`),
  `packages/profiles/skills/{finance,online,salon}/SKILL.md` (one bullet of "Your brief" changed: how to answer another
  division), `supabase/tests/db.test.ts` (shared with the manager lane: `division_briefs` in its anon loop, a new anon test
  and a `peek_approval_code` describe; keep all of it).
- **For the manager lane's job in `SCHEDULE`:** `ScheduledJob.enqueue` may now return `{ waiting: string }`; a job that
  returns nothing behaves exactly as before.
- **`brief-flow.test.ts` days:** it now picks its days from those no earlier run left a brief or task on (it reads the
  database first), instead of hoping a random day is free; an earlier run had once collided.
- **Full suite on 2026-10-27 (09:31 ET), other lanes testing too:** `npm run typecheck` is clean; `npm test` 700 passed, 2 failed. The four
  brief test files pass (brief 41, digest 34, brief-flow 31, digest-flow 20); the only failures are the same two
  `supabase/tests/db.test.ts` "public (anon) role" tests as in every slice (this database's `anon` role has no table
  grants).
