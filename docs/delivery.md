# Delivery: report PDFs, email and printouts (wave 2)

Spec of record: [wave2.md](wave2.md), "Reports". Code: `packages/delivery` (the PDFs, the email, Postmark),
`apps/worker/src/outbox.ts` (what an outbox row does), `apps/worker/src/store.ts` ("delivery reads (W2)"),
`apps/console` (the console views and the PDF link). The reports themselves are the contracts in
`packages/contracts/src/reports.ts`.

A report reaches its head four ways: the head's own view and the owner's console (this document, "The console"), the head's
printer, and an email to the owner's address only. All four are built from the stored report, so they say the same thing.

## What is delivered

| Row | `attachment_ref` | What goes out |
|---|---|---|
| `email` | `weekly_report:<id>` | the weekly packet PDF, with a short email, to `HQ_REPORT_TO` only |
| `email` | `worker_report:<id>` | one worker's daily report PDF, same way |
| `print` | `weekly_report:<id>` or `worker_report:<id>` | the same PDF, on the head's printer |
| `print` | `proposal:<id>` | the three-plans proposal (unchanged from wave 1) |
| `sms` | none | the text (unchanged) |

The outbox rows are written by the worker lane (W1), with the report's id in `attachment_ref`. Delivery reads the **stored**
report, checks it with its schema, and builds everything from it. It never uses the row's `body`, which may carry a one-time
code (the text to the head does, and the code is blanked in the row once the item is handled).

## The PDFs (`packages/delivery/src/report-pdf.ts`)

**The packet** (`renderWeeklyPacketPdf(weekly, workerReports, ctx)`): the manager's report first, then one page per worker.

1. *Cover page(s)*: division and manager, "George's report to Alan", the week, the status (on track, worth a look, needs
   action: set by the program from the rules, never by a model), a note when a program wrote the report from the rules,
   the summary.
   - **Finance:** the goal of the week in a panel (metric, from, to, by when, why), then the three paths: summary, what to do, the
     numbers behind it (each metric with its label and value), the projection arithmetic with its assumption, the test, the
     stop-loss and the risks, then "Reply APPROVE 1, 2 or 3 with the one-time code sent to your phone".
   - **Online and salon:** the actions (title, why, how, the numbers each rests on) and the same approve line.
   - *Asked of other divisions*: the question and the answer, or "No answer" and why.
   - *What each worker found*: one entry per worker with its status and the numbers it rests on.
2. *One page per worker report*: label, day, status, headline, findings (each with a "Based on" line that names the metrics it cites
   and their values), the rules that fired, a **Key numbers** table (label, value by unit, metric id), the row totals the port
   added up, and the data source with its date. The table keeps the numbers the words and rules lean on first, up to twelve, and
   says how many more are in the data.

If fewer worker reports load than the weekly report names, the cover says "N of M worker reports could not be loaded": a gap is
never hidden. A worker page runs onto a second page only if it overflows; each worker starts on a new page.

**Numbers** (`format.ts`, one place for the PDF and the email):

| Unit | Written as |
|---|---|
| `usd` | `$12,400`, `$2.40`, `-$950` (whole dollars from a thousand up) |
| `count` | `61,200` |
| `percent` | `4.3%` |
| `ratio` | a percent: `0.52` is `52%`, `0.003` is `0.3%`. **Exception:** an ad return or an index (id ending `.roas`, `.mer`, `.month_index`, `.last_year_index`) is a multiple of what was spent or of a typical month: `3.1x`. "310%" would mislead a head. |
| `minutes` | `85 min` |
| `days` | `11.5 days` |
| `seconds` | `2.8 s` |
| `score` | `4.6` |

**Brand** (the Fortune Wigs brand kit, section 5 and 6, and nothing else): ink `#212424` for text, muted `#5B5F60`, teal `#5699A9` for the
top bar only (accents, never text), panels `#CCE0E5` and `#D6E1E2` with ink text, canvas `#F0F1F3` for stripes and bands, hairlines
`#DADADA`. The status is a pill built from the palette alone: ink with white text for "needs action", a light panel with a teal
border for "worth a look", a pale panel for "on track" (the kit bans red, amber and green, so none is used).
**Fonts:** the kit's typefaces are Playfair Display (headlines) and Lato (body). A PDF made with only the standard fonts cannot embed
them without shipping the font files, so **Times (bold) stands in for Playfair Display and Helvetica for Lato.** The email names the
real faces first (`'Playfair Display', Georgia` and `Lato, Helvetica, Arial`), so a mail app that has them shows them. No logo, slogan or
brand claim is drawn: the pages say "Fortune AI Headquarters, synthetic data" in the footer, with the page number.

