# @fahq/console

**Owner: lane B (Cursor), after packages/data.** Read-only Assistants console. The Divisions view and the live salon tab came
from the briefs lane (`hq/div-brief`).

See [docs/architecture.md](../../docs/architecture.md) and [docs/LANES.md](../../docs/LANES.md). Other lanes: do not edit this folder.

`npm run console` serves it on `http://127.0.0.1:5180`. GET and HEAD only; the service key stays on the server.

Six tabs: **Divisions** (the company at a glance, first), then one per department: Owner HQ, Finance, Online Customer Service,
**HQ Manager**, and the Salon (the stand-in for Cindy, read like the others).

- The **Divisions** tab (`GET /api/divisions`, [docs/divisions.md](../../docs/divisions.md)) shows:
  - the latest **CEO digest** (the words the owner was sent);
  - for each division, its latest **brief**: status, headline, findings with the metrics they cite, and actions with where each
    stands (approved, waiting for a code, code expired, not approved, no code sent);
  - the **data requests** the divisions sent each other: from, to, the question, when asked and when answered, or why it could not be.
- Every department tab shows the assistant's tasks, **work reports** (its latest 15: outcome, summary, kind, model calls, tokens in and out, seconds, suggestions), activity (receipts, with tokens when present), mailbox, approvals (status only), texts (codes blanked), memory and the shared record.
- The **HQ Manager** tab adds, above those:
  - **Usage, last 24 hours**: per assistant (all five), tasks, done, failed, model calls, input and output tokens;
  - **Latest review**: when, the window it covers, summary, findings, and its recommendations with their status (proposed, adopted, expired);
  - **Standing lessons**: adopted recommendations, newest first;
  - **Work reports**: the latest 30 across all assistants.
- `src/shape.ts` is the one place that decides what leaves the server: known fields only, six-digit codes blanked, phone numbers masked, strings capped, jsonb checked (a bad shape becomes a note, never a crash). Who decided a recommendation, and who approved a brief's action, is never read.
- The tables are read with named columns, server side. A part that cannot be read says so on the page instead of showing as empty.
- The salon's tab says that Cindy's own app keeps her family and personal data and none of it is read here.

Tests: `npm test -- apps/console`. `divisions-db.test.ts` reads the real local database (`npm run db:start`) and skips itself when it is not running.
