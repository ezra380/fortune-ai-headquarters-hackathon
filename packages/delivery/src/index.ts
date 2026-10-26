import type { DeliveryPort, PrintResult } from '@fahq/contracts';
import { renderProposalPdf } from './pdf.ts';

export { renderProposalPdf, toWinAnsi } from './pdf.ts';

// Texts and printouts. Twilio and PrintNode are called with server-side credentials only; a
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

export function createDeliveryPort(env: NodeJS.ProcessEnv, deps: DeliveryDeps): DeliveryPort {
  return {
    renderProposalPdf,

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
