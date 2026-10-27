# The HQ Manager

Status: merged into `hq/foundation`; the worker runs with the real profiles and the Code Mode runner (script step with
reasoning on). Synthetic data only.

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
   - every number in it is traced to the digest (`numberTrace`, see "The number trace" below); one correction round,
     then a plain failure;
   - saved once per key: `manager_reviews`, `recommendations`, a mailbox `report` message, a review note in the manager's memory;
   - the owner gets a text from Owner HQ with a 12-hour `ADOPT` code.
4. **`ADOPT <ranks> <code>`** spends the `adopt_change` code and turns the chosen recommendations into standing
   lessons: long-term memory (`lesson`, never `decision`) for the target assistant and for the manager, plus the shared
   record. The finance plan writer receives its assistant's lessons as `ownerLessons` (rule 9).

A retried task resumes: the stored review is reused (no model is asked again), the code already sent stays valid, and
`adopt_recommendations` returns the same rows with `newly_adopted = false`.

## Questions through Code Mode

A question is answered in two steps: a Code Mode lookup with the answering assistant's read tools (`<id>.lookup`), then
one model call that words the answer (`<id>.answer`). The owner's question goes to the department the front door names
(Owner HQ, Finance, Online, Salon, or the manager); a department head's question goes to her own assistant only. The
answer's numbers are traced to the lookup's result, with one correction round; if it still fails, or the model fails,
the person gets the facts as they are ("Here's what I found: ...") and the receipt says `refused`.

## The number trace (`numberTrace` in `reports.ts`)

One check guards both the manager's review (against its digest) and every Code Mode answer (against the lookup's
result): each number the model writes must be a number it was given. It catches made-up figures. It does not prove a
real figure sits in the right sentence. The tests are in `units.test.ts` ("numberTrace"); each rule below has one.

- **Counted:** digits (with commas, decimals and a `%`, `k`, `M`, `ms`, `s`, `x` suffix), a minus sign in front, and
  the words zero, one, two and three. 1, 2 and 3 get no pass: not as ranks, not as ordinals (7th), not as counts. Both
  sides of `7/40` and `7:40` are checked. Letters stuck to digits are a unit and hide nothing (`48h`, `95sec`,
  `4000tokens`).
- **Refused:** larger number words (four ... billion, dozen). The objection says to write digits.
- **Matched:** the given number rounded to 0, 1 or 2 decimals; a percentage may match the given number times 100. A
  number written with a minus sign (`-1500`) must match a negative number in the data. One written without may
  describe a drop ("fell by 1500" for -1500). Only digits in the data count, never number words inside its strings.
- **Not counted:** dates, periods and metric ids, and digits that belong to a name: straight after letters (`gpt4`),
  after a hyphen that follows a letter (`nemotron-3-ultra`), after a dot that follows a letter or digit (`v1.2`).
- **Not covered:** other words for numbers (once, twice, both, half, "no failures"), and a digit run straight after
  letters inside a duration such as `1h30m` (the 30 reads as part of a name).
- **Side effect:** "one" is read as the number 1, so an idiom such as "One thing to check" is refused when the digest has
  no 1. The review gets its correction round; an answer falls back to the plain facts.

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

## Wiring

`WorkerDeps` has two fields for this. `main.ts` fills them from `createCodeModeRunner` and `workerProfiles` (`apps/worker/src/profiles.ts`: each assistant's row in the database, its file profile where there is none; see "Profiles in the database" below).

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
- `CODE_THINKING` (default on): `off` makes every Code Mode script step answer without reasoning first.

## Profiles in the database

Each assistant's current profile is a row in `public.assistant_profiles`: title, skill text, the read tools it may use, a model for each job, the standing lessons a person adopted, and a version number. The files in `packages/profiles/skills` are the baseline and the seed. Migration `20261027100000_profiles.sql`; every table has RLS on and no policies.

- **The worker** reads the rows at start-up and again at most once a minute (`packages/profiles/src/source.ts`). An assistant with no row keeps its file profile. A row that breaks a rule is not used, the file profile stays, and the worker logs why. The rules: it names only real read tools, none twice; the salon never reads online or combined numbers, the online store never reads salon or combined numbers, the manager never reads the finance metrics; the skill still says "read-only" and keeps its "You never" section. A database that cannot be read at start-up stops the worker with a plain message (`PROFILES_SOURCE=files` runs on the files, on purpose). After start-up a failed read keeps the last good profiles and is logged once. The skill text a model sees is the profile's skill, then its newest ten standing lessons if it has any.
- **Every change is a version.** `save_assistant_profile` (service role only) writes the row and appends a row to `assistant_profile_versions` in one transaction. The writer passes the version it last saw; if the profile has moved on, nothing is written and the function returns null, so two writers never overwrite each other. `made_by` is `seed`, `manager` or `owner`. The history is append-only: a trigger refuses update, delete and truncate for everyone, and the service role has no privilege to do them.
- **Seeding.** `npx tsx scripts/seed-profiles.ts` stores the profiles that have no row and leaves every other row as it is (it says which differ from the files). `--force` puts the files' title, skill, reads and models back as a new version and keeps the adopted lessons. The model names come from the environment at seed time, so after seeding a row decides, not `CODE_MODEL` and the like. The script writes to the local stack unless `--db <url>` or `SUPABASE_DB_URL` says otherwise; it never takes the database from `.env.local`.
- **The doors.** An outside AI tool gets a **door token** for one assistant: `npx tsx scripts/issue-door-token.ts <assistant> [label]` stores only the token's SHA-256 (`door_tokens`) and writes the token to `.local/door-tokens/<assistant>.token` (mode 600), printing only that path. With the public anon key and the token, a tool can call exactly two functions, as a POST:
  - `door_profile(p_token)` returns `{ assistant, title, version, skill, reads, models, lessons }` for the token's own assistant, nothing else.
  - `door_file_report(p_token, p_report)` stores a session report: `{ key?, tool, summary, steps[], suggestions[], lessons[] }`. Limits: 32 KB in all, a summary of 2000 characters, 30 steps, 10 suggestions, 10 lessons, no other field, 60 reports an hour per token. Phone numbers and six-digit codes are masked (`[phone]`, `[code]`) in every string and key before anything is stored; numbers and booleans are left alone. The same `key` from the same token is stored once and answers `duplicate: true`.
  - A token that is wrong, revoked or missing gets one answer (403, "This token is not valid.") that says nothing about why. A token in a URL (a GET) is refused (405). Revoke one with `update public.door_tokens set revoked_at = now() where id = '<id>'`.

```bash
curl -s "$SUPABASE_URL/rest/v1/rpc/door_profile" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" \
  -H 'Content-Type: application/json' -d "{\"p_token\":\"$(cat .local/door-tokens/finance.token)\"}"
```

- **What the public roles hold.** `anon` and `authenticated` hold no privilege on any table in `public` (the migration revokes what Supabase grants by default, and what it would grant on tables made later), and can execute exactly `door_profile` and `door_file_report`. A new function in `public` must `revoke all ... from public, anon, authenticated`, as every migration here does; a test lists what `anon` can run.
- **Tests.** `supabase/tests/profiles.test.ts` runs the doors through the real Data API with the anon key, checks the privileges, and builds a throwaway database from the migration file to race writers, reseed and run both scripts. `packages/profiles/test/db-source.test.ts` and `apps/worker/test/profiles.test.ts` cover the source and the worker's loading.
