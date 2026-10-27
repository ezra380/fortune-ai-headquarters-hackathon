import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProfitPlans, weeklyReportRef, workerReportRef, type DeliveryPort, type WeeklyReport, type WorkerReport } from '@fahq/contracts';
import { createDeliveryPort } from '@fahq/delivery';
import { pdfPages } from '../../../packages/delivery/test/pdf-text.ts';
import { weeklyReport, workerReport, workerReportsOf } from '../../../packages/delivery/test/report-fixtures.ts';
import type { WorkerDeps } from '../src/flows.ts';
import { flushOutbox } from '../src/outbox.ts';
import type { OutboxRow } from '../src/store.ts';
import { mockMetrics, validPlans } from './fixtures.ts';

// FAKES: an in-memory outbox and store, and the REAL delivery port over a fake fetch, so what leaves the
// program (the Postmark and PrintNode requests) is what is checked. Synthetic reports from the delivery fixtures.

const OWNER = 'owner@example.com';
const WEEKLY_ID = '11111111-1111-4111-8111-111111111111';
const WORKER_ID = '22222222-2222-4222-8222-222222222222';
const MISSING_ID = '99999999-9999-4999-8999-999999999999';
const env = { POSTMARK_HQ_SERVER_TOKEN: 'pm-test-only-token', POSTMARK_HQ_FROM: 'reports@example.com', PRINTNODE_API_KEY: 'printnode-test-only' } as NodeJS.ProcessEnv;

type Call = { url: string; body: Record<string, unknown> };
type Row = OutboxRow & { claimed_at: string | null; last_error: string; provider_ref: string };

function setup(rows: Partial<Row>[], o: { env?: NodeJS.ProcessEnv; reportTo?: string | null; printers?: WorkerDeps['printers']; postmark?: [number, unknown]; weekly?: WeeklyReport | null; workers?: WorkerReport[] } = {}) {
  const table: Row[] = rows.map((r, i) => ({
    id: `row-${i}`, channel: 'email', to_person_id: 'demo-p-finance', from_assistant: 'finance', body: 'Reply APPROVE 1 123456',
    attachment_ref: weeklyReportRef(WEEKLY_ID), status: 'pending', attempts: 0, claimed_at: null, last_error: '', provider_ref: '', ...r,
  }));
  const calls: Call[] = [];
  const weekly = o.weekly === undefined ? weeklyReport('finance') : o.weekly;
  const store = {
    strandedOutbox: async () => [] as Row[],
    pendingOutbox: async () => table.filter((r) => r.status === 'pending'),
    registeredPhones: async () => new Set<string>(),
    claimOutbox: async (id: string) => {
      const r = table.find((x) => x.id === id && x.status === 'pending');
      if (!r) return false;
      r.status = 'sending';
      return true;
    },
    person: async () => ({ id: 'demo-p-finance', name: 'Demo Finance Head', role: 'department', phone: '+15550111002', assistant_id: 'finance' }),
    assistantNumber: async () => null,
    settleOutbox: async (row: OutboxRow, s: { status: string; error?: string; providerRef?: string }) => {
      Object.assign(table.find((x) => x.id === row.id)!, { status: s.status, last_error: s.error ?? '', provider_ref: s.providerRef ?? '' });
    },
    retryOutbox: async (row: OutboxRow, error: string) => {
      Object.assign(table.find((x) => x.id === row.id)!, { status: 'pending', attempts: row.attempts + 1, last_error: error, claimed_at: null });
    },
    weeklyReportById: async (id: string) => (id === WEEKLY_ID && weekly ? { id, report: weekly } : null),
    workerReportById: async (id: string) => (id === WORKER_ID ? workerReport('finance.meta') : null),
    workerReportsByIds: async () => o.workers ?? workerReportsOf('finance'),
    message: async (id: string) => ({ id, from_assistant: 'finance', to_assistant: 'owner', kind: 'proposal', body: { plans: ProfitPlans.parse(validPlans), metrics: mockMetrics }, status: 'open', reply_to: null, created_at: '2026-10-26T12:00:00Z' }),
    personByAssistant: async () => ({ id: 'demo-p-owner', name: 'Demo Owner', role: 'owner', phone: '+15550111001', assistant_id: 'owner' }),
  };
  const [postmarkStatus, postmarkBody] = o.postmark ?? [200, { To: OWNER, MessageID: 'pm-message-1', ErrorCode: 0, Message: 'OK' }];
  const fetchFake = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return url.includes('postmarkapp') ? new Response(JSON.stringify(postmarkBody), { status: postmarkStatus }) : new Response('991', { status: 201 });
  }) as unknown as typeof fetch;
  const port = createDeliveryPort(o.env ?? env, { fetch: fetchFake, now: () => new Date('2026-10-26T12:00:00Z'), sentLedger: new Set<string>() });
  const emails: Parameters<DeliveryPort['sendEmail']>[0][] = [];
  const delivery = { ...port, sendEmail: (input: Parameters<DeliveryPort['sendEmail']>[0]) => { emails.push(input); return port.sendEmail(input); } } as DeliveryPort;
  const printDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fahq-outbox-'));
  const deps = {
    store, delivery, smsLive: false, printers: o.printers ?? {}, printDir, now: () => new Date('2026-10-26T12:00:00Z'),
    reportTo: o.reportTo === undefined ? OWNER : o.reportTo ?? undefined,
  } as unknown as WorkerDeps;
  return { table, calls, emails, deps, printDir };
}

