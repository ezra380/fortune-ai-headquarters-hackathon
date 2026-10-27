# Divisions

Status: **built** on branch `hq/div-brief`: the division briefs, the questions the divisions ask each other, APPROVE, BRIEF,
the CEO digest, the daily clock and the console's Divisions view. Synthetic data only.

## In plain words

The company is run like an enterprise, as four divisions. Each division has one AI assistant, its manager, and one human
head. The assistant holds the data its division needs, centred on the division's own target, and turns it into advice for
its head. The head decides and does the work. The assistant never acts.

| Division | Its assistant | Its head | What the assistant reads |
|---|---|---|---|
| Salon | `salon` | the head stylist | the salon's numbers only |
| Finance | `finance` | the finance owner | every number in the company, with the salon's and the online store's kept apart |
| Online | `online` | the online staff lead | the online store's numbers only |
| HQ / CEO | `owner` | the owner | one short status line from each of the other three |

The salon assistant is a stand-in for Cindy, the head stylist's own assistant (a separate app), and works on synthetic salon
data. The salon and the online store are two businesses and are never merged into one number.

The **HQ Manager** (`manager`) sits under Owner HQ. It is not a division. It receives every assistant's end-of-work report and
recommends changes to the assistants' profiles; the owner adopts each one with a code ([manager.md](manager.md)).

### The brief

Every morning each of the salon, finance and online assistants reads its own numbers and writes its head one short **brief**:
a status, a headline, up to four findings and up to three actions the head may approve.

- The **status** is **normal**, **watch** or **act**. A program sets it from fixed rules about the numbers (any "act" rule
  makes it act, otherwise any "watch" rule makes it watch). The assistant's words must agree with it, and it can never set it.
- Every number in a brief has to trace back to the data the assistant was given. A program checks that. If the assistant's
  write-up does not pass, it gets one more try with the exact objections; if it still fails, a program writes a plainer
  brief from the rules and says so at the top ("written by rules").
- The head gets the brief as one text, and a printout is queued. The CEO division gets only a one-line status.

### When a division needs something from another

Sometimes a division cannot write its brief from its own numbers alone. Then its assistant sends a plain question to another
division's assistant (at most two questions, never to itself). A program drops a question that has medical or hair-loss
wording, a phone number or a six-digit code before it is sent. The other assistant answers from **its own data, with its own
tools and its own instructions**: the asking division never reads the other's data itself. The answer, or the plain reason it
could not be given ("Code Mode is not connected on this machine"), is kept in the mailbox with who asked, who answered and
when. Only the answer's **metric values** are kept, each with the id that says which business it belongs to; a number with no
id, or a number no tool returned (a total that adds the salon to the online store, say), makes the program refuse the whole
answer and say so. The asker may use what is kept in its brief, and those numbers are checked like any other.

### Approving by code

Each action in a brief is a suggestion. The head's text carries one **one-time code**. She replies `APPROVE 1 3 <code>` to
approve actions 1 and 3 (any ranks, once each). The code works once, only for her, for twelve hours. A plain "yes" decides
nothing. If she names an action the brief does not have, nothing is recorded and **the code is not used up**: she is told which
action is missing and can send the right command with the same code. Approving records her decision in the division's memory,
the company record and the HQ Manager's mailbox; it changes nothing else. Carrying the action out is hers.

### The CEO digest

The owner gets one very short text each morning, written by a program and not a model: a heading and one line per division.
A division that is normal is one fixed sentence ("Salon: running normally."). One that needs a look, or a decision, carries
its own one-line summary for the CEO, which has already passed the number check. The heads get the detail in their own briefs.
The owner can also text `STATUS` to see the digest as it stands, or `BRIEF` to ask all three divisions for a brief now.

### The schedule

New York time, every day: **8:00** the three briefs are queued; the digest is queued the moment the third brief is in, so
normally it goes out as soon as the last division reports. The **8:30** clock never sends the digest ahead of a brief that is
still being worked on: it waits (and asks again every minute). If a missing brief has stopped for good, or two hours have
passed since the briefs were queued and one is still not in, it queues a **partial** digest ("no report yet" for the missing ones) so the owner hears what is in; the
complete digest still follows as a second text when the last report arrives. If the worker was down at the time, a missed job
is queued when it comes back, but only within four hours of its time.