**What a PDF never carries.** Every string passes `scrub` (`src/scrub.ts`) on its way to the page: an email address becomes `[email]`,
a phone number `[phone]` and a one-time code `[code]` (the same two shapes the database and the read tools use,
`packages/contracts/src/redact.ts`, so an amount like `$12,800` is not taken for a code). Standard fonts only speak WinAnsi, so text is
mapped to it first and rendering never throws on an emoji or a curly quote. A word wider than the line is cut into pieces that fit.
The file carries no clock: its dates are the report's own, so the same report always makes the same bytes.

Samples from synthetic fixtures: [`docs/samples/finance-weekly-packet.pdf`](samples/finance-weekly-packet.pdf) (10 pages) and
[`docs/samples/online-weekly-packet.pdf`](samples/online-weekly-packet.pdf) (7 pages). Rewrite them with
`npx tsx packages/delivery/scripts/samples.ts` (fixtures: `packages/delivery/test/report-fixtures.ts`).

## Email through Postmark (`DeliveryPort.sendEmail`)

`POSTMARK_HQ_SERVER_TOKEN` and `POSTMARK_HQ_FROM` come from the environment and nowhere else. In the order it checks:

1. **The recipient.** It must be one plain address (no list, no name part, no spaces: an `HQ_REPORT_TO` of `a@x.com, b@x.com` is refused, not
   sent to two people) and must be in `allowedRecipients`, compared without regard to case. Otherwise `DeliveryError`, before any network
   call and even when there is no token.
2. **Once.** An outbox id already sent by this process is refused. The database claim (`pending` to `sending`) is the durable guard.
3. **Configured?** No token, or a sender that is not an address: **skipped** (`{ status: 'skipped', reason }`), never an error, so the item is
   settled as skipped and nothing loops.