const postmarkCalls = (calls: Call[]) => calls.filter((c) => c.url.includes('postmarkapp'));

describe('report emails', () => {
  it("sends the weekly packet to the owner's address only, labeled for the head, with the PDF attached", async () => {
    const { table, calls, emails, deps } = setup([{}]);
    await flushOutbox(deps);
    expect(table[0]).toMatchObject({ status: 'sent', provider_ref: 'pm-message-1' });
    expect(postmarkCalls(calls)).toHaveLength(1);
    const sent = postmarkCalls(calls)[0]!.body as { To: string; Subject: string; Attachments: { Name: string; Content: string; ContentType: string }[] };
    expect(sent.To).toBe(OWNER);
    expect(sent.Subject).toBe("For Alan: George's weekly report");
    expect(emails[0]?.allowedRecipients).toEqual(new Set([OWNER]));
    expect(sent.Attachments).toHaveLength(1);
    expect(sent.Attachments[0]).toMatchObject({ Name: 'Finance-weekly-report-2026-10-26.pdf', ContentType: 'application/pdf' });
    // the attachment is the real packet: the manager's pages, then one page per worker
    const pdf = new Uint8Array(Buffer.from(sent.Attachments[0]!.Content, 'base64'));
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-');
    const pages = await pdfPages(pdf);
    expect(pages[0]).toContain('Finance weekly report');
    expect(pages.filter((p) => p.includes('Daily report for'))).toHaveLength(7);
  });

  it('builds the email from the stored report, never from the outbox text (which may carry a one-time code)', async () => {
    const { calls, deps } = setup([{ body: 'Reply APPROVE 1 482913' }]);
    await flushOutbox(deps);
    const sent = postmarkCalls(calls)[0]!.body as { TextBody: string; HtmlBody: string };
    for (const text of [sent.TextBody, sent.HtmlBody]) expect(text).not.toContain('482913');
    expect(sent.TextBody).toContain("George's");
  });

  it('sends an item once, however often the outbox is flushed', async () => {
    const { table, calls, deps } = setup([{}]);
    await flushOutbox(deps);
    await flushOutbox(deps);
    await flushOutbox(deps);
    expect(postmarkCalls(calls)).toHaveLength(1);
    expect(table[0]?.status).toBe('sent');
  });

  it('sends a worker report the same way', async () => {
    const { table, calls, deps } = setup([{ attachment_ref: workerReportRef(WORKER_ID) }]);
    await flushOutbox(deps);
    expect(table[0]?.status).toBe('sent');
    const sent = postmarkCalls(calls)[0]!.body as { Subject: string; Attachments: { Name: string; Content: string }[] };
    expect(sent.Subject).toBe('For Alan: Meta ads daily report');
    expect(await pdfPages(new Uint8Array(Buffer.from(sent.Attachments[0]!.Content, 'base64')))).toHaveLength(1);
  });

  it('is skipped, not failed, and not retried, when there is no Postmark token', async () => {
    const { table, calls, deps } = setup([{}], { env: { POSTMARK_HQ_FROM: 'reports@example.com' } as NodeJS.ProcessEnv });
    await flushOutbox(deps);
    await flushOutbox(deps);
    expect(table[0]).toMatchObject({ status: 'skipped', attempts: 0 });
    expect(table[0]?.last_error).toContain('no Postmark server token');
    expect(calls).toHaveLength(0);
  });

  it('is skipped when no report address is set, and nothing is sent anywhere else', async () => {
    const { table, calls, deps } = setup([{}], { reportTo: null });
    await flushOutbox(deps);
    expect(table[0]).toMatchObject({ status: 'skipped' });
    expect(table[0]?.last_error).toContain('HQ_REPORT_TO');
    expect(calls).toHaveLength(0);
  });

  it('is skipped when the row names no report', async () => {
    const { table, calls, deps } = setup([{ attachment_ref: null }]);
    await flushOutbox(deps);
    expect(table[0]).toMatchObject({ status: 'skipped' });
    expect(table[0]?.last_error).toContain('no report');
    expect(calls).toHaveLength(0);
  });

  it('fails plainly when the report is gone, and when the reference is not a report id', async () => {
    const { table, calls, deps } = setup([{ attachment_ref: weeklyReportRef(MISSING_ID) }, { attachment_ref: 'weekly_report:../../etc/passwd' }]);
    await flushOutbox(deps);
    expect(table[0]).toMatchObject({ status: 'failed', last_error: 'the weekly report was not found' });
    expect(table[1]).toMatchObject({ status: 'skipped' });
    expect(calls).toHaveLength(0);
  });

  it('keeps the provider body out of the row when Postmark refuses, and does not retry a refusal that means the message is wrong', async () => {
    const { table, calls, deps } = setup([{}], { postmark: [422, { ErrorCode: 406, Message: 'Inactive recipient owner@example.com' }] });
    await flushOutbox(deps);
    await flushOutbox(deps);
    expect(postmarkCalls(calls)).toHaveLength(1);
    expect(table[0]).toMatchObject({ status: 'failed', last_error: 'Postmark refused the message (HTTP 422)' });
  });

  it('tries again, at most three times, when Postmark is down', async () => {
    const { table, calls, deps } = setup([{}], { postmark: [503, 'down'] });
    for (let i = 0; i < 4; i++) await flushOutbox(deps);
    expect(postmarkCalls(calls)).toHaveLength(3);
    expect(table[0]).toMatchObject({ status: 'failed', last_error: 'Postmark refused the message (HTTP 503)' });
  });
});