### Where to look

The console's first tab, **Divisions** (owner only, read only): the CEO digest, and for each division its latest brief with
where each action stands (approved, waiting for a code, code expired, not approved), the questions it asked and was asked, and
whether they were answered. See [The console's Divisions view](#the-consoles-divisions-view).

### What the program refuses, and the test that keeps each one true

| Rule | What enforces it | Test |
|---|---|---|
| An assistant changes something. They read and advise; people decide by one-time code and carry the action out. | the assistants' tools are read tools; APPROVE only records the decision | `read-tools.test.ts`; `brief-flow.test.ts` "APPROVE <rank> <code> records the head's decision once" |
| A number reaches a person that does not trace to data. | `numberTrace` on every field of a brief; from another division only metric values with an id count; the digest has no number of its own | `brief.test.ts` "refuses a number that is not in the data, in any field", "refuses a number from a reply that carries no metric id"; `brief-flow.test.ts` "a reply carrying a number no tool returned"; `digest.test.ts` "has no number of its own" |
| The salon's numbers and the online store's are merged, or put side by side in one sentence. | a reply keeps only metric ids of the business that answered (finance, both); no sentence holds a salon number and an online number | `brief.test.ts` "keeps to the business that answered", "refuses a sentence that puts a salon number next to an online number", "uses the business of the metric inside a reply"; `brief-flow.test.ts` "a reply keeps only the metric ids and values of the business that answered" |
| Medical or hair-loss information is read, written or shown. | a question with such wording is dropped before it is posted; a reply keeps ids and numbers, no words; the brief's words are checked | `brief.test.ts` "drops a question with medical or hair-loss wording…", "refuses medical and hair-loss words"; `brief-flow.test.ts` "a question with medical wording, a phone number or a code is never posted" |
| A model sees a phone number or a code. | what a model is given is built from the metrics, the attention list, the replies' metric values and the division's lessons; a question holding a phone number or a six-digit run is dropped | `brief-flow.test.ts` "writes the finance head a brief…" (no phone number or code in any model input), the question tests above; `read-tools.test.ts` "never returns a phone number or a code" |
| A one-time code is used up by a command that cannot work. | the command is checked against the brief before the code is spent (`peek_approval_code`) | `brief-flow.test.ts` "APPROVE for an action the brief does not have records nothing and does not spend the code"; `digest-flow.test.ts` "a rank the brief does not have is named and nothing is recorded"; `db.test.ts` "peek_approval_code" |
| The digest goes ahead of the briefs. | the 08:30 job waits while any of the day's briefs is open (for two hours at most) | `digest-flow.test.ts` "a worker that starts late finds the briefs and the digest due at once…"; `digest.test.ts` "the 08:30 digest" |

What these checks cannot do: tell a customer's name from any other word (a question or a brief with a name in it is not
caught), judge meaning (the medical check is a list of words), or attribute a number that two businesses both hold to either
one. Those stay with the people who read the brief.

---

## How it is built

The rest of this page is the reference: what the code does, step by step, and the keys that make each step happen once.

## The day in one picture

```
08:00 ET  scheduler queues brief:salon / brief:finance / brief:online  (or: the owner texts BRIEF, a head texts BRIEF)
          each assistant: numbers → asks the other divisions if it must → writes the brief → checks every number
          head gets one text: status, headline, findings, actions, a one-time code
          CEO division gets one status line from each division (a mailbox report to `owner`)
          the third status line queues the digest
08:30 ET  scheduler: all three in, the digest is queued (same key); a brief still being worked on, it waits;
          a brief stopped for good, or 10:30 come, a PARTIAL digest is queued (the complete one still follows)
          Owner HQ texts the owner the digest: one line per division, 480 characters at most
head      replies APPROVE 1 3 <code>: the decisions are recorded; the head carries the actions out
```

Nothing in this chain acts on a live system: assistants read and advise, heads decide by code and do the work.

