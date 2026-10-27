# Lane notes: wave 2, the HQ Manager learns by itself (`hq/w2-manager`)

Cut from `hq/divisions-merge` at `523656f`. Ezra's written approval of 2026-10-27 ("100%. The HQ manager should apply
lessons by itself, update itself, occasionally remove outdated information, and learn and grow according to my needs")
is the Class 1 decision docs/manager.md reserved to him. Built with the independent review's two minimum rules.
Synthetic data only. The name Joey for the CEO assistant is the main session's, at merge: nothing is renamed here.

## What works (with the tests that prove it)

- **A. The table.** `MANAGER_APPLIES = { lesson: true, skill_note: true, retire: true, reads: false, model: false }`
  (`packages/contracts/src/schemas.ts`), pinned by `typed-change.test.ts` "says so for every kind ..." (seen failing on
  the old table first). The model's own words still move nothing: `manager-decides.test.ts` "does not let the review
  model's own words move a change ..." and "decides who applies by the kind the program reads ...".
- **B. The two rules**, the program's (`apps/worker/src/manager.ts`):
  1. `holdsWholeReview`: a review whose digest carried any outside report, or the doors review, applies nothing by
     itself; a stored review with no record (`carried_reports` null, older rows) or no scope fails closed.
  2. `holdsAcrossDoors`: a recommendation about another assistant than the one whose door filed a carried report
     applies nothing by itself (its own check, tested on its own with rule 1 set aside).
  What a review carried is persisted (`manager_reviews.carried_reports`, `scope`) from the reader tool's output (every
  report the tool handed the script, whether or not the digest names it), and every run decides from the stored row.
  Tests: "rule 1: writes no profile version for a REVIEW that carried an outside report ...", "rule 1 on a retry: the
  stored record ... decides", "fails closed on a stored review with no record ...", "rule 2 is its own check ...",
  "does not let a report filed at one assistant's door put a lesson into another assistant's profile ...", "holds even
  the good lesson of a review that read a report with bad words in it ...".
- **C. The split.** `queueDailyReview` queues `review:daily:<NY day>` (scope `internal`: work reports only; the digest
  script gets the manager's read tools minus `list_session_reports`) and `review:doors:<NY day>` (scope `doors`: the
  unread outside reports only; nothing applies by itself; each recommendation must be about an assistant whose door filed
  a carried report, refused once with the reason, then dropped with its reason on the `manager.review` receipt). Both
  quiet, keyed by the day, queued by the existing 09:00 `manager-review` job. `REVIEW` is scope `all`. Tests: "internal:
  hands the digest script no reader of the outside reports ...", "doors: applies nothing by itself, refuses then drops
  ...", "queues two reviews a day ...", "sends no text on a day with nothing to review ...", and `digest.test.ts`
  "queues two quiet review tasks keyed by the New York day ...".
