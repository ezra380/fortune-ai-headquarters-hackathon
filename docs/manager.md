# The HQ Manager

Status: built on branch `hq/manager`; `main.ts` still runs with `codeMode: null` and a TEMP profiles stub until the
profiles lane merges (see "Wiring"). Synthetic data only.

The HQ Manager is the sixth assistant id (`manager`). It has **no phone number and no person**: it reaches the owner
through Owner HQ's number. It reads what the other assistants did, recommends changes, and keeps the ones the owner
adopts. It changes nothing by itself.

## The loop

1. **Every task ends with a report.** `runner.ts` keeps the receipts a task writes; after `finish_task` it builds a
   `WorkReport` (`reports.ts`: steps, usage, one deterministic sentence, suggestions from **rules**, never a model) and
   saves it (`work_reports`, one row per task, the latest attempt wins) and adds it to the shared record. A report that
   cannot be saved logs `worker.report_failed <task id prefix>` and never changes the task.
2. **`REVIEW`** (owner only) queues a `scheduled` task for `manager`, key `review:<task id>`.
3. **The review task** (`manager.ts`):
   - a Code Mode script (`manager.digest`) reads the reports through the manager's read tools and returns a small digest;
   - one model call (`manager.review`) writes the `ManagerReview` (at most 3 recommendations, each about one assistant);
   - **every number** in it must be a number in the digest (`numberTrace`); one correction round, then a plain failure;
   - saved once per key: `manager_reviews`, `recommendations`, a mailbox `report` message, a review note in the manager's memory;
   - the owner gets a text from Owner HQ with a 12-hour `ADOPT` code.
4. **`ADOPT <ranks> <code>`** spends the `adopt_change` code and turns the chosen recommendations into standing
   lessons: long-term memory (`lesson`, never `decision`) for the target assistant and for the manager, plus the shared
   record. The finance plan writer receives its assistant's lessons as `ownerLessons` (rule 9).

A retried task resumes: the stored review is reused (no model is asked again), the code already sent stays valid, and
`adopt_recommendations` returns the same rows with `newly_adopted = false`.

## Questions through Code Mode

The owner's free text (when the front door picks the owner assistant or intent `status`) and the finance owner's free
text are answered in two steps: a Code Mode lookup with that assistant's read tools (`<id>.lookup`), then one model
call that words the answer (`<id>.answer`). The answer's numbers are traced to the lookup's result; if the answer
fails the trace, or the model fails, the owner gets the facts as they are ("Here's what I found: ...") and the receipt
says `refused`. A salon or online sender's question is saved as before.

## The read tools (`read-tools.ts`)

Read-only functions a Code Mode script calls as `codemode.<name>(args)`. Each validates its arguments with zod and
throws a plain sentence on a bad call, clamps limits to 50 rows, and returns no phone numbers, codes, hashes or message
bodies (only plan titles). A profile lists the names it allows; `pick` throws on a name that does not exist.

| name | args | returns |
|---|---|---|
| `get_finance_metrics` | `{ period }` | salon, online and combined metrics with their query hash |
| `get_online_metrics` | `{ period }` | the online metrics only |
| `recall_my_decisions` | `{ query, limit? }` | decisions in the **caller's** memory |
| `recall_decisions` | `{ assistant, query, limit? }` | decisions in any assistant's memory |
| `my_lessons` | `{}` | the caller's adopted lessons |
| `list_lessons` | `{ assistant? }` | adopted lessons from the database |
| `get_timeline` | `{ limit? }` | the newest events in the shared record |
| `list_work_reports` | `{ sinceHours, assistant?, limit? }` | reports with outcome, tokens, seconds, suggestions |
| `usage_summary` | `{ sinceHours }` | per-assistant tasks, outcomes, calls, tokens, average seconds |
| `open_items` | `{}` | open tasks and pending approvals per assistant (counts) |
| `latest_proposal` | `{}` | the newest plans: short id, titles, cited metric ids, decided or not |

## Wiring (what is left for the merge)

`WorkerDeps` has two new fields. `main.ts` sets them to a TEMP stub; the profiles lane replaces it.

```ts
codeMode: CodeModeRunner | null;   // null: the steps that need it fail with a plain sentence
profiles: {
  skill(id): string;               // the assistant's skill text
  model(id, job: 'code' | 'answer' | 'review'): string;
  reads(id): readonly string[];    // allowed read tool names
};
```

The review needs `profiles.reads('manager')` to include tools that can see the reports (`list_work_reports`,
`usage_summary`); a question needs the asker's own tools.

## Database

`20261027000000_manager_value.sql` adds the enum value; `20261027000100_manager.sql` adds the tables, the token columns on
`receipts`, the `adopt_change` approval action (`issue_approval` and `use_approval_code` keep their live bodies), and
`adopt_recommendations` (service role only). Every table has RLS on and no policies.

## Environment

- `REVIEW_MAX_TOKENS` (default 8000): the review writer's output cap.
