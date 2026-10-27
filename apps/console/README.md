# @fahq/console

**Owner: lane B (Cursor), after packages/data; wave 2 (the managers' reports, the head's own page, the PDF link): the delivery lane.**
Read-only Assistants console. The Divisions view and the live salon tab came from the briefs lane (`hq/div-brief`).

See [docs/architecture.md](../../docs/architecture.md) and [docs/LANES.md](../../docs/LANES.md). Other lanes: do not edit this folder.

`npm run console` serves it on `http://127.0.0.1:5180` (`CONSOLE_PORT` changes the port). GET and HEAD only; the service key stays on the server.

Six tabs: **Divisions** (the company at a glance, first), then one per department: Owner HQ, Finance, Online Customer Service,
**HQ Manager**, and the Salon (the stand-in for Cindy, read like the others).

- The **Divisions** tab (`GET /api/divisions`, [docs/divisions.md](../../docs/divisions.md), [docs/delivery.md](../../docs/delivery.md)) has a button for
  **Company**, **Finance**, **Online** and **Salon** (`#divisions/finance` opens one):
  - **Company** shows the latest **CEO digest** (the words the owner was sent); for each division its latest **brief** (status, headline, findings with
    the metrics they cite, actions with where each stands: approved, waiting for a code, code expired, not approved, no code sent); the **data requests**
    the divisions sent each other; and one line for each manager ("George, Finance, reports to Alan") with how the weekly report stands.
  - A **division's tab** shows its manager and head; the **weekly report** (summary; for Finance George's goal of the week and three paths with the
    arithmetic, test, stop-loss and risks, for the others up to three actions; what was asked of other divisions and the answers; a section for each
    worker; where each path or action stands); every **worker's latest report** (status, headline, findings with their metric ids, the rules that
    fired, the key numbers by unit, the row totals, the data source) and its **last seven days**; then the daily brief and the questions.
  - Each weekly report and each worker report links to its **PDF**, which the console renders on request from the stored report
    (`/report/weekly/<id>.pdf`, `/report/worker/<id>.pdf`): the same pages the head gets by email and on paper.
- A **head's own page**, `/?division=finance` (or `online`, `salon`), shows that division only: no tabs, no CEO digest, no other division's data (the
  server sends that division alone, and refuses another division's PDF). In production the heads' sites go into the Fortune Hub; the page's
  footer says so.
- Every department tab shows the assistant's tasks, **work reports** (its latest 15: outcome, summary, kind, model calls, tokens in and out, seconds, suggestions), activity (receipts, with tokens when present), mailbox, approvals (status only), texts, printouts and emails (codes blanked), memory and the shared record.
- The **HQ Manager** tab adds, above those:
  - **Usage, last 24 hours**: per assistant (all five), tasks, done, failed, model calls, input and output tokens;
  - **Latest review**: when, the window it covers, summary, findings, and its recommendations with their status (proposed, adopted, expired);
  - **Standing lessons**: adopted recommendations, newest first;
  - **Work reports**: the latest 30 across all assistants.
- `src/shape.ts` is the one place that decides what leaves the server: known fields only, six-digit codes blanked, phone numbers masked, strings capped, jsonb checked (a bad shape becomes a note, never a crash). Who decided a recommendation, and who approved a brief's action or a weekly report's path, is never read. A stored report is checked against its contract (`packages/contracts/src/reports.ts`) before it is shown.
- The tables are read with named columns, server side. A part that cannot be read says so on the page instead of showing as empty.
- The salon's tab says that Cindy's own app keeps her family and personal data and none of it is read here.

Tests: `npm test -- apps/console`. `divisions-db.test.ts` and `reports-db.test.ts` read the real local database (`npm run db:start`) and skip themselves when it
is not running; run them under `flock ~/.fahq-db-test.lock` like the other database tests.