- **D. Retire.** A new kind with typed detail `{ target: 'lesson' | 'note', text, why }`. The exact text must be in the
  stored profile (the review's check, with the correction round, and again at the write: "there is no standing lesson
  ... in the stored profile"). It applies by itself only when the manager put the item there: a lesson with `by:
  'manager'` in the raw row (`lessonAddedBy`; no `by` is the owner's); a note when an adopted `skill_note`
  recommendation applied by the manager wrote those words (it has a version) and the owner never adopted them
  (`noteAddedBy`); a hand-written note is the owner's. The owner's waits, shown as "Retire from <assistant>: <text>".
  Each retire is a new profile version (reversible with `scripts/revert-profile.ts`), and the version records the words
  (`change.text`, also for lessons and notes from now on). The review writer gets `standing`: each assistant's newest 20
  lessons and its notes, with who put each there. Tests: `changes.test.ts` "a retire" (4) and "words a retire ...",
  `typed-change.test.ts` "takes a retire ...", and in `manager-decides.test.ts` "retire: takes out a lesson the manager put
  there with no code ... its H-MEM copy is taken back", "retire: what the owner put there waits ... ADOPT takes it out;
  words the profile does not hold are refused", "retire: a note the manager wrote goes with no code; a note with no record
  ... waits".
- **E. Its own profile.** A lesson, note or retire about `manager` applies in the internal review (nothing refused it
  before). Test: "updates its own profile in the internal review ...".
- **F. What Ezra reads.** "I changed" lines name the assistant, the kind, the version and the words
  (`1. [finance] lesson, version 7: <words>`; a retire: `1. [finance] retire, version 8: <words>`); "Needs your code"
  still lists what waits; the doors review's text starts "HQ Manager review of the outside reports". No new command.
- **G. Docs.** `docs/manager.md` ("Who decides what changes": Ezra's words, the table, the two rules and where each is
  enforced, the split, retire, the manager's own profile; the daily review; the database; the tests) and
  `packages/profiles/skills/manager/SKILL.md` (the kinds and the split; its read-only and "You never" sections kept).

## Proof

- `npm run typecheck`: clean.
- Full suite under the lock (`flock ~/.fahq-db-test.lock npm test`, 14:16 ET): 1241 passed, 4 failed. Mine was the
  manager skill growing past the six-section, 48-line skill test; fixed in the next commit and rerun green
  (`packages/profiles/test/profiles.test.ts`, the door tests). The other three are not this lane's:
  `apps/worker/test/profiles.test.ts` (2) fail on any branch without `legal` in `AssistantId` because the legal lane
  stored a `legal` row in the shared local `assistant_profiles` ("assistant_id: Invalid option"); they pass once the
  legal lane is merged. `departments.test.ts` "stops when asked, and a loop that finds nothing waits ..." is a timing
  test of the claim loops: rerun on its own under the lock at 14:18 ET, 24 of 24 passed.
- After the skill fix (`ebff9ff`): `packages/profiles/test/profiles.test.ts`, `packages/profiles/test/door.test.ts` and
  `packages/codemode/test/doors.test.ts`, 75 of 75 passed.
- `manager-decides.test.ts` (45, the 9 new ones among them) and `manager.test.ts` all green in the full run.

## Not done

- The DB-backed tests in `manager-decides.test.ts` were written alongside the code, not run against the old code
  first (the file imports the new exports, so on the old code it fails as a whole). The pure tests (contracts, profiles)
  were seen failing first.
- `standing` shows the newest 20 lessons of each assistant; an older one can only be retired by the owner's revert.
- `list_lessons` and `lessonsAlreadyAdopted` list every adopted recommendation, a retire's row included (as they already
  did for reads and model rows).

## What the merge must know

- **Migration** `supabase/migrations/20261027130100_manager_applies.sql` (additive: widens `recommendations_kind_check`
  to take `retire`; adds `manager_reviews.carried_reports jsonb` and `scope text`, both nullable). Applied once to the
  shared local stack with a transaction and recorded in `supabase_migrations.schema_migrations` (`20261027130100`,
  `manager_applies`). The cloud project needs it before the worker with this code runs there.
- **Reseed** the manager's profile (`npx tsx scripts/seed-profiles.ts --force`) so the stored skill carries the new
  "The kinds of change, and who applies them" section; the adopted lessons and notes stay.
- **Files touched outside the lane's list:** `apps/worker/src/store.ts` (manager functions only: `saveManagerReview`
  takes `carried`/`scope`, `ReviewRow` has the two columns, new `skillNotesInForce`); `apps/worker/test/digest.test.ts`
  (the 09:00 job's test now expects the two tasks); `packages/profiles/src/index.ts` (exports `lessonAddedBy`). The
  `AssistantId` enum and the assistant lists are untouched: a `legal` assistant gets the same rules with no change here
  (`standingOf` and `modelsInUse` walk `AssistantId.options`).
- **Merging with the workers lane:** the 09:00 `manager-review` line in `SCHEDULE` is unchanged apart from its comment;
  `queueDailyReview` now returns `{ internal, doors }`.
- No new environment variable. `.local/meterless` was fetched into this worktree with `scripts/setup-meterless.sh` for
  the DB tests.
