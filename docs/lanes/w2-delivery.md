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

## Slice 2: the console (2026-10-27, from 11:30 ET)

Details: [../delivery.md](../delivery.md), "The console".

### What works (and the tests that prove it)

- **Each division's tab** in the Divisions view (Company, Finance, Online, Salon; `#divisions/finance`): "George, Finance, reports to Alan"; the weekly report
  (summary, George's goal and three paths with arithmetic, test, stop-loss and risks, or the others' actions; what was asked of other divisions; each worker's
  section; where each path or action stands); every worker's latest report (findings with metric ids, rules, key numbers by unit, row totals, source) and its
  last seven days; the daily brief and the questions. `reports-shape.test.ts` (41 tests: manager line, workers in registry order, key numbers by unit, the
  seven New York days, old / missing / unreadable / unread workers, a report of another worker, the weekly report, goal and paths, actions, where each stands,
  scrubbing and limits, a head's own view), `reports-page.test.ts` (30 tests: the page's own script against a fake browser, every empty and unread state,
  tabs, links, text never becoming markup, the email channel named).
- **A head's own page**, `/?division=<finance|online|salon>`: no tabs, one division, no CEO digest; the page asks `/api/divisions?division=` and the **server**
  reads and sends that division only (its own questions, none of the other divisions' notes). The footer says that in production the heads' sites go into the
  Fortune Hub. Any other value, or two, is 404 and nothing is read. Same script and style, same Content-Security-Policy as the owner's page.
  `reports-server.test.ts` (18 tests), `reports-loader.test.ts` ("the loader for a head's own view"), `reports-page.test.ts` ("a head's own page").
- **The PDF link**: `/report/weekly/<id>.pdf` and `/report/worker/<id>.pdf` render the stored report on request with the delivery package's renderer (the same
  bytes as the emailed and printed packet), loopback only, GET and HEAD only, not cached; a head's own link (`?division=`) refuses another division's report as
  "not found"; a report in the wrong shape is a plain 502. `reports-server.test.ts` ("the PDF a report link opens", with a test that the bytes equal the
  renderer's and that no phone, address or code is drawn), `reports-loader.test.ts` ("the report loader").
- **The reads**: `worker_reports` (a division's last seven days, newest first, at most 100, then the newest of each worker with none) and `weekly_reports` (newest
  first, one), with named columns; the approval code and the decisions against the weekly report's own note only. A failed read is named by part and code
  and shown as unread, never empty. `reports-loader.test.ts` (20 tests, recording fake), **`reports-db.test.ts` (4 tests, the real local database through the
  real query builder, under the lock)**.
- **Full suite under the lock, 12:09 ET (after the last change): 65 files passed, 9 skipped (they need Meterless), 1,214 tests passed, 173 skipped; typecheck clean.**
- **Mutation checks** (22 guards broken one at a time in the real source, each seen to fail a test, then restored (`git status` was clean after)): see delivery.md. One survived at
  first (a code counted for a report that was never sent); a test was added and it is caught.
- **Looked at in a real browser** (the built-in pane, synthetic data): the Finance tab at desktop width and at 375 px (no horizontal overflow), the head's page
  (no tabs, links carry `?division=`, footer), pressing a tab, and both PDF links answering 200 `application/pdf`. That look found a real bug the fake browser could
  not: the new tab buttons shared the class `sub` with the page subtitle and took its style. Fixed and covered (`buttonClasses`).

### Not done

- Nothing real was sent or printed (see slice 1); a head's own page has no sign-in of its own (it is loopback, filtered to one division; the Hub's sign-in will
  decide who sees which division).
- The weekly report's delivery state (email sent, printout made) is not on the division tab; the outbox rows show on each department's "Texts and printouts"
  list, where the `email` channel is now named.
- Two weekly reports for the same week (one asked for by text) show the newest only.
- The built-in pane's screenshots were flaky (blank or tiled), so layout was judged from the DOM and a few readable shots, not pixel by pixel.

### What the merge must know

- **Files outside this lane's own, all small:**
  - `package-lock.json`: one line (`@fahq/delivery` among `apps/console`'s dependencies; `apps/console/package.json` has it too). The workspace link already existed.
  - `docs/divisions.md`: a two-line pointer in "The console's Divisions view" and the tests line.
  - `packages/delivery/src/index.ts` and `report-pdf.ts`: `keyMetrics`, `rowKey`, `rowValue`, `sourceText` and `money` are now exported so the console writes a number the way the PDF does.
  - Existing console tests edited (expectations only): `divisions.test.ts` (the block's key list, and the two lists of tables the loader touches, now including `worker_reports`
    and `weekly_reports`), `divisions-db.test.ts` (the loader is given a clock on the test's own day, so it never reads other tests' report rows).
- **What W1 must write for the console to show where a path or action stands** (the same way a brief's is read): `weekly_reports.message_id` = the note the head approves
  against; one `approvals` row with `action = 'approve_action'` on that note; and, per choice approved, an `assistant_messages` row `kind = 'decision'`,
  `dedupe_key = 'action-decision:<note id>:<rank>'`, `reply_to = <note id>`, body `{ verdict: 'approved', rank }` (rank 1 to 3; for George's report, the path's rank).
  If W1 records approvals another way, `readReports` in `apps/console/src/loader.ts` is the one place to change. Without a `message_id` the console says "this report has not
  been sent to the head yet".
- **Rows the console shows must be rows the contracts accept**: `worker_reports.report` parses as `WorkerReport` with `workerId` = the row's `worker_id`, and
  `weekly_reports.report` as `WeeklyReport` with `division` = the row's `division`; otherwise the part is shown as unreadable with a note (it is never guessed at).
  `weekly.workerReportIds` must be `worker_reports.id` values: the PDF packet is built from them.
- `ConsoleDeps.loadDivisions` now takes an optional division; `ConsoleDeps.loadReport` is new and optional (without it the PDF links answer 404). `main()` wires both.
- No migration, no change to contracts, no new env setting beyond a commented `CONSOLE_PORT` in `.env.example`.
- The preview server used for the browser check lives in `.local/` (ignored) and is stopped.
