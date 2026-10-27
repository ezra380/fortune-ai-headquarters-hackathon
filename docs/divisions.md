# Divisions

Status: **slices 1 and 2 built** on branch `hq/div-brief`: the division briefs, APPROVE, BRIEF, the CEO digest and the daily
clock. The console view comes in the next slice of this lane. Synthetic data only.

The company is organised like an enterprise into four divisions. Each has one assistant, and each assistant has the
data it needs, centred on its own target, and turns it into advice for its human head.

| Division | Assistant | Head | Reads |
|---|---|---|---|
| Salon | `salon` | the head stylist | salon numbers only |
| Finance | `finance` | the finance owner | every metric (salon and online kept apart) |
| Online | `online` | the online staff lead | online numbers only |
| HQ / CEO | `owner` | the owner | the three divisions' one-line status |

The HQ Manager (`manager`) sits under Owner HQ. It is not a division. It receives every assistant's end-of-work report
and recommends changes to their profiles ([manager.md](manager.md)).

## The day in one picture

```
08:00 ET  scheduler queues brief:salon / brief:finance / brief:online  (or: the owner texts BRIEF, a head texts BRIEF)
          each assistant: numbers → asks the other divisions if it must → writes the brief → checks every number
          head gets one text: status, headline, findings, actions, a one-time code
          CEO division gets one status line from each division (a mailbox report to `owner`)
          the third status line queues the digest
08:30 ET  scheduler queues the digest too (same key), with whatever reports are in
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
   only when its own numbers cannot answer something that matters. Questions to itself or to `hq` are dropped. The answer
   is stored as a note in the mailbox (`needs:<key>`), so a retry never asks again. A model that cannot be reached stops
   the task (it is tried again); an answer that cannot be read means no questions, and the receipt says so.
3. **Requests.** Each question is a typed mailbox row from the asking assistant to the target
   (`kind: 'request'`, `body.type: 'data_request'`, key `datareq:<key>:<target>`) and is recorded in the World Model
   (`brain.record.request`). The target answers with its OWN profile: one Code Mode lookup with its own skill, its own
   `code` model and its own read tools. The asking division never reads the other's tools. The reply is a mailbox row
   (`kind: 'report'`, `body.type: 'data_reply'`, `replyTo` the request, key `datareply:<request id>`) carrying the lookup's
   result as `facts`, or `ok: false` with the plain reason (Code Mode not connected, the script failed, the result was too
   large to check). A stored reply is reused, never looked up twice.
4. **The brief.** One call to the plan model (reasoning on) with the metrics, the attention list, the replies' facts, the
   program-set status and the division's adopted lessons. It returns a `DivisionBrief` (`packages/contracts`): a headline
   (up to 160 characters), up to 4 findings (text up to 300, `cites` metric ids), up to 3 actions (rank 1 to 3, title,
   why, steps, `cites`) and a `ceoLine` (up to 140, one plain sentence for the CEO). A program checks it
   (`checkBrief`):
   - the schema and different action ranks;
   - every cited id exists, in the division's metrics or inside a reply's facts;
   - every number traces (`numberTrace`) to the metrics, the attention list or a reply's facts, and the words zero, one,
     two, three and larger number words are refused;
   - no sentence puts a number that only a salon metric has next to one that only an online metric has;
   - no medical or hair-loss words.

   One correction round carries the exact objections. If it still fails, or the model cannot be reached, a program writes
   a **rule-written brief** (`fallbackBrief`) from the attention list and the metrics' own labels and values. Its headline
   says so ("Rule-written brief, because the usual write-up did not pass its number check"), the row's `written_by` is
   `rule`, and the text to the head says it too.
5. **Status.** `normal`, `watch` or `act`, set by the program from the attention rules (`statusOf`: any `act` rule makes
   `act`, else any `watch` rule makes `watch`). A model never sets it, and a status it adds is dropped by the schema.
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

It spends the brief's code once, for the actions named in that one text. For each action the brief has:
- the division remembers the head's decision (`rememberDecision`, one memory per action);
- the World Model gets the action as an item of its own (`record.proposal` with its title and the metrics it cited, then
  `record.decision`, so "why" can be answered for it: `explainProposal("<brief row id>:<rank>")`);
- the HQ Manager gets a `decision` row (`body.type: 'action_decision'`, key `action-decision:<brief row id>:<rank>`).

The head is told: "Recorded: you approved action 1 (Hold Google spend) and action 3 (Check Mazali stock). They're yours to
carry out." A rank the brief does not have is named ("Not recorded: action 3, which this brief does not have."); if none of
the ranks exist nothing is recorded. The assistant changes nothing. A code presented with another command word stays usable
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

**When it is written.** A scheduled task for Owner HQ, `{ job: 'ceo_digest', date, request? }`, key `digest:<date>` (or
`digest:<date>:<id of the BRIEF text>`). It is queued when the third division's brief is delivered (that delivery sees all
three status lines of its run), and by the scheduler at 08:30 ET with whatever is in. Both ask for the same key, so there is
one digest a day. The words are stored once (`digestdoc:<key>`) and the text is keyed (`digest-sms:<key>`): a task that runs
again sends the same words and never a second text. A report that arrives after the digest went out is not added to it.

**STATUS.** The owner texting `STATUS` gets the digest built right now from the reports that are in (so a late report
shows). A division head's `STATUS` is unchanged: "Open items for your assistant: N."

**No live number.** If the Owner HQ assistant has no live number, no text is sent; the `digest.send` receipt says so.

## The daily clock

`apps/worker/src/scheduler.ts`, started by the worker (`main.ts`) in its normal mode. Once a day, New York time:

| Time | Job | Queues |
|---|---|---|
| 08:00 | `division-briefs` | `brief:finance:<date>`, `brief:salon:<date>`, `brief:online:<date>` |
| 08:30 | `ceo-digest` | `digest:<date>` |

- It only queues (idempotent by key); the claim loops do the work. A receipt `scheduler.enqueue` records each job queued or
  failed. A job that fails is tried again at the next minute.
- A job that was due while the worker was down is queued when the worker comes back, but only within four hours of its time:
  a worker started in the evening does not send the morning's briefs.
- `FAHQ_SCHEDULE=off` turns the clock off; briefs and the digest are then only asked for by text. The clock runs only in the
  worker's normal mode, not with `--once`.
- The job table is the exported `SCHEDULE` array. Another lane adds its own job there (the HQ Manager's daily review, say):
  `{ name, at: 'HH:MM', enqueue(deps, date) }`, where `enqueue` queues a task whose key names the day.

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
| the digest task / its words / its text | `digest:<date>[:<request id>]` / `digestdoc:<key>` / `digest-sms:<key>` |

A task that runs again after the brief was stored goes straight to delivery. One that stopped earlier reuses the stored
needs and replies. `issue_approval` refuses to queue the same text twice, so the first code stays the only one.

## Configuration

- `NEEDS_MAX_TOKENS` (default 3000): the needs call's output cap.
- `BRIEF_MAX_TOKENS` (default 8000): the brief writer's output cap.
- `FAHQ_SCHEDULE=off`: no daily clock.

## Queuing by hand

`enqueueBrief(deps, division, 'YYYY-MM-DD')` queues the day's scheduled brief (a second call for the same day changes
nothing); with a third argument, a UUID, it queues that run of the day. `enqueueDigest(deps, date)` does the same for the
digest.