## A division's brief

Once a day each of Finance, Online and Salon writes its head a brief, as a `scheduled` task for its own assistant:
`{ job: 'division_brief', division, date }`, key `brief:<division>:<YYYY-MM-DD>`. Code: `apps/worker/src/brief.ts`.

1. **Data** (`divisionData`). The data port's `getDivisionMetrics` when it has one (metrics plus the attention rules
   that fired); otherwise the finance read cut by business (finance sees all, salon and online only their own, and no
   rule fires). Not connected, unreadable or empty is a failed task with a plain reason and a `brief.data` receipt.
2. **Needs.** One model call (the division's `code` model, reasoning on) may ask OTHER divisions up to two plain questions,
   only when its own numbers cannot answer something that matters. Questions to itself or to `hq` are dropped, and so is
   any question with medical or hair-loss wording, a phone number or a six-digit code (`parseNeeds`; the receipt counts
   them and the note names the reason, never the words). The answer is stored as a note in the mailbox (`needs:<key>`), so a retry never asks again. A model that cannot be reached stops
   the task (it is tried again); an answer that cannot be read means no questions, and the receipt says so.
3. **Requests.** Each question is a typed mailbox row from the asking assistant to the target
   (`kind: 'request'`, `body.type: 'data_request'`, key `datareq:<key>:<target>`) and is recorded in the World Model
   (`brain.record.request`). The target answers with its OWN profile: one Code Mode lookup with its own skill, its own
   `code` model and its own read tools. The asking division never reads the other's tools. The reply is a mailbox row
   (`kind: 'report'`, `body.type: 'data_reply'`, `replyTo` the request, key `datareply:<request id>`) carrying the lookup's
   **metric values** as `facts` (a list of `{ id, value, unit? }`, `replyMetrics`) and, per id, the view and query hash of the
   answering division's tool output that named it as `sources` (`replySources`; the weekly reports use it), or `ok: false` with the plain reason (Code
   Mode not connected, the script failed, the result was too large to check, the result held a number no tool returned, the
   result held no metric value tied to an id). Only ids of a business count (`m:salon.*`, `m:online.*`), and only those the
   answering division may hold: a salon answer carries salon ids, an online answer online ids, finance either. Every other
   number and word in the result is dropped, so a number always names its business. A stored reply is reused, never looked up
   twice; one stored before replies were reduced is reduced when it is read.
4. **The brief.** One call to the plan model (reasoning on) with the metrics, the attention list, the replies' facts, the
   program-set status and the division's adopted lessons. It returns a `DivisionBrief` (`packages/contracts`): a headline
   (up to 160 characters), up to 4 findings (text up to 300, `cites` metric ids), up to 3 actions (rank 1 to 3, title,
   why, steps, `cites`) and a `ceoLine` (up to 140, one plain sentence for the CEO). A program checks it
   (`checkBrief`):
   - the schema and different action ranks;
   - every cited id exists, in the division's metrics or among a reply's metric values;
   - every number traces (`numberTrace`) to the metrics, the attention list or a reply's metric values (a number in a reply
     without an id is nobody's), and the words zero, one, two, three and larger number words are refused;
   - no sentence puts a number that only a salon metric has next to one that only an online metric has;
   - no medical or hair-loss words.

   One correction round carries the exact objections. If it still fails, or the model cannot be reached, a program writes
   a **rule-written brief** (`fallbackBrief`) from the attention list and the metrics' own labels and values. Its headline
   says so ("Rule-written brief, because the usual write-up did not pass its number check"), the row's `written_by` is
   `rule`, and the text to the head says it too.
