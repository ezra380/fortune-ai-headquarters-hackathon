# Lane W2, delivery and console (wave 2)

Branch `hq/w2-delivery`, worktree `~/fahq-w2-delivery`, cut from `hq/divisions-merge` at `16449bf`. Spec: [../wave2.md](../wave2.md). Details: [../delivery.md](../delivery.md).

## Slice 1: PDF, email, print (2026-10-27, from 11:05 ET)

### What works (and the tests that prove it)

- **Worker report PDF and weekly packet PDF**, on the brand kit's palette, numbers by unit, no phone number, address or code.
  `packages/delivery/test/report-pdf.test.ts`: "numbers by unit" (3 tests), "worker report PDF" (4), "weekly packet PDF" (10 with each division counted: each division,
  George's goal and three paths, actions and "asked", a missing worker report, no phone/address/code, unusual characters and the key-number cap,
  same bytes twice), "line wrapping" (1).
- **Sample PDFs** from synthetic fixtures: `docs/samples/finance-weekly-packet.pdf` (10 pages), `docs/samples/online-weekly-packet.pdf` (7 pages). Looked at
  page by page in a browser (pdf.js): cover, a path page, a worker page with rules and row totals, the online actions page.
- **Email through Postmark**: `DeliveryPort.sendEmail`. `packages/delivery/test/email.test.ts`: the documented request, another address refused before any
  network call, a list or a name part refused, sent once, the attachment, skipped without token or sender, no provider body in an error, one-line subject and
  attachment name, an oversize attachment refused.
- **The email text and HTML** (`buildWeeklyEmail`, `buildWorkerEmail`, on the port as `weeklyReportEmail` and `workerReportEmail`): labeled "For <head>", escaped,
  no code, the goal and the three paths.
- **Outbox**: `apps/worker/test/outbox-reports.test.ts` (14 tests, real delivery port over a fake fetch): weekly and worker report emails to `HQ_REPORT_TO` only with
  the PDF, built from the stored report (not the row text), once, skipped without token / address / report, failed plainly when the report is gone,
  retried on a 5xx at most three times, the provider body kept out of the row; printouts on the head's printer, skipped without one; the proposal printout as before.
- **Store reads**: `apps/worker/test/store-reports.test.ts` (4 tests, real local database, run under the lock).
- **Mutation checks** (each guard broken in turn, the tests seen to fail, then restored): recipient check, once-ledger, redirect, provider body, skip without token,
  scrub, long words, allowed set, email text from the row.

### Not done

- The console (slice 2).
- No live Postmark call was made, and none can be until a token and a verified sender exist: the request shape is checked against Postmark's documented
  `POST /email` fields with a fake fetch only.
- No real PrintNode printout of a report; the PrintNode request is the existing, tested one.
- PDF fonts are the standard ones (Times for Playfair Display, Helvetica for Lato); no logo or imagery.

### What the merge must know

- **Files outside this lane's own, all small:**
  - `packages/contracts/src/ports.ts`: the `DeliveryPort` section only (`renderWorkerReportPdf`, `renderWeeklyPacketPdf`, `weeklyReportEmail`, `workerReportEmail`,
    `sendEmail`) and the types `EmailResult`, `ReportEmail`, `ReportContext`, plus one type import from `reports.ts`.
  - `apps/worker/src/common.ts`: `WorkerDeps.reportTo?: string`.
  - `apps/worker/src/main.ts`: `reportTo` from `HQ_REPORT_TO`, and printers for `online` and `salon` (`PRINTNODE_PRINTER_ONLINE`, `_SALON`).
  - `apps/worker/src/store.ts`: `OutboxRow.channel` and `addOutbox`'s `channel` now accept `'email'` (**W1 needs the same one-word change; take either**), the import of
    the report schemas, and the "delivery reads (W2)" section at the end of the store object (`weeklyReportById`, `workerReportById`, `workerReportsByIds`) with a
    module-level `parseReport` after it. If W1's section also reads a report by id, keep one of the two.
- **What W1 must write into the outbox:** an `email` row and a `print` row (and the SMS) for each weekly report, with `attachment_ref = weeklyReportRef(id)`. The row's
  `to_person_id` is the head; the print row's printer is chosen by that person's assistant. `body` must be non-empty (the table requires it) but is never used for the
  email or the printout.
- **No migration** (the base's `20261027120000_division_reports.sql` already adds the `email` channel and the tables).
- `packages/delivery/src/pdf.ts`: `wrap` is exported and now cuts a word wider than the line (a regression test); the proposal PDF benefits too.
- Contracts and the migration were not changed.
