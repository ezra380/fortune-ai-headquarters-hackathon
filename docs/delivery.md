# Delivery: report PDFs, email and printouts (wave 2)

Spec of record: [wave2.md](wave2.md), "Reports". Code: `packages/delivery` (the PDFs, the email, Postmark),
`apps/worker/src/outbox.ts` (what an outbox row does), `apps/worker/src/store.ts` ("delivery reads (W2)").
The reports themselves are the contracts in `packages/contracts/src/reports.ts`.

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

## Settings

| Name | Meaning |
|---|---|
| `POSTMARK_HQ_SERVER_TOKEN`, `POSTMARK_HQ_FROM` | Postmark server token and the sender address (a verified sender in Postmark) |
| `HQ_REPORT_TO` | the one address every report email goes to; empty means report emails are skipped |
| `PRINTNODE_PRINTER_OWNER`, `_FINANCE`, `_ONLINE`, `_SALON` | one printer id per head |

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

## Not done in this slice

The console tabs (each division's workers' reports and weekly report with a PDF link, `?division=<d>`) are slice 2.