describe('report printouts', () => {
  const print = { channel: 'print' as const };
  const printedPdf = (calls: Call[]) => new Uint8Array(Buffer.from(String(calls.find((c) => c.url.includes('printnode'))!.body.content), 'base64'));

  it("prints the weekly packet on the head's printer", async () => {
    const { table, calls, deps, printDir } = setup([print], { printers: { finance: '74001' } });
    await flushOutbox(deps);
    expect(table[0]).toMatchObject({ status: 'sent', provider_ref: '991' });
    const job = calls.find((c) => c.url.includes('printnode'))!.body;
    expect(job).toMatchObject({ printerId: 74001, contentType: 'pdf_base64', title: expect.stringContaining('Finance weekly report') });
    const pages = await pdfPages(printedPdf(calls));
    expect(pages[0]).toContain('Finance weekly report');
    expect(pages.filter((p) => p.includes('Daily report for'))).toHaveLength(7);
    expect(fs.existsSync(path.join(printDir, 'row-0.pdf'))).toBe(true);
  });

  it('is skipped, with a reason and no network call, when the head has no printer', async () => {
    const { table, calls, deps } = setup([print], { printers: { owner: '1' } });
    await flushOutbox(deps);
    expect(table[0]).toMatchObject({ status: 'skipped', last_error: 'no printer is assigned to this person' });
    expect(calls).toHaveLength(0);
  });

  it('prints one worker report', async () => {
    const { table, calls, deps } = setup([{ ...print, attachment_ref: workerReportRef(WORKER_ID) }], { printers: { finance: '74001' } });
    await flushOutbox(deps);
    expect(table[0]?.status).toBe('sent');
    expect(await pdfPages(printedPdf(calls))).toHaveLength(1);
  });
});

describe('proposal printouts (as before)', () => {
  it('still renders the three plans and prints them, and skips without a printer', async () => {
    const proposal = { channel: 'print' as const, attachment_ref: 'proposal:33333333-3333-4333-8333-333333333333' };
    const printed = setup([proposal], { printers: { finance: '74001' } });
    await flushOutbox(printed.deps);
    expect(printed.table[0]).toMatchObject({ status: 'sent', provider_ref: '991' });
    const pdf = new Uint8Array(Buffer.from(String(printed.calls[0]!.body.content), 'base64'));
    expect((await pdfPages(pdf))[0]).toContain('Three profit plans');
    const unprinted = setup([proposal]);
    await flushOutbox(unprinted.deps);
    expect(unprinted.table[0]).toMatchObject({ status: 'skipped', last_error: 'no printer is assigned to this person' });
  });
});
