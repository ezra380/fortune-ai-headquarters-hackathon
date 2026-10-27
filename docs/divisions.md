# Divisions

Status: **slice 1 built (briefs core)** on branch `hq/div-brief`; the scheduler, the CEO digest and the console view
come in the next slices of this lane. Synthetic data only.

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
   holds one brief per division per day).

## Delivery

- **The head** gets one text from the division's assistant: status, headline, findings, actions, then "Reply APPROVE <1-3>
  `<code>` to approve an action. The code expires in 12 hours." The code is a one-time `approve_action` approval hanging from
  the brief's own mailbox row (`briefdoc:<key>`, addressed from the division to itself). A brief with no actions is texted
  without a code. A printout row is queued (`attachmentRef: brief:<id>`; the outbox skips it until the delivery package can
  render a brief).
- **No live number.** If the assistant's number is missing or a `+1555` placeholder, no text is sent: the `brief.sms`
  receipt says so, and the brief is still stored and printed.
- **The CEO division** gets one mailbox row from the division to `owner`: `kind: 'report'`, `body.type:
  'division_status'`, with the status and the `ceoLine` (key `status:<key>`). Nothing more: the detail stays with the head.

## APPROVE

`APPROVE <1-3> <code>` (parsed by fixed rules, never by a model) spends the code once. The division remembers the decision
(`rememberDecision`), the HQ Manager gets a `decision` row (`body.type: 'action_decision'`), and the head is told the action
is hers to carry out. The assistant changes nothing. A code presented with another command word stays usable and the reply
says which command it is for. A code spent on a rank the brief does not have records nothing.

## Everything is keyed

| Step | Key |
|---|---|
| the task | `brief:<division>:<date>` (also the `division_briefs` key) |
| the needs note | `needs:<key>` |
| a request / its reply | `datareq:<key>:<target>` / `datareply:<request id>` |
| the brief | `brief_key` unique in `division_briefs` |
| the brief's mailbox row / the CEO line | `briefdoc:<key>` / `status:<key>` |
| the text, with its code / the printout | `brief-sms:<brief id>` / `brief-print:<brief id>` |

A task that runs again after the brief was stored goes straight to delivery. One that stopped earlier reuses the stored
needs and replies. `issue_approval` refuses to queue the same text twice, so the first code stays the only one.

## Configuration

- `NEEDS_MAX_TOKENS` (default 3000): the needs call's output cap.
- `BRIEF_MAX_TOKENS` (default 8000): the brief writer's output cap.

## Queuing a brief

`enqueueBrief(deps, division, 'YYYY-MM-DD')` queues the day's brief (a second call for the same day changes nothing).
The scheduler that calls it each morning is a later slice.
