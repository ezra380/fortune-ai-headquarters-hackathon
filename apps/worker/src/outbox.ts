import fs from 'node:fs';
import path from 'node:path';
import { MANAGERS, workerDivision, type DeliveryPort, type ProfitPlans, type ProposalDocument, type ReportContext, type ReportEmail } from '@fahq/contracts';
import { citedMetricsOf, type WorkerDeps } from './flows.ts';
import type { OutboxRow, PersonRow } from './store.ts';

// Delivers queued texts, emails and printouts. Each item is claimed (pending → sending) so it goes out once.
// Without a configured sender it is a labeled DRY RUN: printed, recorded as "skipped", never lost.
// Approval codes are blanked in the stored body once an item is handled.
//
// Reports (wave 2): an email or print row whose attachment_ref is weekly_report:<id> or worker_report:<id> is
// built from the STORED report, never from the row's text (which may carry a code). Every report email goes to
// HQ_REPORT_TO and nowhere else, whoever the head is, until real data is connected.

const STRANDED_AFTER_MS = 5 * 60_000;
const MAX_TRIES = 3;
/** Twilio or Postmark said no before accepting the message (rate limit or their own outage): safe to try again. */
const retryable = (message: string) => /\(HTTP (429|5\d\d)\)/.test(message);

/** What one row came to: it went out, or it was left out for a plain reason (never a failure). */
type Handled = { status: 'sent'; providerRef: string } | { status: 'skipped'; error: string };
const skipped = (error: string): Handled => ({ status: 'skipped', error });

const REPORT_REF = /^(weekly_report|worker_report):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
type ReportRef = { kind: 'weekly' | 'worker'; id: string };
function reportRef(ref: string | null): ReportRef | null {
  const match = REPORT_REF.exec(ref ?? '');
  return match ? { kind: match[1] === 'weekly_report' ? 'weekly' : 'worker', id: match[2]! } : null;
}

