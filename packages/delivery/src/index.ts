import type { DeliveryPort, EmailResult, PrintResult } from '@fahq/contracts';
import { renderProposalPdf } from './pdf.ts';
import { buildWeeklyEmail, buildWorkerEmail } from './report-email.ts';
import { renderWeeklyPacketPdf, renderWorkerReportPdf } from './report-pdf.ts';

export { renderProposalPdf, toWinAnsi } from './pdf.ts';
export { keyMetrics, renderWeeklyPacketPdf, renderWorkerReportPdf, rowKey, rowValue, sourceText } from './report-pdf.ts';
export { formatValue, longDate, money, projectionLine, WORKER_LABEL } from './format.ts';
export { buildWeeklyEmail, buildWorkerEmail } from './report-email.ts';
export { checkedWeeklyReport, checkedWorkerReport, packetWorkers, reportContext } from './packet.ts';
export type { WorkerReportRow } from './packet.ts';

// Texts, emails and printouts. Twilio, Postmark and PrintNode are called with server-side credentials only; a
// recipient outside the registered set is refused before any network call; an outbox item is sent
// at most once per process (the database claim is the durable guard); provider error bodies are
// never echoed.

export type DeliveryDeps = {
  fetch: typeof fetch;
  now: () => Date;
  sentLedger: { has(id: string): boolean; add(id: string): unknown };
};

export class DeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeliveryError';
  }
}

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

/** One plain address: no list, no name part, no spaces, so a configured value can never mean a second recipient. */
const ADDRESS = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
/** Postmark takes 10 MB a message, measured after base64 (which adds a third). */
const MAX_ATTACHMENT_BYTES = 7_000_000;
const oneLine = (text: string, max: number) => text.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim().slice(0, max);

export function createDeliveryPort(env: NodeJS.ProcessEnv, deps: DeliveryDeps): DeliveryPort {
  return {
    renderProposalPdf,
    renderWorkerReportPdf,
    renderWeeklyPacketPdf,
    weeklyReportEmail: buildWeeklyEmail,
    workerReportEmail: buildWorkerEmail,

    async sendSms({ outboxId, to, from, body, allowedRecipients }) {
      if (!allowedRecipients.has(to)) throw new DeliveryError('recipient is not a registered person; nothing was sent');
      if (deps.sentLedger.has(outboxId)) throw new DeliveryError('this outbox item was already sent');
      const account = env.TWILIO_ACCOUNT_SID ?? '';
      const keySid = env.TWILIO_API_KEY_SID ?? '';
      const keySecret = env.TWILIO_API_KEY_SECRET ?? '';
      if (!/^AC[0-9a-f]{32}$/.test(account) || !keySid || !keySecret) throw new DeliveryError('Twilio credentials are not configured');
      const clean = body.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, 1600);
      let response: Response;
      try {
        response = await deps.fetch(`https://api.twilio.com/2010-04-01/Accounts/${account}/Messages.json`, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
          headers: { Authorization: basic(keySid, keySecret), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ To: to, From: from, Body: clean }).toString(),
        });
      } catch {
        throw new DeliveryError('Twilio could not be reached; the message may not have been sent');
      }
      if (response.status !== 201 && response.status !== 200) {
        throw new DeliveryError(`Twilio refused the message (HTTP ${response.status})`);
      }
      const sid = ((await response.json().catch(() => ({}))) as { sid?: unknown }).sid;
      deps.sentLedger.add(outboxId);
      return { providerMessageId: typeof sid === 'string' ? sid : 'unknown' };
    },

    async sendEmail({ outboxId, to, subject, html, text, attachments, allowedRecipients }): Promise<EmailResult> {
      const recipient = to.trim();
      const allowed = ADDRESS.test(recipient) && [...allowedRecipients].some((a) => a.trim().toLowerCase() === recipient.toLowerCase());
      if (!allowed) throw new DeliveryError('recipient is not an allowed address; nothing was sent');
      if (deps.sentLedger.has(outboxId)) throw new DeliveryError('this outbox item was already sent');
      const token = env.POSTMARK_HQ_SERVER_TOKEN ?? '';
      const from = (env.POSTMARK_HQ_FROM ?? '').trim();
      if (!token) return { status: 'skipped', reason: 'email is not configured (no Postmark server token)' };
      if (!ADDRESS.test(from)) return { status: 'skipped', reason: 'email is not configured (no sender address)' };
      if (attachments.reduce((sum, a) => sum + a.pdf.length, 0) > MAX_ATTACHMENT_BYTES) throw new DeliveryError('the attachments are too large to email');
      let response: Response;
      try {
        response = await deps.fetch('https://api.postmarkapp.com/email', {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(20_000),
          headers: { 'X-Postmark-Server-Token': token, Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            From: from,
            To: recipient,
            Subject: oneLine(subject, 200),
            HtmlBody: html,
            TextBody: text,
            MessageStream: 'outbound',
            TrackOpens: false,
            TrackLinks: 'None',
            Attachments: attachments.map((a) => ({ Name: oneLine(a.name.replace(/[^A-Za-z0-9._ -]/g, '_'), 100), Content: Buffer.from(a.pdf).toString('base64'), ContentType: 'application/pdf' })),
          }),
        });
      } catch {
        throw new DeliveryError('Postmark could not be reached; the message may not have been sent');
      }
      if (response.status >= 500 && response.status !== 503) {
        // A gateway can fail after Postmark has taken the message, so this is never "safe to send again".
        throw new DeliveryError(`Postmark failed (HTTP ${response.status}); the message may have been sent`);
      }
      if (response.status !== 200) throw new DeliveryError(`Postmark refused the message (HTTP ${response.status})`);
      const answer = (await response.json().catch(() => ({}))) as { MessageID?: unknown; ErrorCode?: unknown };
      if (answer.ErrorCode !== undefined && answer.ErrorCode !== 0) throw new DeliveryError('Postmark did not accept the message');
      deps.sentLedger.add(outboxId);
      return { status: 'sent', providerMessageId: typeof answer.MessageID === 'string' ? answer.MessageID : 'unknown' };
    },

    async print({ printerId, pdf, title }): Promise<PrintResult> {
      const key = env.PRINTNODE_API_KEY ?? '';
      if (!key) return { status: 'skipped', reason: 'printing is not configured (no PrintNode key)' };
      if (!printerId || !/^\d+$/.test(printerId)) return { status: 'skipped', reason: 'no printer is assigned to this person' };
      let response: Response;
      try {
        response = await deps.fetch('https://api.printnode.com/printjobs', {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
          headers: { Authorization: basic(key, ''), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            printerId: Number(printerId),
            title: title.slice(0, 100),
            contentType: 'pdf_base64',
            content: Buffer.from(pdf).toString('base64'),
            source: 'fortune-ai-hq',
          }),
        });
      } catch {
        throw new DeliveryError('PrintNode could not be reached');
      }
      if (response.status !== 201 && response.status !== 200) throw new DeliveryError(`PrintNode refused the job (HTTP ${response.status})`);
      const jobId = await response.json().catch(() => null);
      return { status: 'printed', jobId: String(jobId ?? 'unknown') };
    },
  };
}
