# Fortune HQ board: the server side

The owner's read-only window into **Fortune AI Headquarters** (a separate Supabase project, the HQ database):
each assistant's profile, live work, workers and their reports, the briefs and texts about to go out, what
went out, memory and mailbox. Branch `hq/fortune-hq-board`; a preview build, not on `main`.

## The endpoint

`GET /.netlify/functions/hq-board?tab=<company|finance|online|salon|manager|legal>` (no `tab`: `company`).

| Answer | When |
|---|---|
| 401 `{ "error": "login required" }` | No session (the same answer as every staff function). |
| 403 `{ "error": "Fortune HQ is for the owner only." }` | Signed in, but not an allowlisted Fortune admin. |
| 405 | Anything but GET, after the gate. |
| 400 `{ "error": "Unknown tab." }` | `tab` is not one of the six ids (checked before any read). |
| 503 `{ "error": "Fortune HQ data is not connected." }` | `FORTUNE_HQ_DB_URL` unset, or the HQ database cannot be reached. |
| 500 `{ "error": "Something went wrong. Try again." }` | The read transaction itself failed (the log has an error code only). |
| 200 | The contract below. |

## The gate (netlify/functions/hq-board.js, `boardScope`)

1. `requireAuth(event)` from `_lib/auth.js`: the session cookie, or the Hub's shared sign-in when it is on.
2. Fortune admin, exactly as `admin-users.js`: `role === 'admin'`, `tenant === 'fortune'`, and under the Hub
   sign-in only a Hub-issued session (`sharedAuth === true`). Ezra's account is role `admin`; role `owner`
   in this app is a tenant owner (Lakewood) and is refused.
3. The account row is read fresh (`getUserById`): active, still admin, still Fortune.
4. The allowlist `HQ_BOARD_USERS`: comma-separated emails or user ids, case and spaces ignored. Unset means
   `owner@example.com` only. A session with no account row (the legacy `STAFF_PASSWORD`) never passes.

`boardScope()` returns the tabs an account may open (all six, or none). Giving a division head their own login
later means returning that division's tab here, for example `['finance']` for Alan; the response's `tabs` list
and the tab check already follow it.

## Environment

| Variable | Meaning |
|---|---|
| `FORTUNE_HQ_DB_URL` | Postgres URL of the HQ Supabase pooler. Set by the deployer; never logged. Unset = 503. |
| `HQ_BOARD_USERS` | Optional allowlist; default `owner@example.com`. |

Plus what every staff function already needs (`SESSION_SECRET`, `DATABASE_URL`).

## How it reads (`_lib/hqBoardRead.js`, `_lib/hqBoardSql.js`, `_lib/hqBoardText.js`)

- One `begin read only` transaction per request, `set local statement_timeout = '8s'`, a pool of at most 2
  kept for warm invocations, TLS as the Hub's own pool (`_lib/db.js`).
- Every statement is a constant in `hqBoardSql.js` with `$n` parameters; `$1` is one of the fixed ids.
- Each part of a tab runs inside a savepoint: a part that fails is rolled back alone, falls back to empty,
  and is named in `tab.notes`, so one bad read never blanks the board.
- Never selected: approval code hashes (the `approvals` table is not read), door tokens, API keys, inbound
  texts, model spend, task payloads (only their `job` and `worker` names), who decided a recommendation.
- Every piece of text passes `cleanText()`: emails become `[email]`, credential shapes `[hidden]`, a phone in
  running text shows its last four digits, any six-or-more digit run or split code (`482-913`) is blanked
  `••••••`; then it is cut to its cap (previews 280). The profile's sending number and the head's phone are
  fields, not text, and are shown as stored (the board is the owner's).
- Lists are capped (60 mailbox and outbox rows, 300 worker-report rows, 200 memory items, 100 live tasks).

## The contract (200)

```text
{ generatedAt, tabs: [{ id, label, subtitle }],
  tab: { id, label,
    profile: { assistantId, name, title, reportsTo, phone, models: { job: model }, version, updatedAt, reads, lessonsInForce },
    head: { name, role, phone } | null,
    live: { running: [{ id, kind, label, since }], queued: [...] },        // queued includes tasks waiting for a code
    workers: [{ workerId, label, status, writtenBy, headline, findings: [{ text, cites }], reportDate, createdAt,
                history: [{ reportDate, status, headline }], note }],     // divisions only; note says "No report yet." or
                                                                           // "No client data is connected yet." (salon.clients)
    weekly: { weekOf, status, summary, ceoLine, goal, paths: [{ rank, title, summary }], actions, sections, createdAt } | null,
    brief: { date, status, headline, actions: [{ rank, title, why, steps }] } | null,
    outgoing: [{ id, channel, to, preview, status, queuedAt }],
    history: [{ id, channel, to, preview, status, at }],
    memory: [{ kind: lesson|note|decision|review|version, text, by, at }],
    mailbox: [{ direction, other, kind, preview, at }],
    company: { digest: { text, at } | null, divisions: [{ id, manager, head, status, ceoLine }] } | null,   // company tab
    manager: { latestReview, recommendations: [{ assistant, kind, text, status, appliedBy, at }],
               usage: [{ assistant, tasks, failed, modelCalls, tokens }] } | null,                         // manager tab
    legal: { doorReports: [{ tool, summary, at, reviewed }] } | null,                                       // legal tab
    notes: [string] } }                                                                                     // parts that could not be read
```

`to` in outgoing and history is the person's name, never a number. Joey (`company`) reports to Ezra; George,
Georgette and Cindy report to their division head (the `people` row's name); the HQ Manager and the Legal Team to Ezra.

## Tests

`test/hq-board.test.mjs` (in `npm test`): the gate through real sign-in, the allowlist rules, hostile tab
strings, 503 and 500 without driver words, the read-only transaction and parameters, the full contract shape,
code blanking, a failing part becoming a note, and the company, manager and legal tabs.