export async function flushOutbox(deps: WorkerDeps): Promise<number> {
  // Items a crashed sender left in 'sending' are closed, never re-sent: Twilio may have delivered them.
  for (const row of await deps.store.strandedOutbox(new Date(deps.now().getTime() - STRANDED_AFTER_MS))) {
    await deps.store.settleOutbox(row, { status: 'failed', error: 'stranded while sending; delivery unconfirmed', now: deps.now() });
  }
  const rows = await deps.store.pendingOutbox(10);
  let handled = 0;
  const phones = await deps.store.registeredPhones();
  for (const row of rows) {
    if (!(await deps.store.claimOutbox(row.id, deps.now()))) continue;
    handled += 1;
    const now = deps.now();
    let delivered = false;
    try {
      const person = await deps.store.person(row.to_person_id);
      if (row.channel === 'sms') {
        const from = await deps.store.assistantNumber(row.from_assistant);
        if (!deps.delivery || !deps.smsLive || !from) {
          deps.smsSink?.({ to: person.phone, body: row.body });
          console.log(`[DRY RUN sms → ${person.name}]\n${row.body}\n`);
          await deps.store.settleOutbox(row, { status: 'skipped', error: 'dry run: SMS sending is not configured', now });
          continue;
        }
        const sent = await deps.delivery.sendSms({ outboxId: row.id, to: person.phone, from, body: row.body, allowedRecipients: phones });
        delivered = true;
        await deps.store.settleOutbox(row, { status: 'sent', providerRef: sent.providerMessageId, now });
      } else {
        const result = row.channel === 'email' ? await emailReport(row, deps) : await printout(row, person, deps);
        delivered = result.status === 'sent';
        await deps.store.settleOutbox(row, result.status === 'sent' ? { status: 'sent', providerRef: result.providerRef, now } : { status: 'skipped', error: result.error, now });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'delivery failed';
      // Sent but not recorded: leave it in 'sending' for the stranded check, never mark a delivered text failed.
      if (delivered) {
        console.error(`outbox.settle_failed id=${row.id.slice(0, 8)}`);
        continue;
      }
      if (retryable(message) && row.attempts + 1 < MAX_TRIES) await deps.store.retryOutbox(row, message);
      else await deps.store.settleOutbox(row, { status: 'failed', error: message, now });
    }
  }
  return handled;
}

// ---- reports -------------------------------------------------------------------------------

type ReportDocument = { title: string; pdf: Uint8Array; email: ReportEmail };

/** The stored report behind a ref, drawn as a PDF with its email. Throws a plain sentence when the report is gone. */
async function reportDocument(deps: WorkerDeps, delivery: DeliveryPort, ref: ReportRef): Promise<ReportDocument> {
  if (ref.kind === 'weekly') {
    const row = await deps.store.weeklyReportById(ref.id);
    if (!row) throw new Error('the weekly report was not found');
    const weekly = row.report;
    const ctx: ReportContext = { manager: weekly.manager, head: weekly.head, divisionTitle: MANAGERS[weekly.division].title };
    const workers = await deps.store.workerReportsByIds(weekly.workerReportIds);
    return { title: `${ctx.divisionTitle} weekly report ${weekly.weekOf}`, pdf: await delivery.renderWeeklyPacketPdf(weekly, workers, ctx), email: delivery.weeklyReportEmail(weekly, ctx) };
  }
  const report = await deps.store.workerReportById(ref.id);
  if (!report) throw new Error('the worker report was not found');
  const { manager, head, title } = MANAGERS[workerDivision(report.workerId)];
  const ctx: ReportContext = { manager, head, divisionTitle: title };
  return { title: `${title} daily report ${report.day}`, pdf: await delivery.renderWorkerReportPdf(report, ctx), email: delivery.workerReportEmail(report, ctx) };
}

/** The report email goes to HQ_REPORT_TO only: the allowed set is exactly that one address. */
async function emailReport(row: OutboxRow, deps: WorkerDeps): Promise<Handled> {
  const ref = reportRef(row.attachment_ref);
  if (!ref) return skipped('this email has no report to send');
  if (!deps.delivery) return skipped('email is not connected (packages/delivery)');
  const to = deps.reportTo?.trim();
  if (!to) return skipped('no report address is set (HQ_REPORT_TO)');
  const { pdf, email } = await reportDocument(deps, deps.delivery, ref);
  const sent = await deps.delivery.sendEmail({
    outboxId: row.id, to, subject: email.subject, html: email.html, text: email.text,
    attachments: [{ name: email.attachmentName, pdf }], allowedRecipients: new Set([to]),
  });
  return sent.status === 'sent' ? { status: 'sent', providerRef: sent.providerMessageId } : skipped(sent.reason);
}

async function printout(row: OutboxRow, person: PersonRow, deps: WorkerDeps): Promise<Handled> {
  const report = reportRef(row.attachment_ref);
  const proposalId = row.attachment_ref?.startsWith('proposal:') ? row.attachment_ref.slice('proposal:'.length) : '';
  if (!deps.delivery || !(report || proposalId)) return skipped('printing is not connected (packages/delivery)');
  const { title, pdf } = report ? await reportDocument(deps, deps.delivery, report) : await proposalDocument(deps, deps.delivery, proposalId);
  fs.mkdirSync(deps.printDir, { recursive: true });
  fs.writeFileSync(path.join(deps.printDir, `${row.id}.pdf`), pdf);
  const printed = await deps.delivery.print({ outboxId: row.id, printerId: deps.printers[person.assistant_id], pdf, title });
  return printed.status === 'printed' ? { status: 'sent', providerRef: printed.jobId } : skipped(printed.reason);
}

async function proposalDocument(deps: WorkerDeps, delivery: DeliveryPort, proposalId: string): Promise<{ title: string; pdf: Uint8Array }> {
  const proposal = await deps.store.message(proposalId);
  const requester = await deps.store.personByAssistant(proposal.to_assistant);
  const doc: ProposalDocument = {
    proposalId,
    title: 'Three profit plans',
    requestedBy: requester.name,
    preparedBy: proposal.from_assistant === 'owner' ? 'Owner HQ' : 'Finance assistant',
    createdAt: proposal.created_at,
    plans: proposal.body.plans as ProfitPlans,
    citedMetrics: citedMetricsOf(proposal),
    approvalHint: 'Approve by text only, with the one-time code sent to your phone.',
  };
  return { title: doc.title, pdf: await delivery.renderProposalPdf(doc) };
}
