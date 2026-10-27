import { describe, expect, it } from 'vitest';
import { MANAGERS, type ManagedDivision } from '@fahq/contracts';
import { buildWeeklyEmail, buildWorkerEmail, createDeliveryPort } from '../src/index.ts';
import { weeklyReport, workerReport } from './report-fixtures.ts';

const env = { POSTMARK_HQ_SERVER_TOKEN: 'pm-test-only-token', POSTMARK_HQ_FROM: 'reports@example.com' } as NodeJS.ProcessEnv;
const OWNER = 'owner@example.com';

type Call = { url: string; init: RequestInit };
function fetchMock(status: number, body: unknown, calls: Call[]) {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}
const port = (status: number, body: unknown, calls: Call[], e = env) =>
  createDeliveryPort(e, { fetch: fetchMock(status, body, calls), now: () => new Date('2026-10-26T12:00:00Z'), sentLedger: new Set<string>() });

const pdf = new Uint8Array([37, 80, 68, 70, 45, 49]); // %PDF-1
const mail = { outboxId: 'e1', to: OWNER, subject: "For Alan: George's weekly report", html: '<p>Hi</p>', text: 'Hi', attachments: [{ name: 'Finance-weekly.pdf', pdf }], allowedRecipients: new Set([OWNER]) };
const OK = { To: OWNER, MessageID: 'pm-message-1', ErrorCode: 0, Message: 'OK' };

describe('sendEmail', () => {
  it('posts exactly the documented Postmark request, with the PDF attached, and returns the message id', async () => {
    const calls: Call[] = [];
    const result = await port(200, OK, calls).sendEmail(mail);
    expect(result).toEqual({ status: 'sent', providerMessageId: 'pm-message-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.postmarkapp.com/email');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.redirect).toBe('error');
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.init.headers).toMatchObject({ 'X-Postmark-Server-Token': 'pm-test-only-token', 'Content-Type': 'application/json' });
    const sent = JSON.parse(String(calls[0]?.init.body));
    expect(sent).toMatchObject({ From: 'reports@example.com', To: OWNER, Subject: "For Alan: George's weekly report", HtmlBody: '<p>Hi</p>', TextBody: 'Hi', MessageStream: 'outbound', TrackOpens: false });
    expect(sent.Attachments).toEqual([{ Name: 'Finance-weekly.pdf', Content: Buffer.from(pdf).toString('base64'), ContentType: 'application/pdf' }]);
  });

  it('refuses any other address without a network call', async () => {
    const calls: Call[] = [];
    await expect(port(200, OK, calls).sendEmail({ ...mail, to: 'alan@example.com' })).rejects.toThrow(/not an allowed address/);
    expect(calls).toHaveLength(0);
  });

  it('never lets one configured value mean two recipients, or a recipient with a name part', async () => {
    const calls: Call[] = [];
    for (const to of ['owner@example.com, alan@example.com', 'Owner <owner@example.com>', 'owner@example.com\r\nBcc: x@example.com']) {
      await expect(port(200, OK, calls).sendEmail({ ...mail, to, allowedRecipients: new Set([to]) })).rejects.toThrow(/not an allowed address/);
    }
    expect(calls).toHaveLength(0);
  });

  it('matches the allowed address without regard to case or surrounding spaces', async () => {
    const calls: Call[] = [];
    await port(200, OK, calls).sendEmail({ ...mail, to: ' Owner@Example.com ' });
    expect(JSON.parse(String(calls[0]?.init.body)).To).toBe('Owner@Example.com');
  });

  it('never sends the same outbox item twice', async () => {
    const calls: Call[] = [];
    const p = port(200, OK, calls);
    await p.sendEmail(mail);
    await expect(p.sendEmail(mail)).rejects.toThrow(/already sent/);
    expect(calls).toHaveLength(1);
  });

  it('is skipped, with a plain reason and no network call, when there is no token or no sender', async () => {
    const calls: Call[] = [];
    expect(await port(200, OK, calls, { POSTMARK_HQ_FROM: 'reports@example.com' } as NodeJS.ProcessEnv).sendEmail(mail)).toEqual({ status: 'skipped', reason: expect.stringContaining('no Postmark server token') });
    expect(await port(200, OK, calls, { POSTMARK_HQ_SERVER_TOKEN: 'x' } as NodeJS.ProcessEnv).sendEmail(mail)).toEqual({ status: 'skipped', reason: expect.stringContaining('no sender address') });
    expect(await port(200, OK, calls, { ...env, POSTMARK_HQ_FROM: 'not an address' }).sendEmail(mail)).toMatchObject({ status: 'skipped' });
    expect(calls).toHaveLength(0);
  });

  it('still refuses a wrong recipient when there is no token (a bug is never hidden by a missing setting)', async () => {
    await expect(port(200, OK, [], {} as NodeJS.ProcessEnv).sendEmail({ ...mail, to: 'alan@example.com' })).rejects.toThrow(/not an allowed address/);
  });

  it('reports a Postmark refusal without echoing its body', async () => {
    const body = JSON.stringify({ ErrorCode: 406, Message: 'Inactive recipient owner@example.com; token pm-test-only-token' });
    const error = (await port(422, body, []).sendEmail(mail).then(() => null, (e: unknown) => e)) as Error;
    expect(error.message).toBe('Postmark refused the message (HTTP 422)');
    expect(error.message).not.toContain('owner@example.com');
  });

  it('treats an answer that is 200 but carries an error code as a refusal, without echoing it', async () => {
    const error = (await port(200, { ErrorCode: 300, Message: 'secret detail about owner@example.com' }, []).sendEmail(mail).then(() => null, (e: unknown) => e)) as Error;
    expect(error.message).toBe('Postmark did not accept the message');
  });

  it('says the message may not have been sent when Postmark cannot be reached, without the cause', async () => {
    const down = createDeliveryPort(env, { fetch: (async () => { throw new Error('connect ECONNREFUSED 1.2.3.4 token pm-test-only-token'); }) as unknown as typeof fetch, now: () => new Date(), sentLedger: new Set() });
    const error = (await down.sendEmail(mail).then(() => null, (e: unknown) => e)) as Error;
    expect(error.message).toBe('Postmark could not be reached; the message may not have been sent');
  });

  it('keeps a subject and an attachment name to one safe line', async () => {
    const calls: Call[] = [];
    await port(200, OK, calls).sendEmail({ ...mail, subject: 'For Alan\r\nBcc: x@example.com', attachments: [{ name: '../weekly "report"\n.pdf', pdf }] });
    const sent = JSON.parse(String(calls[0]?.init.body));
    expect(sent.Subject).not.toMatch(/[\r\n]/);
    expect(sent.Attachments[0].Name).toBe('.._weekly _report__.pdf');
  });

  it('refuses attachments too large for Postmark', async () => {
    await expect(port(200, OK, []).sendEmail({ ...mail, attachments: [{ name: 'big.pdf', pdf: new Uint8Array(7_000_001) }] })).rejects.toThrow(/too large/);
  });
});