5. **Status.** `normal`, `watch` or `act`, set by the program from the attention rules (`statusOf`: any `act` rule makes
   `act`, else any `watch` rule makes `watch`). A model never sets it, and a status it adds is dropped by the schema.
   The actions are renumbered 1, 2, 3 in order (a model's 1 and 3 become 1 and 2), so the ranks the head is told to use exist.
6. **Stored once.** `division_briefs` (`brief_key` unique; the key must name the division and the day, so the database
   holds one scheduled brief per division per day, and one more run for each BRIEF text).

## Delivery

- **The head** gets one text from the division's assistant: status, headline, findings, actions, then "Reply APPROVE <1-3>
  `<code>` to approve an action" (with "(APPROVE 1 2 `<code>` for more)" when the brief has two or three actions) and "The
  code expires in 12 hours." The code is a one-time `approve_action` approval hanging from the brief's own mailbox row
  (`briefdoc:<key>`, addressed from the division to itself). A brief with no actions is texted without a code. A printout
  row is queued (`attachmentRef: brief:<id>`; the outbox skips it until the delivery package can render a brief).
- **No live number.** If the assistant's number is missing or a `+1555` placeholder, no text is sent: the `brief.sms`
  receipt says so, and the brief is still stored and printed.
- **The CEO division** gets one mailbox row from the division to `owner`: `kind: 'report'`, `body.type:
  'division_status'`, with the status, the day and the `ceoLine` (key `status:<key>`). Nothing more: the detail stays with
  the head.

## APPROVE

`APPROVE <ranks> <code>` (parsed by fixed rules, never by a model) uses the same grammar as `ADOPT`: ranks 1 to 3, each once,
separated by spaces or commas, then the 6-digit code. `APPROVE 2 482913`, `APPROVE 1 3 482913` and `APPROVE 3, 1 482913`
are commands; `APPROVE 1 1 482913`, `APPROVE 4 482913` and `APPROVE 1 2` are refused by rule, with the hint, and never
reach a model.

It spends the brief's code once, for the actions named in that one text. First it looks at the code without spending it
(`peek_approval_code`, which changes nothing and counts no failed attempt) and checks every rank named against the brief: if
the brief lacks any of them, nothing is recorded and the code stays usable. Only then is the code spent. For each action:
- the division remembers the head's decision (`rememberDecision`, one memory per action);
- the World Model gets the action as an item of its own (`record.proposal` with its title and the metrics it cited, then
  `record.decision`, so "why" can be answered for it: `explainProposal("<brief row id>:<rank>")`);
- the HQ Manager gets a `decision` row (`body.type: 'action_decision'`, key `action-decision:<brief row id>:<rank>`).

The head is told: "Recorded: you approved action 1 (Hold Google spend) and action 3 (Check Mazali stock). They're yours to
carry out." A rank the brief does not have is named and refuses the whole command ("This brief has no action 3. Nothing was
recorded, and your code still works."). The assistant changes nothing. A code presented with another command word stays usable
and the reply says which command it is for. Only the person the code was issued to can spend it.

## BRIEF

- The **owner** texting `BRIEF` asks all three divisions for a brief now. Each is a run of its own, a `scheduled` task for
  that division's assistant keyed `brief:<division>:<date>:<id of the text's task>` (the brief's `request` field). The
  heads get their briefs by text as usual, and the digest follows when the third is in (key
  `digest:<date>:<id of the text's task>`). The owner is told so, and that STATUS shows what is in so far.
- A **division head** texting `BRIEF` asks for her own division's brief only, and no digest follows it.
- A text that is handled twice (a retry) asks for the same runs; a second `BRIEF` is a new run, so the head gets a new brief
  and a new code (the first code still works for the first brief). The digest always shows the newest status of each
  division that day.
- Anyone else gets "BRIEF is for the owner and the division heads."

## The CEO digest

`apps/worker/src/digest.ts`. One text from Owner HQ to the owner: a heading and one line per division, **written by a
program, never a model**, at most 480 characters.

```
Company status for 2026-10-27:
Salon: running normally.
Finance: needs a look — Finance has something to watch; its head has the detail.
Online: no report yet.
```

- A division whose status is `normal` is the fixed sentence "running normally." Its own CEO line is not repeated.
- `watch` is "needs a look — " and `act` is "needs a decision — ", followed by the division's `ceoLine`. That line already
  passed the brief's number check, so the digest holds no number of its own: the only digits are the date and those inside
  a CEO line.
- No status line that day is "no report yet."; one that cannot be read is "the report could not be read."
- If the lines would not fit in 480 characters, the CEO lines are shortened by whole words (a number is kept whole or left
  out, never cut), the shortest keep all they need and the long ones share what is left.
- It reads the newest `division_status` report of the day for each division from the mailbox.

**When it is written.** A scheduled task for Owner HQ, `{ job: 'ceo_digest', date, request?, partial? }`, key `digest:<date>`
(or `digest:<date>:<id of the BRIEF text>`). It is queued when the third division's brief is delivered (that delivery sees all
three status lines of its run), and the 08:30 clock queues the same key when it finds all three in, so there is one complete
digest a day. The clock never queues a digest ahead of briefs still being worked on (see the daily clock); when it has to go
without a report it queues the **partial** digest, key `digest:<date>:partial`, with "no report yet" for the missing lines, and
the complete one still follows when the last report arrives (two texts that day, the second saying all three). The words are
stored once (`digestdoc:<key>`) and the text is keyed (`digest-sms:<key>`): a task that runs again sends the same words and
never a second text. A report that arrives after a digest went out is not added to it.

