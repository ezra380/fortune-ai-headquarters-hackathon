# @fahq/console

**Owner: lane B (Cursor), after packages/data.** Read-only Assistants console.

See [docs/architecture.md](../../docs/architecture.md) and [docs/LANES.md](../../docs/LANES.md). Other lanes: do not edit this folder.

`npm run console` serves it on `http://127.0.0.1:5180`. GET and HEAD only; the service key stays on the server.

One tab per department: Owner HQ, Finance, Online Customer Service, **HQ Manager**, and the Salon placeholder (Cindy).

- Every live tab shows the assistant's tasks, **work reports** (its latest 15: outcome, summary, kind, model calls, tokens in and out, seconds, suggestions), activity (receipts, with tokens when present), mailbox, approvals (status only), texts (codes blanked), memory and the shared record.
- The **HQ Manager** tab adds, above those:
  - **Usage, last 24 hours**: per assistant, tasks, done, failed, model calls, input and output tokens;
  - **Latest review**: when, the window it covers, summary, findings, and its recommendations with their status (proposed, adopted, expired);
  - **Standing lessons**: adopted recommendations, newest first;
  - **Work reports**: the latest 30 across all assistants.
- `src/shape.ts` is the one place that decides what leaves the server: known fields only, six-digit codes blanked, phone numbers masked, strings capped, jsonb checked (a bad shape becomes a note, never a crash). Who decided a recommendation is never read.
- The new tables (`work_reports`, `manager_reviews`, `recommendations`) are read with named columns, server side. A part that cannot be read says so on the page instead of showing as empty.
