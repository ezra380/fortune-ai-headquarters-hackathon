# The HQ Manager

Status: merged into `hq/foundation`; the worker runs with the real profiles and the Code Mode runner (script step with
reasoning on). Synthetic data only.

The HQ Manager is the sixth assistant id (`manager`). It has **no phone number and no person**: it reaches the owner
through Owner HQ's number. It reads what the other assistants did and what outside AI tools reported at a door, and it
recommends what should change in each assistant's profile in Supabase, its own included. **It learns by itself**
(Ezra, in writing, 2026-10-27): in the daily internal review, which reads work reports only, the worker applies its
lessons, skill notes and retires at once, as profile versions made by `manager`. Everything else waits for the owner's
one-time code (`ADOPT <n> <code>`) and is then written as a version made by `owner`. Every change has its reason and can
be put back from the history. It is read-only like every assistant: the worker applies what it recommends, by fixed
code, and the program (not the model) decides who applies what (see "Who decides what changes").

## The loop

1. **Every task ends with a report.** `runner.ts` keeps the receipts a task writes; after `finish_task` it builds a
   `WorkReport` (`reports.ts`: steps, usage, one deterministic sentence, suggestions from **rules**, never a model) and
   saves it (`work_reports`, one row per task, the latest attempt wins) and adds it to the shared record. A report that
   cannot be saved logs `worker.report_failed <task id prefix>` and never changes the task.
2. **`REVIEW`** (owner only) queues a `scheduled` task for `manager`, key `review:<task id>`, that reads both kinds of
   report (scope `all`). A daily job queues two more, quietly (see "The daily review").
3. **The review task** (`manager.ts`):
   - a Code Mode script (`manager.digest`) reads the work reports and, when this review reads them and the manager's
     profile can, the outside sessions' reports nobody has read yet (`list_session_reports`), and returns a small digest.
     The script is handed `list_session_reports` only then: the internal review's script never is;
   - what the digest carried from the doors is taken from the reader tool's output (every report it handed the script,
     `{ id, assistant }`, never the model's words);
   - one model call (`manager.review`) writes the `TypedManagerReview` (at most 3 recommendations, each about one
     assistant and of one **kind**, see below). It is also told which read tools exist, which models are in use, what
     each assistant has now, and each assistant's standing lessons and notes with who put each there (`standing`), so it
     can only name real ones;
   - the program checks it: the schema; every number traced to the digest (`numberTrace`, see "The number trace");
     no repeat of a lesson already in force; that **each change could really be made** (a dry run on the assistant's
     profile: the text rules, real read tools, the business wall, a model that is in use, a retire's exact words in the
     stored profile, and that it changes something); and, in the doors review, that each recommendation is about an
     assistant whose door filed a report it carried. One correction round with the exact objections, then a plain
     failure (in the doors review, a recommendation still about another door is dropped instead, with its reason on the
     `manager.review` receipt, and the rest stands if it passes);
   - saved once per key: `manager_reviews` (with `carried_reports` and `scope`), `recommendations` (with kind and typed
     detail), a mailbox `report` message, a review note in the manager's memory;
   - the outside reports the digest carries (by id) are marked read;
   - what the manager may apply by itself is applied now, unless a rule holds it (see "Who decides what changes"); the
     receipt `manager.apply` says what was applied, refused, left waiting, and held for the owner's code and why;
   - the owner gets a text from Owner HQ: what the manager changed (one line each: the assistant, the kind, the version
     and the words), what it would not apply and why, and what needs his code. A 12-hour `ADOPT` code is issued
     whenever something needs it.
4. **`ADOPT <ranks> <code>`** spends the `adopt_change` code and puts the chosen open recommendations into force: a
   new profile version made by `owner`. A rank the manager already applied is reported as "already in place" and is not
   redone. A lesson is also remembered in H-MEM (see "Lessons: the database is the source").

A retried task resumes: the stored review is reused (no model is asked again), the code already sent stays valid, and
every change finds what an earlier run already wrote instead of writing it twice (see "How a change is applied").

## Who decides what changes

**Ezra's approval, in writing, 2026-10-27** (answering "should the HQ Manager apply lessons by itself, with the
reviewer's two safety rules?"): *"100%. The HQ manager should apply lessons by itself, update itself, occasionally remove
outdated information, and learn and grow according to my needs."*

So the HQ Manager applies a lesson, a skill note and a retire by itself, in the review that reads no outside words. A
change of what an assistant may read, or of its model, always waits for the owner's code. The table is code
(`MANAGER_APPLIES` in `@fahq/contracts`: `{ lesson: true, skill_note: true, retire: true, reads: false, model: false }`,
pinned by a tripwire test), and the model's words never move a recommendation from one side to the other (it can write
`"applied": true` or "no code needed" and nothing happens, tested).