4. **Size.** Attachments over 7 MB (Postmark's 10 MB after base64) are refused.
5. The request: `POST https://api.postmarkapp.com/email`, JSON, the token in `X-Postmark-Server-Token`, `redirect: 'error'`, a 20 second timeout,
   no open or link tracking, the PDF as a base64 attachment named from a safe character set, the subject on one line.
6. **Errors say what happened and nothing the provider said:** `Postmark refused the message (HTTP 422)`, `Postmark did not accept the message`
   (a 200 that carries an error code), `Postmark could not be reached; the message may not have been sent`. A 429 or 5xx is tried again, at most
   three times, by the outbox; anything else is failed.

`apps/worker/src/outbox.ts` passes `allowedRecipients = { HQ_REPORT_TO }` and `to = HQ_REPORT_TO`. **Whoever the head is, the email goes to that
one address**; the subject says who it is for: `For Alan: George's weekly report`, `For Emma: Georgette's weekly report`,
`For Esther: Cindy's weekly report`, and the body says so too. Replying to the email does nothing: a path or an action is chosen by text, with
the one-time code on the head's phone. The email carries the summary, the goal and the path or action titles with their one-line summaries,
and the PDF; it never carries a code, and every word of it is escaped for HTML.

## Printouts

The packet is printed on `deps.printers[<the head's assistant>]` (`PRINTNODE_PRINTER_FINANCE`, `_ONLINE`, `_SALON`, and `_OWNER`). With no printer set, the item
is skipped with "no printer is assigned to this person" and no request is made; with no PrintNode key, "printing is not configured". The PDF is
also written to `.local/print/<outbox id>.pdf` (as the proposal printout already was), so a dry run can be opened.

## The console

`npm run console` serves the owner's read-only Admin console on `http://127.0.0.1:5180` (`CONSOLE_PORT` changes the port). It is
the same console as before: GET and HEAD only, it listens on 127.0.0.1 only and refuses any other Host name, nothing is cached, the
service key stays on the server, every text passes `cleanText` (phone numbers masked to their last four digits, any run of six or more
digits blanked, keys and hashes replaced), every list is cut to a small size, and an unexpected shape becomes a plain note, never a
crash. Wave 2 adds the managers' reports to the **Divisions** view. (`apps/console/README.md` has the rest of the console.)

### A division's tab

The Divisions view opens on **Company**: the CEO digest, and each division's daily brief and questions as before, plus one line for
each division, "George, Finance, reports to Alan", with how its weekly report stands and two buttons ("Open the Finance tab" and
the head's view). A button for each division, **Finance**, **Online** and **Salon**, opens that division's tab
(`#divisions/finance` in the address). Pressing one draws from what the page already has; it does not ask the server again.

A division's tab shows, top to bottom:

1. **The manager and head**: "George, Finance, reports to Alan" (Georgette to Emma, Cindy to Esther), from `MANAGERS` in the contracts.
2. **The weekly report** (the latest by week, then by when it was written):
   - the week, its status (running normally, needs a look, needs a decision: set by the program from the rules), "written by rules" when
     a program wrote it because the model's words failed their number check, and the summary;
   - **Finance:** the goal of the week (the metric by its label, from, to, by when, why, written by the unit of the metric) and **three
     paths**, each with what to do, the numbers behind it (label, value, metric id), the arithmetic ("Meta spend after cutting a quarter:
     $4,100 x 0.75 = $3,075" and its assumption), the test, the stop-loss and the risks;
   - **Online and salon:** up to three **actions** with their reasons, steps and the numbers each rests on;
   - **Where it stands**: a code waiting (and when it ends), the path or action the head approved ("path 2 approved."), a code that ended or
     was locked, "no code has been sent", or that the report was never sent to the head so there is nothing to approve against;
   - **Asked of other divisions**: each question, and the answer or "No answer" with its reason;
   - **What each worker found**: one entry per worker with its status, its words and the numbers it cites;
   - the line to the CEO division and the data source with its date;
   - a link, **Open the PDF packet**.
3. **Daily workers**: every worker of the division, in the registry's order, as a row that opens. A worker that found something
   (needs a look or a decision) is open; one that found nothing is one line. Each shows its report's day, its findings with the metric ids
   they cite, the rules that fired, the **key numbers** (the same ones the PDF shows, written by unit: `$9,200`, `3.1x`, `80%`, `85 min`),
   the row totals the port added up, its data source, a link to **its own PDF**, and **Last seven days**: one line for each of the last
   seven company days (New York days) with a report, newest first, with its status and headline. A worker with no report in the week still
   shows its newest report, marked "older than seven days". A worker that has not reported says so.
4. **The daily brief and the questions** the division asked and was asked, as before.

How a part that cannot be shown is told: no report is "No report yet", a row in a shape the contract does not allow is "could not be read
in full" with a note, and a read that failed is "could not be read right now" with the part and the database's error code (never its words).
Nothing unread is ever drawn as empty.

### A head's own page

`/?division=finance` (or `online`, `salon`) is what a head sees: the same page, with no tabs, for that one division. It asks the server for
`/api/divisions?division=finance`, and the **server** reads and sends that division only: no other division's brief, reports or
notes, no CEO digest (that is the owner's), and only the questions that division asked or was asked. Any other value, or the name twice,
is "not found" and nothing is read. Its footer says: *This is the head's view of the Finance division only. In production, each head's
site is part of the Fortune Hub.* The page is the same script and style as the owner's page, under the same Content-Security-Policy
(one script and one style, allowed by hash), so it can show nothing the owner's page could not. It is as private as the console is: it
answers on 127.0.0.1 only. The real heads reach their reports by text, email and paper until the Hub carries these pages.

### The PDF link

`/report/weekly/<id>.pdf` and `/report/worker/<id>.pdf` render the **stored** report into the same PDF the head gets by email and on paper
(`renderWeeklyPacketPdf` and `renderWorkerReportPdf`, the same bytes), on request. Nothing is kept. The id must be a well-formed id and the
path exactly that: anything else is "not found". The console reads the report by id with named columns, checks it against its contract
(a weekly packet takes the worker reports it was built from, of the same division, in the registry's order; one that is not in its shape
is left out, so the cover says "N of M worker reports could not be loaded"), and sends it with `Content-Type: application/pdf`,
`inline`, `no-store`, and a name made only of checked values (`finance-weekly-2026-10-26.pdf`). On a head's own page every link
carries `?division=<d>`, and the server answers "not found" for a report of any other division. A report in the wrong shape is a plain
502 that shows nothing of it; the log gets only `console.load_failed department=report reason=...`.

### What the console reads

Only named columns, server side, with the service key:

| Table | Columns | Filter |
|---|---|---|
| `worker_reports` | `id,worker_id,division,report_date,status,written_by,report,created_at` | a division, the last seven company days, newest first, at most 100; then the newest one of each worker that has none |
| `weekly_reports` | `id,division,week_of,status,written_by,report,ceo_line,message_id,created_at` | a division, newest week first, one |
| `approvals` | `status,expires_at,decided_at` | `action = approve_action` on the weekly report's own note (`message_id`), newest first, one |
| `assistant_messages` | `created_at,body` | `kind = decision`, `dedupe_key like action-decision:%`, `reply_to` the weekly report's note |

The report's own `task_id` and `data_source` columns, who approved, and the code hash are never read. A decision is read as its rank and
verdict only. **The head approves a weekly report's path or action the way a brief's action is approved**: one `approve_action` code on the
note the report was sent with, and one `action-decision:<note id>:<rank>` note for each choice (verdict `approved`). If the worker lane's
weekly flow records approvals another way, this is the one place to change (`readReports` in `apps/console/src/loader.ts`).

### What a head's own view is not

It does not send, approve or change anything; approval is by text with the one-time code. It does not hold another division's numbers,
and it does not hold the CEO digest. It is not behind a sign-in: it is as private as the loopback address it answers on. When the heads'
sites move into the Fortune Hub, the Hub's own sign-in decides who sees which division, and this page's server-side filter is the
shape of what it should be allowed to read.

## Settings

| Name | Meaning |
|---|---|
| `POSTMARK_HQ_SERVER_TOKEN`, `POSTMARK_HQ_FROM` | Postmark server token and the sender address (a verified sender in Postmark) |
| `HQ_REPORT_TO` | the one address every report email goes to; empty means report emails are skipped |
| `PRINTNODE_API_KEY` | PrintNode key; empty means printouts are skipped with a reason |
| `PRINTNODE_PRINTER_OWNER`, `_FINANCE`, `_ONLINE`, `_SALON` | one printer id per head |
| `CONSOLE_PORT` | the console's port on 127.0.0.1 (default 5180) |

## Tests

- `packages/delivery/test/report-pdf.test.ts`: numbers by unit; the packet for each division; the goal and three paths; the actions and "asked"; a worker
  report missing; no phone, address or code in a PDF; unusual characters; the key-number cap; same bytes twice; long words.
- `packages/delivery/test/email.test.ts`: the Postmark request; another address refused before the network; a list or a name part refused; sent once;
  the attachment; skipped without a token or a sender; no provider body in an error; the subject and attachment name on one safe line; the email text
  and HTML (escaped, labeled for the head, no code).
- `apps/worker/test/outbox-reports.test.ts` (real delivery port, fake fetch): the packet emailed to `HQ_REPORT_TO` only with the PDF attached; built from
  the stored report, not the row text; sent once; skipped with no token, no address, no report; failed plainly when the report is gone; the provider's body
  kept out of the row; retried on 5xx at most three times; printed on the head's printer; skipped with no printer; one worker report; the proposal printout as before.
- `apps/worker/test/store-reports.test.ts` (real local database): the reads.
- `apps/console/test/reports-shape.test.ts`: the manager line, every worker of a division in order, a report's findings, rules and key numbers by
  unit, the last seven days (one a day, New York days, none older), a worker with an old report or none, a report in the wrong shape or of another
  worker, unread parts, the weekly report (goal, three paths with arithmetic, actions, asked, sections), where each path or action stands, scrubbing
  and limits, and a head's own view (one division, no digest, its own questions and notes).
- `apps/console/test/reports-loader.test.ts` (recording fake): named columns, limits and filters, the fallback read for a worker with nothing this week,
  the approval read against the report's own note only, a failed read named by part and code, one division only for a head, and the report loader.
- `apps/console/test/reports-server.test.ts`: `?division=` on the page and the API (404 for anything else), the head page's markup and policy, the
  PDF (the same bytes as the delivery renderer, no phone, address or code, HEAD, another division's report "not found", 404 and 502 cases), read-only
  and loopback only.
- `apps/console/test/reports-page.test.ts` (the page's own script against a fake browser): the tabs, the weekly report, the paths and where they stand,
  the workers, every empty or unread state, a head's page (its fetch, its links), and text never becoming markup.
- `apps/console/test/reports-db.test.ts` (real local database, under the lock): the reads and the filters accepted by the real query builder.
- Mutation checks (22 guards broken one at a time, each seen to fail a test, then restored): a worker report of another worker, the seven-day window,
  the digest and notes and division of a head's view, a code on a report never sent, the decisions and the questions and the workers read for the
  wrong note or division, the digest read for a head, the division check on a PDF, a division name or an id accepted too loosely, the provider's words
  in an answer, a cached PDF, a tab on a head's page, a head's link without its division, a head's page asking for every division, a tab asking the
  server again, report text as markup, and a tab button taking the subtitle's class.

## Not done

- No real Postmark call, PrintNode job or Twilio text was made (no token, key or sender exists yet); their requests are checked against the providers'
  documented shapes with a fake `fetch` only.
- The PDFs use the standard fonts (Times for Playfair Display, Helvetica for Lato) and no logo.
- A head's own page has no sign-in of its own: it is the loopback console filtered to one division. The Hub's sign-in is what will decide who may see it.
- The weekly report's delivery state (was the email sent, the printout made) is not shown on the console; the outbox rows show it on each department's
  "Texts and printouts" list, and the `email` channel is named there.
- Two weekly reports for one week (one asked for by text) show the newest only.