describe('the email that carries a report', () => {
  const ctxOf = (d: ManagedDivision) => ({ manager: MANAGERS[d].manager, head: MANAGERS[d].head, divisionTitle: MANAGERS[d].title });

  it.each(['finance', 'online', 'salon'] as ManagedDivision[])('labels the %s weekly email for its head', (division) => {
    const mailOut = buildWeeklyEmail(weeklyReport(division), ctxOf(division));
    expect(mailOut.subject).toBe(`For ${MANAGERS[division].head}: ${MANAGERS[division].manager}'s weekly report`);
    expect(mailOut.text).toContain(weeklyReport(division).summary);
    expect(mailOut.html).toContain(`For ${MANAGERS[division].head}`);
    expect(mailOut.attachmentName).toBe(`${MANAGERS[division].title}-weekly-report-2026-10-26.pdf`);
  });

  it("carries George's goal and three paths, and the approve hint without any code", () => {
    const out = buildWeeklyEmail(weeklyReport('finance'), ctxOf('finance'));
    expect(out.text).toContain('Lift online contribution by $2,700 this week');
    expect(out.text).toContain('from $21,300 to $24,000');
    for (const n of [1, 2, 3]) expect(out.text).toContain(`${n}. `);
    expect(out.text).toContain('reply APPROVE 1, 2 or 3 by text');
    expect(out.text).not.toMatch(/\d{6}/);
  });

  it('escapes every word of the report for HTML', () => {
    const out = buildWeeklyEmail(weeklyReport('online', { summary: 'Sales <script>alert(1)</script> & "more" for Emma\'s team' }), ctxOf('online'));
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;more&quot; for Emma&#39;s team');
  });

  it('never carries a phone number, an address or a code, in the text or the HTML', () => {
    const dirty = weeklyReport('online', { summary: 'Call +1 (555) 010-0199, write boss@example.com, code 482913.' });
    const out = buildWeeklyEmail(dirty, ctxOf('online'));
    for (const text of [out.text, out.html]) {
      for (const secret of ['555', '482913', 'boss@example.com', '0199']) expect(text).not.toContain(secret);
    }
    expect(out.text).toContain('[phone]');
  });

  it('builds a worker report email with its findings and the numbers they cite', () => {
    const report = workerReport('finance.meta');
    const out = buildWorkerEmail(report, ctxOf('finance'));
    expect(out.subject).toBe('For Alan: Meta ads daily report');
    expect(out.text).toContain(report.headline);
    expect(out.text).toContain('Meta ad return (revenue / spend) 1.4x');
    expect(out.attachmentName).toBe('Finance-meta-2026-10-26.pdf');
  });
});
