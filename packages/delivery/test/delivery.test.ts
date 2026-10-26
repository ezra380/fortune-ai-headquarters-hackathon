import { describe, expect, it } from 'vitest';
import type { Metric, ProposalDocument } from '@fahq/contracts';
import { createDeliveryPort, toWinAnsi } from '../src/index.ts';

const env = {
  TWILIO_ACCOUNT_SID: 'AC' + '0'.repeat(32),
  TWILIO_API_KEY_SID: 'SK-test-only',
  TWILIO_API_KEY_SECRET: 'test-only-secret',
  PRINTNODE_API_KEY: 'printnode-test-only',
} as NodeJS.ProcessEnv;

type Call = { url: string; init: RequestInit };
function fetchMock(status: number, body: unknown, calls: Call[]) {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}
const port = (status: number, body: unknown, calls: Call[], e = env) =>
  createDeliveryPort(e, { fetch: fetchMock(status, body, calls), now: () => new Date('2026-10-26T12:00:00Z'), sentLedger: new Set<string>() });

const sms = { outboxId: 'o1', to: '+15550111001', from: '+15550100001', body: 'Hello\u0007 there', allowedRecipients: new Set(['+15550111001']) };

describe('sendSms', () => {
  it('posts exactly the documented Twilio request and returns the message sid', async () => {
    const calls: Call[] = [];
    const result = await port(201, { sid: 'SM123' }, calls).sendSms(sms);
    expect(result.providerMessageId).toBe('SM123');
    expect(calls[0]?.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`);
    expect(calls[0]?.init.redirect).toBe('error');
    expect(String(calls[0]?.init.body)).toBe('To=%2B15550111001&From=%2B15550100001&Body=Hello+there');
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });

  it('refuses an unregistered recipient without any network call', async () => {
    const calls: Call[] = [];
    await expect(port(201, {}, calls).sendSms({ ...sms, to: '+15559999999' })).rejects.toThrow(/not a registered person/);
    expect(calls).toHaveLength(0);
  });

  it('never sends the same outbox item twice', async () => {
    const calls: Call[] = [];
    const p = port(201, { sid: 'SM1' }, calls);
    await p.sendSms(sms);
    await expect(p.sendSms(sms)).rejects.toThrow(/already sent/);
    expect(calls).toHaveLength(1);
  });

  it('reports a Twilio refusal without echoing its body', async () => {
    const error = (await port(400, 'account details inside', []).sendSms(sms).then(() => null, (e: unknown) => e)) as Error;
    expect(error.message).toBe('Twilio refused the message (HTTP 400)');
  });

  it('refuses to run without Twilio credentials', async () => {
    await expect(port(201, {}, [], {}).sendSms(sms)).rejects.toThrow(/not configured/);
  });
});

describe('print', () => {
  const job = { outboxId: 'o2', printerId: '74001', pdf: new Uint8Array([37, 80, 68, 70]), title: 'Plans' };

  it('is skipped cleanly when printing is not configured', async () => {
    const calls: Call[] = [];
    expect(await port(201, 1, calls, { ...env, PRINTNODE_API_KEY: '' }).print(job)).toEqual({ status: 'skipped', reason: expect.stringContaining('not configured') });
    expect(await port(201, 1, calls).print({ ...job, printerId: undefined })).toMatchObject({ status: 'skipped' });
    expect(calls).toHaveLength(0);
  });

  it('sends a base64 PDF job to PrintNode', async () => {
    const calls: Call[] = [];
    expect(await port(201, 991, calls).print(job)).toEqual({ status: 'printed', jobId: '991' });
    const sent = JSON.parse(String(calls[0]?.init.body));
    expect(sent).toMatchObject({ printerId: 74001, contentType: 'pdf_base64', content: 'JVBERg==', source: 'fortune-ai-hq' });
  });
});

describe('proposal PDF', () => {
  const source = { system: 'zetaris' as const, view: 'fortune_demo_finance_mart', queryHash: 'd'.repeat(64), asOf: '2026-10-26T12:00:00Z' };
  const metric: Metric = { id: 'm:online.revenue.mazali', label: 'Online Mazali revenue', value: 12400, unit: 'usd', business: 'online', period: '2026-09', source };
  const plan = (rank: number) => ({
    rank, title: `Plan “${rank}” — grow × 2 🙂`, summary: 'Mazali brought in $12,400.', actions: ['Raise the budget'],
    evidence: [{ metricId: metric.id, value: 12400 }], projections: [{ label: 'Revenue', baseMetricId: metric.id, factor: 1.1, result: 13640, assumption: 'Steady demand' }],
    levers: [{ label: 'Add-on price', value: 10, unit: 'usd' as const }], test: 'Two weeks.', stopLoss: 'Stop if ROAS falls.', businesses: ['online' as const], risks: ['Costs'],
  });
  const doc: ProposalDocument = {
    proposalId: '33333333-3333-4333-8333-333333333333', title: 'Three profit plans', requestedBy: 'Demo Owner', preparedBy: 'Finance assistant',
    createdAt: '2026-10-26T12:00:00Z', plans: { plans: [plan(1), plan(2), plan(3)], memoryConflicts: [] }, citedMetrics: [metric],
    approvalHint: 'Approve by text with your one-time code.',
  };

  it('renders a PDF even with characters standard fonts cannot encode', async () => {
    const bytes = await createDeliveryPort(env, { fetch, now: () => new Date(), sentLedger: new Set() }).renderProposalPdf(doc);
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(1500);
  });

  it('maps text to WinAnsi', () => {
    expect(toWinAnsi('a × b — “c” 🙂')).toBe('a x b - "c" ');
  });
});
