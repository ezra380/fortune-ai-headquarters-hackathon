import fs from 'node:fs';
import path from 'node:path';
import type { ProfitPlans, ProposalDocument } from '@fahq/contracts';
import { citedMetricsOf, type WorkerDeps } from './flows.ts';

// Delivers queued texts and printouts. Each item is claimed (pending → sending) so it goes out once.
// Without a configured sender it is a labeled DRY RUN: printed, recorded as "skipped", never lost.
// Approval codes are blanked in the stored body once an item is handled.

const STRANDED_AFTER_MS = 5 * 60_000;
const MAX_TRIES = 3;
/** Twilio said no before accepting the message (rate limit or its own outage): safe to try again. */
const retryable = (message: string) => /\(HTTP (429|5\d\d)\)/.test(message);

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
        const proposalId = row.attachment_ref?.startsWith('proposal:') ? row.attachment_ref.slice('proposal:'.length) : '';
        if (!deps.delivery || !proposalId) {
          await deps.store.settleOutbox(row, { status: 'skipped', error: 'printing is not connected (packages/delivery)', now });
          continue;
        }
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
        const pdf = await deps.delivery.renderProposalPdf(doc);
        fs.mkdirSync(deps.printDir, { recursive: true });
        fs.writeFileSync(path.join(deps.printDir, `${row.id}.pdf`), pdf);
        const printed = await deps.delivery.print({ outboxId: row.id, printerId: deps.printers[person.assistant_id], pdf, title: doc.title });
        await deps.store.settleOutbox(row, printed.status === 'printed'
          ? { status: 'sent', providerRef: printed.jobId, now }
          : { status: 'skipped', error: printed.reason, now });
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