| kind | what it changes | internal daily review | doors daily review, and `REVIEW` that carried an outside report | `REVIEW` that carried none |
|---|---|---|---|---|
| `lesson` | adds one standing lesson to the profile's `lessons` (newest 50 kept; the newest ten reach every prompt) | the manager, by itself | the owner's code | the manager, by itself |
| `skill_note` | adds one line to the section `## Notes from the HQ Manager` at the end of the skill (newest 12 kept) | the manager, by itself | the owner's code | the manager, by itself |
| `retire` | takes one standing lesson, or one line of the notes, out again (outdated, a duplicate, or contradicted) | the manager, if it put the item there; else the owner's code | the owner's code | as in the internal review |
| `reads` | adds or removes read tools (`reads: { add, remove }`) | the owner's code | the owner's code | the owner's code |
| `model` | moves one job (`code`, `answer` or `review`) to a model another job already uses | the owner's code | the owner's code | the owner's code |

The owner reads what the manager changed under "I changed", one line each (`1. [finance] lesson, version 7: <words>`),
and what waits under "Needs your code" (`reads`, `model` and `retire` in the program's words: `Read tools: add
usage_summary`, `Model for answer: <name>`, `Retire from finance: <words>`).

### The two rules, and where each is enforced

The independent review of 2026-10-27 set two minimum rules before the manager could apply anything by itself. Both are
the program's, never the model's (`apps/worker/src/manager.ts`):

1. **A review whose digest carried any outside (door) report applies nothing by itself, whatever the kind**
   (`holdsWholeReview`). Its recommendations wait for `ADOPT`. The doors review applies nothing by itself in any case.
2. **A recommendation for an assistant other than the one whose door filed a carried report applies nothing by itself**
   (`holdsAcrossDoors`). Rule 1 covers it today; it is its own check so that relaxing rule 1 later can never open
   steering across doors. In the doors review the same rule is also a check on the review itself (`offDoors`): such a
   recommendation is sent back once, then dropped with its reason.

What a review carried is stored with it (`manager_reviews.carried_reports`: every report the reader tool handed the
digest script, `{ id, assistant }`, from the tool's output, whether or not the digest names it, since a script could copy
a report's words without its id), with its `scope`. Only the final Code Mode attempt's tool calls are known, and an
earlier attempt may have called the reader (its error goes back to the script model), so whenever the reader was handed
over and reports were waiting, every waiting report is stored as carried too. Every run of the task, a retry included,
decides from that stored row, so a retry decides exactly as the first run did. A row without it (older reviews: `null`)
fails closed: nothing applies by itself.

A **retire** also waits for the owner's code when the owner put the item there. The write itself decides it
(`applyRecommendation`, on the very row its version guard is based on), so an owner who adopts the same words between
the check and the write is never overruled; the recommendation stays open and is listed under "Needs your code". A
lesson records who put it there (`by`); only `by: "manager"` in the stored row counts as the manager's. A lesson with no
`by` (one stored before lessons recorded it) is the owner's for this purpose, and it stays without one: the stored shape
fills in no default, so writing the profile again, an `ADOPT` or a version put back never turns it into the manager's
(a model is still shown it as the manager's, the less trusted heading: `source.ts`). A note records it through the
recommendation that wrote it: the manager's only when an adopted `skill_note` recommendation applied by the manager
wrote those exact words (it has a version) and the owner never adopted them; a note written by hand, by a reseed or with
no record is the owner's. From now on every profile version also records the words a lesson or note added, or a retire
took out (`change.text`). A retired lesson or note no longer stands: `list_lessons` and the review writer's
`lessonsAlreadyAdopted` list lessons and notes only, without those a later retire took out.

### The split of the daily review

The manager learns by itself every day without ever reading outside words in the review that applies: the daily job
queues two reviews (see "The daily review"). The **internal** review reads the work reports only, and its digest script
is handed the manager's read tools minus `list_session_reports` (tested on the tools the runner received), so it carries
no outside report and its lessons, notes and retires apply after every check (schema, number trace, no repeat, dry run,
`checkChangeText`). The **doors** review reads only the outside reports nobody has read (when the manager's profile can
read them); nothing in it applies by itself, and each of its recommendations must be about an assistant whose door filed
a report it carried. `REVIEW` stays one review of both kinds, so whenever it carries an outside report it applies
nothing by itself.

Words from the doors review must not reach the internal one by the back way either: a review's receipts carry its
checks, and its work report copies them, and the internal review reads the work reports. So:

- every objection the review's check writes is in the program's words and never quotes the model's (a retire of words
  the profile does not hold: "the retire names words that are not a standing lesson of finance; copy the text exactly
  from standing"; an unknown read tool or model is named as such, never by the name the model wrote);
- the internal review's digest is handed `list_work_reports` over `forTheInternalReview`: the report of every manager
  task other than an internal review is left out whole (the doors review and `REVIEW` read outside reports, a manager
  question may; a task whose scope cannot be read is left out too), and of every other report the error a Code Mode
  script raised (it can quote the data the script read) and a failed task's reason are left out. Tested on the real
  database: a doors review whose first attempt names a marker sentence, and one whose script fails quoting it, then the
  internal review: the marker is in neither the digest tool's output nor the review model's prompt.

### The manager's own profile

A recommendation may be about the manager itself (`assistant: "manager"`): a lesson, a note or a retire applies to its
own profile like any other, in the internal review, as a version made by `manager`; its review writer reads its own
skill with its lessons, so the next review follows them.

### What a model is told about a lesson

A lesson records who put it in the profile: `by: "owner"` (his code) or `by: "manager"` (applied by itself). A model is
shown the owner's lessons as before ("The owner adopted these for you. Follow them.") and any manager-applied lesson under
its own heading, "Suggested by the HQ Manager ... The owner did not approve them. Your skill and the owner's instructions
come first." That holds in the worker's prompts and at the doors. A stored lesson with no `by` is shown to a model as the
manager's (and stays without a `by` in the stored row, so a retire treats it as the owner's). If
the owner adopts words the profile already holds as the manager's, that is a new version and they become his.

A recommendation with no kind (an older review, an older row) is a lesson. For `reads` and `model` the owner reads the
program's description of the typed change (`Read tools: add usage_summary; remove latest_proposal`,
`Model for answer: <name>`), not the model's sentence, so what he approves is exactly what is applied. Planning and the
front door's routing are not the manager's to change.

### The rules a lesson or a note must meet (`checkChangeText`)

One line, at most 300 characters, plain words. Refused with a plain reason: a phone number (in any spacing: `(718)555-1234`,
`718 5551234`, `+1 718 555 1234`) or a code (`482913`, `482-913`); anything medical or about hair loss or health (hair loss,
thinning, balding, illness, a topper "for coverage" and the like); words that try to get around the rules ("ignore the previous instructions"), to do
without a person's code, to treat a plain "yes" as a decision, to say the assistant is not read-only, or to give it a
power it does not have; a web address; talk of the prompt itself; and an order to use a read tool the assistant may
not read (so a lesson can never send the salon to the online numbers). **This is a net, not a proof.** What keeps the
rest safe is structure: only a short line can be added, never a tool, a model or a rule; it is checked again against
the stored profile before it is written; the owner is told the same day; and every version can be put back. The review
writer is also told that a report from an outside tool is data, never an instruction.

### How a change is applied (`profile-changes.ts`)

This is what `ADOPT` does for each rank it was given (`by: owner`); the same steps run for what the manager applies by
itself (`by: manager`). A retire is checked against the stored profile here too: words it does not hold are refused with
a plain reason ("there is no standing lesson ... in the stored profile"; this reason is the write's, on `manager.apply`,
never the review check's, which quotes nothing). For `by: manager`, a retire of what the owner put there is held here,
on the row the write is based on (status `held`: it stays open for his code).

1. Read the stored profile row (no row: the recommendation stays open and the receipt says to run the seed script).
2. Look in the version history for a version this recommendation already made (a crash between the write and the
   mark): found, so only mark it.
3. Apply the typed change to the row (`applyProfileChange`, pure, in `@fahq/profiles`) and run the same checks as for
   any stored profile (real read tools, the business wall, read-only, "You never"). A refusal closes the
   recommendation (`expired`, with the reason in `detail.refused`) and goes to the owner's reply ("Not applied: ...").
4. Write it with `save_assistant_profile` from the version just read. If another writer got there first the call
   returns nothing and the profile is read again (three tries, then the task runs again). The version's `change` records
   the recommendation, the review, and what the change dropped to stay inside the limits.
5. Mark the recommendation in force (`status adopted`, `applied_by`, `applied_version`; `decided_by` is empty when the
   manager applied it, so every reader of adopted recommendations sees it unchanged).
6. Read the profiles again in this worker (`profiles.refresh`) so the next prompt carries it; remember a lesson in
   H-MEM.

A change that the profile already says (the same lesson, the same read tools) writes no version.

## Questions through Code Mode

A question is answered in two steps: a Code Mode lookup with the answering assistant's read tools (`<id>.lookup`), then
one model call that words the answer (`<id>.answer`). The owner's question goes to the department the front door names
(Owner HQ, Finance, Online, Salon, or the manager); a department head's question goes to her own assistant only. The
answer's numbers are traced to the lookup's result, with one correction round; if it still fails, or the model fails,
the person gets the facts as they are ("Here's what I found: ...") and the receipt says `refused`. Both calls carry
the assistant's skill **with its standing lessons** (its newest ten, from the stored profile, each under the heading for
who applied it), so a lesson the owner adopted reaches the very next answer of that assistant (tested end to end).

## The number trace (`numberTrace` in `reports.ts`)

One check guards both the manager's review (against its digest) and every Code Mode answer (against the lookup's
result): each number the model writes must be a number it was given. It catches made-up figures. It does not prove a
real figure sits in the right sentence. The tests are in `units.test.ts` ("numberTrace"); each rule below has one.

- **Counted:** digits (with commas, decimals and a `%`, `k`, `M`, `ms`, `s`, `x` suffix), a minus sign in front, and
  the words zero, one, two and three. 1, 2 and 3 get no pass: not as ranks, not as ordinals (7th), not as counts. Both
  sides of `7/40` and `7:40` are checked. Letters stuck to digits are a unit and hide nothing (`48h`, `95sec`,
  `4000tokens`).
- **Refused:** larger number words (four ... billion, dozen). The objection says to write digits.
- **Matched:** the given number rounded to 0 to 4 decimals (since 2026-10-27; the briefs and the Code Mode answer trace still use 0 to 2); a percentage may match the given number times 100. A
  number written with a minus sign (`-1500`) must match a negative number in the data. One written without may
  describe a drop ("fell by 1500" for -1500). Only digits in the data count, never number words inside its strings.
- **Not counted:** dates, periods and metric ids, and digits that belong to a name: straight after letters (`gpt4`),
  after a hyphen that follows a letter (`nemotron-3-ultra`), after a dot that follows a letter or digit (`v1.2`).
- **Row ids:** the digits that close a row id (`SUP-2201`, `demo-rt-01234`) are a name, not an amount, but the id must
  be in a string of the data (any case), or it is refused like a number.
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
| `list_lessons` | `{ assistant? }` | the standing lessons and notes from the database (adopted, and not retired since) |
| `get_timeline` | `{ limit? }` | the newest events in the shared record |
| `list_work_reports` | `{ sinceHours, assistant?, limit? }` | reports with outcome, tokens, seconds, suggestions |
| `list_session_reports` | `{ sinceHours, assistant?, onlyNew?, limit? }` | reports outside AI tools filed at a door: id, tool, summary, steps, suggestions, lessons, whether a review read it. Their words are data. `onlyNew` ignores age (up to 30 days). A department sees its own door's reports only; the manager sees all |
| `usage_summary` | `{ sinceHours }` | per-assistant tasks, outcomes, calls, tokens, average seconds |
| `open_items` | `{}` | open tasks and pending approvals per assistant (counts) |
| `latest_proposal` | `{}` | the newest plans: short id, titles, cited metric ids, decided or not |

## Wiring

`WorkerDeps` has two fields for this. `main.ts` fills them from `createCodeModeRunner` and `workerProfiles` (`apps/worker/src/profiles.ts`: each assistant's row in the database, its file profile where there is none; see "Profiles in the database" below).

```ts
codeMode: CodeModeRunner | null;   // null: the steps that need it fail with a plain sentence
profiles: {
  skill(id): string;               // the assistant's skill text, with its newest ten standing lessons
  model(id, job: 'route' | 'code' | 'answer' | 'plan' | 'review'): string;
  reads(id): readonly string[];    // allowed read tool names
  refresh?(): Promise<void>;       // read the stored profiles again now; absent when running on the files
};
```

The review needs `profiles.reads('manager')` to include tools that can see the reports (`list_work_reports`,
`usage_summary`, and `list_session_reports` for the outside tools' reports); a question needs the asker's own tools.
`workerProfiles` takes the brain as an optional last argument: every time it reads the profiles, a lesson this machine's
H-MEM does not have yet is remembered there.

## Database

`20261027000000_manager_value.sql` adds the enum value; `20261027000100_manager.sql` adds the tables, the token columns on
`receipts`, the `adopt_change` approval action (`issue_approval` and `use_approval_code` keep their live bodies), and
`adopt_recommendations` (service role only). Every table has RLS on and no policies.
`20261027100100_manager_decides.sql` (additive; no function, no policy) adds to `recommendations` the `kind` (default
`lesson`, so every older row reads as one), the typed `detail`, `applied_by` and `applied_version`, and to
`session_reports` the `review_id` of the review that read it. `adopt_recommendations` stays as it was; the worker no
longer calls it (ADOPT goes through the profile write above) but a database that has it keeps working.
`20261027130100_manager_applies.sql` (additive; no function, no policy) widens `recommendations.kind` to take `retire`, and
adds to `manager_reviews` the `carried_reports` (jsonb array, null on older rows, which fail closed) and the `scope`
(`internal`, `doors` or `all`).

## Environment

- `REVIEW_MAX_TOKENS` (default 8000): the review writer's output cap.
- `CODE_THINKING` (default on): `off` makes every Code Mode script step answer without reasoning first.

## Profiles in the database

Each assistant's current profile is a row in `public.assistant_profiles`: title, skill text, the read tools it may use, a model for each job, the standing lessons a person adopted, and a version number. The files in `packages/profiles/skills` are the baseline and the seed. Migration `20261027100000_profiles.sql`; every table has RLS on and no policies.

- **The worker** reads the rows at start-up and again at most once a minute (`packages/profiles/src/source.ts`). An assistant with no row keeps its file profile. A row that breaks a rule is not used, the file profile stays, and the worker logs why. The rules: it names only real read tools, none twice; every read tool declares whose data it returns (`READ_SCOPE` in `rows.ts`: salon, online, both or none), and the salon never reads an online or both tool, the online store never a salon or both tool, the manager never a money tool (`MONEY_READS`: the finance metrics, the company overview, the budget room, the supplier invoices); the skill still says "read-only" and keeps its "You never" section. A database that cannot be read at start-up stops the worker with a plain message (`PROFILES_SOURCE=files` runs on the files, on purpose). After start-up a failed read keeps the last good profiles and is logged once. The skill text a model sees is the profile's skill, then its newest ten standing lessons if it has any.
- **Every change is a version.** `save_assistant_profile` (service role only) writes the row and appends a row to `assistant_profile_versions` in one transaction. The writer passes the version it last saw; if the profile has moved on, nothing is written and the function returns null, so two writers never overwrite each other. `made_by` is `seed`, `manager` or `owner`: what the owner approves or puts back is `owner`; `manager` is what the manager applied by itself (a lesson, a note or a retire; see "Who decides what changes"). The history is append-only: a trigger refuses update, delete and truncate for everyone, and the service role has no privilege to do them.
- **Seeding.** `npx tsx scripts/seed-profiles.ts` stores the profiles that have no row and leaves every other row as it is (it says which differ from the files). `--force` puts the files' title, skill, reads and models back as a new version and keeps the adopted lessons and the manager's notes at the end of the skill, **and the read tools and the model of each job whose latest change in the history was made by the owner** (what he approved with his code; the script prints `kept what the owner approved: reads, model answer`, and the version's `change` records it). To take an owner's choice back, put an earlier version back. The model names come from the environment at seed time, so after seeding a row decides, not `CODE_MODEL` and the like. The script writes to the local stack unless `--db <url>` or `SUPABASE_DB_URL` says otherwise; it never takes the database from `.env.local`.
- **The doors.** An outside AI tool gets a **door token** for one assistant: `npx tsx scripts/issue-door-token.ts <assistant> [label]` stores only the token's SHA-256 (`door_tokens`) and writes the token to `.local/door-tokens/<assistant>.token` (mode 600), printing only that path. With the public anon key and the token, a tool can call exactly two functions, as a POST:
  - `door_profile(p_token)` returns `{ assistant, title, version, skill, reads, models, lessons }` for the token's own assistant, nothing else.
  - `door_file_report(p_token, p_report)` stores a session report: `{ key?, tool, summary, steps[], suggestions[], lessons[] }`. Limits: 32 KB in all, a summary of 2000 characters, 30 steps, 10 suggestions, 10 lessons, no other field, 60 reports an hour per token. Each item of `steps`, `suggestions` and `lessons` is an object with its one field (`step` or `text`) and nothing else, so no other key is stored. Phone numbers in any spacing and six-digit codes (also `482-913`) are masked (`[phone]`, `[code]`) in every string and key before anything is stored, by the same definition the lesson rules and the read tools use (`packages/contracts/src/redact.ts`; a test runs one list of strings through the database and through it). The same `key` from the same token is stored once and answers `duplicate: true`.
  - A token that is wrong, revoked or missing gets one answer (403, "This token is not valid.") that says nothing about why. A token in a URL (a GET) is refused (405). Revoke one with `update public.door_tokens set revoked_at = now() where id = '<id>'`.

```bash
curl -s "$SUPABASE_URL/rest/v1/rpc/door_profile" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" \
  -H 'Content-Type: application/json' -d "{\"p_token\":\"$(cat .local/door-tokens/finance.token)\"}"
```

- **The MCP door** (`packages/codemode/src/serve.ts`) is how Claude Code, Cursor, Codex or Gemini use those two functions. It never takes a profile from the files unless told to:

  ```bash
  FAHQ_DOOR_TOKEN=$(cat .local/door-tokens/finance.token) SUPABASE_URL=... SUPABASE_ANON_KEY=... \
    npx tsx packages/codemode/src/serve.ts --profile finance          # Code Mode: one `code` tool  (SUPABASE_URL: https://, or http:// for localhost, 127.0.0.1 and [::1] only)
  ... serve.ts --token-file .local/door-tokens/finance.token --plain  # the read tools one by one; --profile is optional
  npx tsx packages/codemode/src/serve.ts --local [--profile owner]    # offline: the file profiles, no database, no report
  ```

  - **The profile comes from the database.** `door_profile` is called once at start-up with the public anon key (a service key is refused) and the token, as a POST. The answer is checked with the same rules the worker applies (real read tools only, none twice, the business wall, "read-only", "You never"); a stored profile that breaks one is not served and the door stops with the reason. A token belongs to one assistant, so `--profile` is optional and must match it. Nothing falls back to the files: a refused token, an unreachable database or a missing profile stops the door with one plain sentence (exit 2); `--local` is the only way to the files.
  - **The tools are the profile's reads that the door can serve** (`DOOR_READS` in `brain-mcp.ts`), all read-only, and exactly one write, `file_work_report`. The stored profile decides which of them: a manager edit that removes a read removes the tool at the next start. In Code Mode the sandbox sees the reads only; `file_work_report` sits beside the `code` tool and is not callable from a script.
  - **The `skill` prompt is true at this door.** It is the stored skill, with "You can read" rebuilt from the tools the door really offers (the skill's own line for each, the tool's description where it has none), every other line that names a read tool the door lacks left out, and the newest standing lessons added (the owner's under his heading, any the manager applied by itself under theirs). "End of work" tells the tool to call `file_work_report` once when its work is done (an older stored skill that still says "you do nothing for it" is corrected at the door); a `--local` door says it has no database to file in.
  - **`file_work_report({ summary, steps?, suggestions?, lessons? })`** is how a session sends its end-of-work log and the lessons it suggests to the HQ Manager. Plain strings: a summary of 1 to 2000 characters, at most 30 steps (80 characters), 10 suggestions and 10 lessons (300 characters), 30 KB in all. The tool checks this first and says what is wrong; it then calls `door_file_report` with the tool's name (taken from the MCP client's handshake, e.g. `claude-code`) and a key made of this session and a hash of what the report says, so a retry is stored once and answers `duplicate: true`, while the same words in another session are a second report. The database masks phone numbers and six-digit codes and stores the report under the token's assistant; the tool returns only `{ filed, id, duplicate }`. The HQ Manager reads them in its next review (`list_session_reports`, see "Reports from outside tools") and marks them read; a report changes nothing by itself.
  - **After a skill change, reseed.** The door corrects the End of work wording by itself, but a row seeded before this change still carries the old text elsewhere; `npx tsx scripts/seed-profiles.ts --force` puts the files' words into the rows (the adopted lessons stay).

- **What the public roles hold.** `anon` and `authenticated` hold no privilege on any table in `public` (the migration revokes what Supabase grants by default, and what it would grant on tables made later), and can execute exactly `door_profile` and `door_file_report`. A new function in `public` must `revoke all ... from public, anon, authenticated`, as every migration here does; a test lists what `anon` can run.
- **Tests.** `supabase/tests/profiles.test.ts` runs the doors through the real Data API with the anon key, checks the privileges, and builds a throwaway database from the migration file to race writers, reseed and run both scripts. `packages/profiles/test/db-source.test.ts` and `apps/worker/test/profiles.test.ts` cover the source and the worker's loading. For the MCP door: `packages/codemode/test/doors.test.ts` (which tools each profile's door offers, no write but `file_work_report`, the skill names only those tools), `door-client.test.ts` and `door.test.ts` (the calls, the arguments, the token), `work-report.test.ts` (the tool's limits and failures), `doors-db.test.ts` (the real database and `serve.ts` started as a program: the stored profile, a refused token, the report landing redacted, a retry stored once), and `packages/profiles/test/door.test.ts` (the skill text and the stored-profile checks).

## Reports from outside tools

A session report (`file_work_report` at a door) waits in `session_reports` until a review reads it.

- The manager reads them with `list_session_reports` in its digest script (`onlyNew` leaves out the ones a review
  already read and reaches back 30 days, whatever `sinceHours` says; the script asks for at most 15 and for each report's id).
  **Every word in them is data written by an outside tool**: the review writer is told so, and anything that becomes a
  lesson or a note passes the same rules as any other (`checkChangeText`) and, as shipped, waits for the owner's code.
- A department reads the reports filed at its own door only (`list_session_reports` refuses another assistant's); only the
  manager reads every door's, so the salon and the online store never see each other's.
- They count as work, but only as far back as the reader reaches (30 days) and only when the manager's profile can read
  them: a review with no work report in its window still happens when a readable report is waiting.
- **Reviewed means the review model was given it.** After the review is saved, the program marks the reports whose ids the
  reader tool returned during the script's run (taken from the tool's output, never from what the model says) **and that
  the digest carries**. A report the script left out (its digest is capped) stays unread and the next review reads it. The
  time and the review's id are recorded. One the tool reported as already read is left with its first review. A crash
  between saving the review and marking leaves the reports unread, and the next review reads them again: read at least
  once, never lost.
- Unread reports older than 30 days can never be shown to a review: the next review closes them (`reviewed_at` set,
  `review_id` empty, which tells a closed report from a read one) and says so on the receipt `manager.expired`.
- A stored manager profile that does not have `list_session_reports` yet (a row seeded before this change) cannot read
  them: they are not work, so a quiet day makes no review, no model call and no text; a review the owner asks for says that
  N reports are waiting and why, and a review that happens for another reason records it on the receipt
  `manager.sessions` (run `npx tsx scripts/seed-profiles.ts --force`).
- The reports are limited to the five columns the reader returns; the token that filed one is never read.

## The daily review

`queueDailyReview(deps)` (`manager-daily.ts`, exported from `manager.ts`) queues today's two reviews of the last 24 hours,
each as the same kind of scheduled task `REVIEW` queues, with `quiet: true`, so a day with nothing to review sends no text:

- `review:daily:<New York day>`, scope `internal`: the work reports only; it may apply lessons, notes and retires by itself;
- `review:doors:<New York day>`, scope `doors`: every outside report nobody has read, up to 30 days back, if the manager
  can read them; nothing in it applies by itself.

Each key is the day in New York, so calling it again the same day, from one process or two, queues nothing more and
answers `{ internal: { queued: false, key }, doors: { queued: false, key } }`. **The worker's daily clock calls it** at
09:00 New York time (the `manager-review` job in `scheduler.ts` `SCHEDULE`, after the 08:00 briefs and the 08:30 digest).
Tests: `digest.test.ts` "holds the HQ Manager's daily review at 09:00 ..." and "queues two quiet review tasks keyed by the
New York day ...". `FAHQ_SCHEDULE=off` turns the clock off, and the review is then only asked for by `REVIEW`.

## Lessons: the database is the source

The standing lessons of an assistant are the `lessons` of its profile row. Everything else reads from there:

- **Code Mode and the door.** The skill text a model sees is the profile's skill plus its newest ten lessons
  (`skillWithLessons`, also in the door's `skill` prompt and `door_profile`). A lesson reaches the assistant's next lookup
  and answer, in any worker that has read the row (this worker at once after a change, others within a minute).
- **H-MEM is a cache.** The plan writers and the `my_lessons` tool read lessons from Meterless H-MEM on the machine they
  run on. Every time a worker reads the profiles it remembers the lessons it does not have yet (one memory per lesson,
  keyed by the recommendation), so a lesson adopted on another machine reaches this one within the minute. A lesson applied here
  is remembered here at once. **It is a two-way copy**: a copy of a profile lesson (tagged `profile`) that the stored row no
  longer holds, because a version was put back or the 50-lesson limit let it go, is replaced by a "lesson taken back" note and
  stops reaching the plan writers and `my_lessons` at the next read of the profiles (the manager's "For <assistant>: ..." copy
  too). The lesson stays in H-MEM's history, and if the profile holds it again it is remembered again. A lesson that is not a
  copy of a profile lesson (adopted before profiles were stored) is never touched. `list_lessons` lists the adopted lessons
  and notes that a later retire did not take out (a version put back by hand is not tracked there: `my_lessons` is what is
  in force).
- Lessons adopted before this change are in `recommendations` (and in the H-MEM of the machine that adopted them), not in a
  profile row. They are not copied across; `list_lessons` still shows them.

## Putting a version back

Every profile version is kept with who made it and why, so any change can be undone. `npx tsx scripts/revert-profile.ts
<assistant> --list` shows the versions; `... <assistant> <version>` writes that version's title, skill, read tools, models
and lessons as a **new** version made by `owner` ("put back version 3"). It refuses a version that no longer passes
the rules (a read tool that was removed since), and a profile that changed while it was being put back. Nothing in the
history is edited, so the undo can be undone the same way. A lesson the old version does not have stops reaching the
plan writers within the minute (see "Lessons: the database is the source"). Reseeding with `--force` afterwards keeps
what the owner approved, so a put-back is also how an owner's choice is taken back on purpose.

## Tests for what the manager decides

- `packages/contracts/test/typed-change.test.ts`: the kinds (retire with its target, exact text and why), what each needs, an older recommendation is a lesson, and the table `{ lesson, skill_note, retire: true; reads, model: false }` (a tripwire); `redact.test.ts`: the phone and code masks.
- `packages/profiles/test/changes.test.ts`: every rule a lesson, a note, a read-tool change and a model change must meet, with a case for each (every phone spacing, a code in two groups, the health words); the notes section; the limits that drop the oldest; who applied a lesson; a retire of a lesson or a note by its exact text, refused when the words are not there, and who put a lesson there (`lessonAddedBy`: no record is the owner's). `db-source.test.ts`: the profile source, a forced read when one is already under way, and the skill text for the owner's lessons and the manager's. `seed-owner.test.ts`: which choices a reseed keeps.
- `apps/worker/test/manager-decides.test.ts` (real database and Meterless, profile tables in memory): with the manager switched off (`deps.managerApplies` all false), a lesson and a note wait and ADOPT writes them as the owner's; the model's words change nothing; a read and a model always wait; rule 1 (a REVIEW that carried an outside report holds everything, and says so on `manager.apply`), rule 2 on its own, a report from one door holding a lesson for another; every refusal; outside reports (marked only when the digest carries them, windowed to 30 days, closed when older, ignored when the profile cannot read them); the two daily reviews and their quiet day; lessons reaching the next Code Mode answer under the right heading, another machine's H-MEM, and leaving the plan writer and `my_lessons` when a version is put back. As shipped: a note and a lesson applied with no code and a version made by the manager; several in order; the 50-lesson limit; the profile moved on; another writer getting in first; a crash between the write and the mark. The split and retire ("the internal review learns by itself ..."): the internal review's script never handed `list_session_reports` and its lesson applied; a retry of a review that carried an outside report, and a stored review with no record, apply nothing; the doors review holds everything and refuses, then drops, a recommendation about another door, and ADOPT still works; a retire of the manager's lesson applied with no code, its H-MEM copy taken back; a retire of the owner's lesson held and adopted by code; a retire of words the profile does not hold refused; a note the manager wrote retired by itself and a hand-written note held; the manager's own profile updated. Review fixes: a doors review's objection and script error never reach the internal review's digest or prompt; a REVIEW whose final script never called the reader still counts the waiting reports as carried; a lesson with no `by` stays the owner's after the manager writes the profile in the same review; the write itself holds a retire of the owner's lesson; `list_lessons` drops a retired lesson and the retire itself; and, with no database, `forTheInternalReview` leaves out every manager task but an internal review, and script errors and failure reasons from the rest.
- `apps/worker/test/manager.test.ts`: the whole loop REVIEW, check, ADOPT, replay, with the manager switched off, and as shipped (the manager's own application, and ADOPT reporting what it already applied).
- `apps/worker/test/profile-lessons.test.ts`: the H-MEM copy of the profile lessons in step with the stored profiles.
- `apps/worker/test/store-manager.test.ts`: the store's calls on the real database and Data API (nothing writes a profile version there: it cannot be taken back).
- `supabase/tests/profiles.test.ts`: `--force` keeps the manager's notes and the owner's reads and models; putting a version back (nothing in the history changes, the undo can be undone, a stale version or a racing writer is refused, a retired lesson comes back with its `by` and a lesson with none stays without one), and `revert-profile.ts` and `seed-profiles.ts` run as programs; the database masks what `@fahq/contracts` masks; a door list item holds one field.