**STATUS.** The owner texting `STATUS` gets the digest built right now from the reports that are in (so a late report
shows). A division head's `STATUS` is unchanged: "Open items for your assistant: N."

**No live number.** If the Owner HQ assistant has no live number, no text is sent; the `digest.send` receipt says so.

## The daily clock

`apps/worker/src/scheduler.ts`, started by the worker (`main.ts`) in its normal mode. Once a day, New York time:

| Time | Job | Queues |
|---|---|---|
| 08:00 | `division-briefs` | `brief:finance:<date>`, `brief:salon:<date>`, `brief:online:<date>` |
| 08:30 | `ceo-digest` | `digest:<date>` when all three reports are in, `digest:<date>:partial` when not (see below) |
| 09:00 | `manager-review` | `review:daily:<date>`: the HQ Manager's quiet daily review (`queueDailyReview`, docs/manager.md; merge wave 1) |

- It only queues (idempotent by key); the claim loops do the work. A receipt `scheduler.enqueue` records each job queued,
  failed or waiting. A job that fails is tried again at the next minute.
- A job may answer "waiting" with a plain reason (`enqueue` returns `{ waiting }`): it is not counted as queued, is asked again
  at every tick, and its wait is reported once a day. The digest job waits while any of the day's three briefs
  (`brief:<division>:<date>`) is queued, running or waiting, for at most two hours after they were queued
  (`DIGEST_WAITS_MINUTES`; counted from the briefs' queue time, so a worker started at 10:45 still waits). A worker started at
  09:00 finds both jobs due at once, and the digest follows the briefs instead of racing them. Once nothing is open, or the two
  hours are up, with a report missing, it queues the partial digest. (The job itself is due only until four hours after 08:30.)
- A job that was due while the worker was down is queued when the worker comes back, but only within four hours of its time:
  a worker started in the evening does not send the morning's briefs.
- `FAHQ_SCHEDULE=off` turns the clock off; briefs and the digest are then only asked for by text. The clock runs only in the
  worker's normal mode, not with `--once`.
- The job table is the exported `SCHEDULE` array (the HQ Manager's daily review is its third job). A job is
  `{ name, at: 'HH:MM', enqueue(deps, date) }`, where `enqueue` queues a task whose key names the day; it may answer
  `{ waiting }`, and one that answers nothing is marked queued for the day.

## Everything is keyed

| Step | Key |
|---|---|
| the task | `brief:<division>:<date>`, or `brief:<division>:<date>:<request id>` for a BRIEF text (also the `division_briefs` key) |
| the needs note | `needs:<key>` |
| a request / its reply | `datareq:<key>:<target>` / `datareply:<request id>` |
| the brief | `brief_key` unique in `division_briefs` |
| the brief's mailbox row / the CEO line | `briefdoc:<key>` / `status:<key>` |
| the text, with its code / the printout | `brief-sms:<brief id>` / `brief-print:<brief id>` |
| an approved action | `action-decision:<briefdoc id>:<rank>` |
| the digest task / its words / its text | `digest:<date>[:<request id>]` or `digest:<date>:partial` / `digestdoc:<key>` / `digest-sms:<key>` |

A task that runs again after the brief was stored goes straight to delivery. One that stopped earlier reuses the stored
needs and replies. `issue_approval` refuses to queue the same text twice, so the first code stays the only one.

## Configuration

- `NEEDS_MAX_TOKENS` (default 3000): the needs call's output cap.
- `BRIEF_MAX_TOKENS` (default 8000): the brief writer's output cap.
- `FAHQ_SCHEDULE=off`: no daily clock.

## Queuing by hand

`enqueueBrief(deps, division, 'YYYY-MM-DD')` queues the day's scheduled brief (a second call for the same day changes
nothing); with a third argument, a UUID, it queues that run of the day. `enqueueDigest(deps, date)` does the same for the
digest, `enqueuePartialDigest(deps, date)` for the partial one, and `enqueueDayDigest(deps, date)` is the 08:30 job (it chooses).


## The console's Divisions view

`apps/console` (owner only, read only, on this computer only). The first tab, **Divisions**, is drawn from `GET /api/divisions`;
the salon tab, which used to be a placeholder, now reads the salon's assistant like the other four. Code: `loader.ts`
(`createDivisionsLoader`), `shape.ts` (`shapeDivisions`), `divisions.ts` (the types), `page.ts`.

**What it shows**

- **The CEO digest**: the newest `digestdoc:` mailbox note: the words as the owner was sent them, and what each division's
  report looked like when it was written (in, no report yet, could not be read).
- **For each division** (salon, finance, online), its newest brief (by day, then by time: a BRIEF run on the same day shows once
  it is written): the status, a "written by rules" mark when a program wrote it, the headline, the findings with the metric
  ids they cite, the actions, and the line it gave the CEO division. Each action carries where it stands:

  | Shown as | Meaning |
  |---|---|
  | approved | the head approved it with her code (from the note the HQ Manager was sent: rank and verdict only) |
  | waiting for a code | a code is waiting; the page says when it expires |
  | code expired / code locked | the code ran out (a waiting code past its time is shown as expired, because the database only marks it when someone tries it) or was locked by wrong tries |
  | not approved | the code was used, but not for this action |
  | no code sent | the brief was not texted with a code (no live number, or no action) |
  | unknown | where the actions stand could not be read right now |

- **The questions between divisions**: the latest 30 (`datareq:` notes), each paired with its answer (`datareply:`, which replies
  to the request). A division lists the questions it asked and the ones it was asked: from, to, the question, when it was asked
  and when answered; a question with no reply is "waiting for an answer"; one the other side could not answer shows its plain
  reason.

**The console's rules, kept**

- Read only: GET and HEAD, no form, no write. Loopback only. The service key stays on the server.
- Named columns only. An approval is read without its code hash. An answer is read as its outcome and reason only: the facts it
  carried are never selected. Who approved an action is never read (the decision notes give rank and verdict; the person is not
  taken).
- `shape.ts` is the one place that decides what leaves the server: known fields only, every text cleaned and cut, six-digit
  codes blanked, phone numbers masked to their last four digits, keys and hashes hidden. (A run of six or more digits is blanked
  whether it is a code or not, so a large unformatted figure in a brief shows as `••••••`.)
- A stored value of the wrong shape becomes one plain note and what is readable stays. A part that could not be read (a brief,
  the standing of its actions, the questions, their answers, the digest) says so on the page and is never shown as empty.
- The page draws only with `textContent`; its Content-Security-Policy allows exactly its one script and one style block.

**Wave 2** gives the view a tab for each division with its manager ("George, Finance, reports to Alan"), its workers' daily reports
and its weekly report, a PDF link for each, and a head's own page (`/?division=finance`): see [delivery.md](delivery.md), "The console".

**Tests**: `apps/console/test/divisions.test.ts` (shaping, the loader against a recording fake, the server, the page drawn in a
fake browser), `divisions-db.test.ts` (the loader on the real local database through the real query builder, with its own rows
removed afterwards) and `console.test.ts` (the departments, including the live salon). Wave 2's tests are in `reports-*.test.ts`
(listed in delivery.md).
