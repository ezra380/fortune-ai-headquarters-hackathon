import { describe, expect, it, vi } from 'vitest';
import type { AssistantMemory } from '@fahq/brain';
import { PERIOD_KEYS, WorkReport, type Receipt } from '@fahq/contracts';
import { parseCommand } from '../src/commands.ts';
import { departmentLine } from '../src/departments.ts';
import { PLAN_SYSTEM, PlanError, financePeriod, planDigest, writePlans } from '../src/finance.ts';
import { checkReview, renderFacts } from '../src/manager.ts';
import { buildWorkReport, codeModeDetail, numberTrace, summarizeUsage, type UsageRow } from '../src/reports.ts';
import { dataMock, mockMetrics, modelMock, onlinePlans, salonPlans, validPlans } from './fixtures.ts';

describe('parseCommand', () => {
  it('reads approval commands exactly, case and spacing aside', () => {
    expect(parseCommand('send 2 123456')).toEqual({ kind: 'send', planRank: 2, code: '123456' });
    expect(parseCommand('  CONFIRM   654321 ')).toEqual({ kind: 'confirm', code: '654321' });
    expect(parseCommand('decline 111111')).toEqual({ kind: 'decline', code: '111111' });
    expect(parseCommand('STATUS')).toEqual({ kind: 'status' });
  });

  it('treats "yes" and near-misses as malformed, never as approval', () => {
    for (const t of ['yes', 'OK', 'send 4 123456', 'SEND 2', 'CONFIRM 12345', 'confirm it']) {
      expect(parseCommand(t)?.kind).toBe('malformed');
    }
    expect(parseCommand('Give me three plans to double profit')).toBeNull();
  });

  it('keeps a code next to an approval word away from the model, and lets requests through', () => {
    expect(parseCommand('ok send 2 482913 thanks')?.kind).toBe('malformed'); // used to reach the router with the code
    expect(parseCommand('Yes CONFIRM 654321 please')?.kind).toBe('malformed');
    expect(parseCommand('Send me three plans to double profit')).toBeNull(); // used to be swallowed as malformed
    expect(parseCommand('Confirm what the salon made last month')).toBeNull();
  });

  it('reads REVIEW and ADOPT exactly: ranks 1-3, each once, separated by spaces or commas', () => {
    expect(parseCommand('review')).toEqual({ kind: 'review' });
    expect(parseCommand(' Review ')).toEqual({ kind: 'review' });
    expect(parseCommand('adopt 2 123456')).toEqual({ kind: 'adopt', ranks: [2], code: '123456' });
    expect(parseCommand('ADOPT 1 2 123456')).toEqual({ kind: 'adopt', ranks: [1, 2], code: '123456' });
    expect(parseCommand('Adopt 3,1 123456')).toEqual({ kind: 'adopt', ranks: [1, 3], code: '123456' }); // sorted
    expect(parseCommand('ADOPT 1, 2, 3 654321')).toEqual({ kind: 'adopt', ranks: [1, 2, 3], code: '654321' });
  });

  it('keeps a code next to ADOPT away from any model, like SEND and CONFIRM', () => {
    for (const t of ['adopt 4 123456', 'ADOPT 1 1 123456', 'ADOPT 1 2 3 1 123456', 'ADOPT 1 12345', 'please adopt 2 482913 thanks', 'ADOPT 123456', 'ADOPT 0 123456']) {
      expect(parseCommand(t)?.kind, t).toBe('malformed');
    }
    // ADOPT alone, with one short token, or with ranks but no code is malformed too.
    for (const t of ['ADOPT', 'adopt 2', 'ADOPT it', 'ADOPT 1 2', 'ADOPT 1,2,3']) {
      expect(parseCommand(t)?.kind, t).toBe('malformed');
    }
    expect((parseCommand('ADOPT') as { hint: string }).hint).toContain('ADOPT');
  });

  it('lets a request that starts with "adopt" or "review" through to the router', () => {
    expect(parseCommand('Adopt a new pricing strategy for October')).toBeNull();
    expect(parseCommand('Adopt the evening slots idea from last month')).toBeNull();
    expect(parseCommand('Review last week for me')).toBeNull();
    expect(parseCommand('review 123456')).toBeNull(); // REVIEW takes no code; nothing to approve
  });
});

// MOCK memory: no past decisions.
const memoryMock = { recallDecisions: () => [], declinedSimilarTo: () => [] } as unknown as AssistantMemory;
const base = { planModel: 'nvidia/ultra', data: dataMock, memory: memoryMock, now: new Date('2026-10-26T12:00:00Z'), request: 'Three plans to double profit', period: '2026-09' as const };

describe('writePlans', () => {
  // Merge wave 1, item c: the finance mailbox (flows.ts) keeps writePlans' error as the failure detail, so the data
  // read inside it must never carry a provider's text (an HTTP body, SQL, a host name, an email).
  it("keeps the data source's own text out of its failure: a fixed sentence with a code, the detail in the log", async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const data = { ...dataMock, getFinanceMetrics: async () => { throw new Error('HTTP 500: AnalysisException near SELECT * FROM fortune_hq_v2.period_metrics on zetaris-node-7.internal:18121 for demo@example.com'); } };
    await expect(writePlans({ ...base, data, model: modelMock() })).rejects.toThrow(/^Business data could not be read \(ZETARIS_READ\)\.$/);
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringMatching(/^worker\.zetaris_read_failed Error: HTTP 500: AnalysisException/)]);
    expect(log.mock.calls.join('\n')).not.toContain('demo@example.com');
    log.mockRestore();
  });

  it('accepts valid plans on the first try', async () => {
    const result = await writePlans({ ...base, model: modelMock() });
    expect(result.attempts).toBe(1);
    expect(result.citedMetricIds).toContain('m:salon.revenue.wash_set');
    expect(planDigest(result.plans).split('\n')).toHaveLength(3);
  });

  it('gives the model one correction round with the exact objections', async () => {
    const wrong = structuredClone(validPlans);
    wrong.plans[0]!.evidence[0]!.value = 99999;
    const model = modelMock([JSON.stringify(wrong), JSON.stringify(validPlans)]);
    const result = await writePlans({ ...base, model });
    expect(result.attempts).toBe(2);
    expect(model.calls).toEqual(['finance.plans', 'finance.plans']);
    // The first attempt's objections are kept (the report quotes the first), and tokens are split.
    expect(result.firstObjections[0]).toContain('says 99999');
    expect(result.inputTokens).toBe(200);
    expect(result.outputTokens).toBe(400);
    expect(result.tokens).toBe(600);
    expect((await writePlans({ ...base, model: modelMock() })).firstObjections).toEqual([]); // a first-try pass has none
  });

  it('fails plainly when the plans still do not check out', async () => {
    const wrong = structuredClone(validPlans);
    wrong.plans[1]!.summary = 'This adds $50,000.';
    await expect(writePlans({ ...base, model: modelMock([JSON.stringify(wrong)]) })).rejects.toBeInstanceOf(PlanError);
  });

  it('sends the owner\'s adopted lessons to the plan writer, with rule 9 telling it to follow them', async () => {
    const model = modelMock();
    await writePlans({ ...base, model, lessons: ['Always give each stop-loss a lever.', 'Name the business in every action.'] });
    const sent = model.inputs[0]!;
    expect(JSON.parse(sent.user).ownerLessons).toEqual(['Always give each stop-loss a lever.', 'Name the business in every action.']);
    expect(sent.system).toContain('9. ownerLessons are standing guidance the owner adopted. Follow them unless they conflict with rules 1-8.');
    for (let n = 1; n <= 8; n++) expect(sent.system).toContain(`\n${n}. `); // rules 1-8 are still there
    const none = modelMock();
    await writePlans({ ...base, model: none });
    expect(JSON.parse(none.inputs[0]!.user).ownerLessons).toEqual([]);
  });

  it('for a department: plans from its own slice only, under its own purpose, with one line added to the rules', async () => {
    const model = modelMock([JSON.stringify(onlinePlans)]);
    const result = await writePlans({ ...base, model, department: 'online' });
    expect(result.metrics.map((m) => m.id)).toEqual(['m:online.revenue.mazali', 'm:online.ads.google.spend', 'm:online.ads.google.roas']);
    expect(model.calls).toEqual(['online.plans']);
    expect(model.inputs[0]!.system).toBe(`${PLAN_SYSTEM}\n${departmentLine('online')}`);
    expect((JSON.parse(model.inputs[0]!.user).metrics as { business: string }[]).every((m) => m.business === 'online')).toBe(true);
    // Another department's numbers are not in its slice, so plans that cite them fail on that slice alone.
    const cross = modelMock([JSON.stringify(salonPlans)]);
    await expect(writePlans({ ...base, model: cross, department: 'online' })).rejects.toThrow(/unknown metric m:salon/);
  });

  it("for a department, plans from its division's metrics when the port's catalog names divisions, even from a round's source", async () => {
    const divisions: Record<string, ('finance' | 'online' | 'salon' | 'hq')[]> = {
      'm:online.revenue.mazali': ['online', 'finance'], 'm:online.ads.google.spend': ['online', 'finance'], 'm:online.ads.google.roas': ['online'],
      'm:salon.revenue.wash_set': ['salon', 'finance'], 'm:salon.appointments.count': ['salon'],
    };
    const data = { ...dataMock, catalog: mockMetrics.map(({ id, label, unit, business }) => ({ id, label, unit, business, divisions: divisions[id] })) };
    const model = modelMock([JSON.stringify(validPlans)]);
    const source = { metrics: mockMetrics, queryHash: 'd'.repeat(64), view: 'the_view' };
    // Online's own ad return is not Finance's to plan from, so plans citing it fail on Finance's slice.
    await expect(writePlans({ ...base, data, source, model, department: 'finance' })).rejects.toThrow(/unknown metric m:online.ads.google.roas/);
    expect((JSON.parse(model.inputs[0]!.user).metrics as { id: string }[]).map((m) => m.id)).toEqual(['m:online.revenue.mazali', 'm:online.ads.google.spend', 'm:salon.revenue.wash_set']);
    const online = await writePlans({ ...base, data, source, model: modelMock([JSON.stringify(onlinePlans)]), department: 'online' });
    expect(online.metrics.map((m) => m.id)).toEqual(['m:online.revenue.mazali', 'm:online.ads.google.spend', 'm:online.ads.google.roas']);
  });

  it("holds a plan's small counts to what the catalog says each cited count counts, and tells the writer each metric's period", async () => {
    const data = { ...dataMock, catalog: mockMetrics.map(({ id, label, unit, business }) => ({ id, label, unit, business, ...(id === 'm:salon.appointments.count' ? { nouns: ['appointment', 'appointments'] } : {}) })) };
    const invented = structuredClone(salonPlans);
    invented.plans[1]!.actions = ['Add 4 appointments on quiet weekdays'];
    const model = modelMock([JSON.stringify(invented)]);
    await expect(writePlans({ ...base, data, model, department: 'salon' })).rejects.toThrow(/"4 appointments" counts what m:salon.appointments.count counts/);
    expect((JSON.parse(model.inputs[0]!.user).metrics as { period: string }[]).every((m) => m.period === '2026-09')).toBe(true);
    // The same plans pass when the data names no count words (a port without a catalog), as before.
    await expect(writePlans({ ...base, model: modelMock([JSON.stringify(invented)]), department: 'salon' })).resolves.toMatchObject({ attempts: 1 });
    expect(PLAN_SYSTEM).toContain('A metric whose period is "standing" is as of the data date');
    expect(PLAN_SYSTEM).toContain('A seasonal budget is one too: base m:online.budget.<channel>.cap × factor = the value of m:online.season.last_year_index.');
    expect(PLAN_SYSTEM).toContain('A number under 100 next to what a cited count metric counts ("3 overdue invoices") must be THAT count\'s value, one of its projections or a count lever; when two cited counts count the same thing, name which ("3 late repairs", not "3 repairs").');
  });

  it('reads the metrics once for a whole round: with a source it never touches the data port', async () => {
    const source = { metrics: mockMetrics, queryHash: 'd'.repeat(64), view: 'the_view' };
    const result = await writePlans({ ...base, data: undefined, source, model: modelMock([JSON.stringify(salonPlans)]), department: 'salon' });
    expect(result).toMatchObject({ view: 'the_view', queryHash: 'd'.repeat(64) });
    await expect(writePlans({ ...base, data: undefined, model: modelMock() })).rejects.toThrow('business data is not connected');
  });

  it('fails plainly, with no model call, when a department has no metrics, and carries the tokens of a failed attempt', async () => {
    const model = modelMock();
    const onlineOnly = { metrics: mockMetrics.filter((m) => m.business === 'online'), queryHash: 'e'.repeat(64), view: 'v' };
    await expect(writePlans({ ...base, source: onlineOnly, model, department: 'salon' })).rejects.toThrow('the data source returned no metrics for the Salon department');
    expect(model.calls).toEqual([]);
    const wrong = structuredClone(validPlans);
    wrong.plans[1]!.summary = 'This adds $50,000.';
    const error = await writePlans({ ...base, model: modelMock([JSON.stringify(wrong)]) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlanError);
    expect((error as PlanError).usage).toEqual({ inputTokens: 200, outputTokens: 400 });
  });
});

// ---- End-of-work reports ---------------------------------------------------------------------

const RUN = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000b1';
const t0 = new Date('2026-10-26T12:00:00.000Z');
const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000).toISOString();
const rc = (step: string, over: Partial<Receipt> = {}): Receipt => ({
  runId: RUN, taskId: TASK, step, assistantId: 'finance', live: false, model: null, dataSource: null,
  startedAt: at(0), endedAt: at(2), costUsd: null, outcome: 'ok', detail: null, ...over,
});
const task = { id: TASK, assistant_id: 'finance' as const, kind: 'mailbox' };
const report = (receipts: Receipt[], over: { outcome?: 'done' | 'failed' | 'retrying'; error?: string | null; seconds?: number } = {}) =>
  buildWorkReport({ task, outcome: over.outcome ?? 'done', error: over.error ?? null, receipts, startedAt: t0, endedAt: new Date(t0.getTime() + (over.seconds ?? 5) * 1000) });

// Review 2026-10-27: FINANCE_PERIOD=2026-08 passed startup under data version 1, then every finance read failed.
describe('financePeriod (FINANCE_PERIOD at startup)', () => {
  it('uses a period the data serves, and otherwise plans for the default period with a reason to log', () => {
    expect(financePeriod('2026-09')).toEqual({ period: '2026-09', note: null });
    expect(financePeriod('2026-10-mtd')).toEqual({ period: '2026-10-mtd', note: null });
    expect(financePeriod('2026-08')).toEqual({
      period: '2026-10-mtd', note: 'FINANCE_PERIOD "2026-08" is not used (this data serves only 2026-09, 2026-10-mtd); planning for 2026-10-mtd',
    });
    expect(financePeriod('2026-08', PERIOD_KEYS)).toEqual({ period: '2026-08', note: null });
    expect(financePeriod('2026-13')).toEqual({ period: '2026-10-mtd', note: 'FINANCE_PERIOD "2026-13" is not used (it is not a period); planning for 2026-10-mtd' });
  });

  // Merge wave 1, item e (design 4g): with no FINANCE_PERIOD, plans are for this month (2026-10-mtd) when the data serves
  // it, so budget room and the last-year index mean "this month"; otherwise for the latest period the data serves.
  it('defaults to 2026-10-mtd when the data serves it, else to the latest period it serves; a typo falls back the same way', () => {
    expect(financePeriod(undefined)).toEqual({ period: '2026-10-mtd', note: null });
    expect(financePeriod(undefined, PERIOD_KEYS)).toEqual({ period: '2026-10-mtd', note: null });
    expect(financePeriod(undefined, ['2026-07', '2026-09', '2026-08'])).toEqual({ period: '2026-09', note: null });
    expect(financePeriod('2026-13', ['2026-08', '2026-09'])).toEqual({ period: '2026-09', note: 'FINANCE_PERIOD "2026-13" is not used (it is not a period); planning for 2026-09' });
  });
});

describe('buildWorkReport', () => {
  it('turns receipts into a report that passes the contract: steps, usage and one sentence', () => {
    const r = report([
      rc('finance.plans', { model: 'nvidia/ultra', inputTokens: 1000, outputTokens: 2500, startedAt: at(0), endedAt: at(100), detail: 'attempts 1, tokens 3500, cited 5 metrics' }),
      rc('approval.forward', { assistantId: 'owner', startedAt: at(100), endedAt: at(101), detail: 'plan 2 forwarded to demo-p-finance-owner' }),
    ], { seconds: 112 });
    expect(WorkReport.safeParse(r).success).toBe(true);
    expect(r.summary).toBe('mailbox task done in 112 s; finance.plans ok (attempt 1 of 2), approval.forward ok');
    expect(r.steps.map((s) => [s.step, s.ms, s.inputTokens, s.outputTokens])).toEqual([['finance.plans', 100_000, 1000, 2500], ['approval.forward', 1000, null, null]]);
    expect(r.usage).toEqual({ modelCalls: 1, inputTokens: 1000, outputTokens: 2500 });
    expect(r).toMatchObject({ taskId: TASK, runId: RUN, assistant: 'finance', taskKind: 'mailbox', outcome: 'done', startedAt: at(0), endedAt: at(112) });
    expect(r.suggestions).toEqual([{ kind: 'speed', about: 'finance', text: 'finance.plans took 100 s' }]); // slower than 60 s
  });

  it('suggests a reliability fix for a failed step, naming the step and its detail', () => {
    const r = report([rc('finance.plans', { outcome: 'failed', model: 'nvidia/ultra', detail: 'plans failed validation: plan 1: bad' })], { outcome: 'failed', error: 'plans not produced' });
    expect(r.suggestions).toEqual([{ kind: 'reliability', about: 'finance', text: 'finance.plans failed: plans failed validation: plan 1: bad' }]);
    expect(r.summary).toContain('mailbox task failed');
  });

  it('suggests a prompt fix when the plan writer needed a correction round, quoting the first objection', () => {
    const detail = 'attempts 2, tokens 7000, cited 4 metrics; first objection: plan 1: evidence m:online.ads.google.spend says 1900 but the source says 1800';
    const r = report([rc('finance.plans', { model: 'nvidia/ultra', detail })]);
    expect(r.suggestions).toEqual([{
      kind: 'prompt', about: 'finance',
      text: 'The plan writer needed a correction round. First objection: plan 1: evidence m:online.ads.google.spend says 1900 but the source says 1800',
    }]);
    expect(r.summary).toContain('finance.plans ok (attempt 2 of 2)');
    expect(report([rc('finance.plans', { detail: 'attempts 1, tokens 1, cited 1 metrics' })]).suggestions).toEqual([]);
  });

  it('suggests a prompt fix for the receiving assistant when the front door did not validate', () => {
    const r = report([rc('front-door', { assistantId: 'owner', outcome: 'refused', model: 'nvidia/lightning', detail: 'unknown → owner; risks: none; router output did not validate' })]);
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]).toMatchObject({ kind: 'prompt', about: 'owner' });
    expect(r.suggestions[0]!.text).toContain('router output did not validate');
  });

  it('flags only steps slower than 60 seconds, with the seconds', () => {
    expect(report([rc('a.slow', { endedAt: at(60) })]).suggestions).toEqual([]);
    expect(report([rc('a.slow', { assistantId: 'owner', endedAt: at(75) })]).suggestions).toEqual([{ kind: 'speed', about: 'owner', text: 'a.slow took 75 s' }]);
  });

  it('reads Code Mode steps: a retry is a prompt suggestion with the sandbox error, a failure is a reliability one', () => {
    const retried = report([rc('owner.lookup', { assistantId: 'owner', model: 'nvidia/ultra', inputTokens: 500, outputTokens: 200, detail: codeModeDetail({ attempts: 2, toolCalls: 3, resultChars: 410, error: 'ReferenceError: rows is not defined' }) })]);
    expect(retried.suggestions).toEqual([{ kind: 'prompt', about: 'owner', text: 'owner.lookup: the script needed 2 attempts. Sandbox error: ReferenceError: rows is not defined' }]);
    expect(retried.usage.codeMode).toEqual({ scripts: 1, toolCalls: 3, resultChars: 410 });

    const failed = report([rc('manager.digest', { assistantId: 'manager', outcome: 'failed', model: 'nvidia/ultra', detail: codeModeDetail({ attempts: 2, toolCalls: 0, resultChars: 0, error: 'the script ran past its time limit' }) })], { outcome: 'failed', error: 'digest failed' });
    expect(failed.suggestions).toEqual([{ kind: 'reliability', about: 'manager', text: expect.stringContaining('manager.digest failed: code mode: attempts 2') }]);
  });

  it('files a model budget refusal as a cost suggestion, not a reliability one', () => {
    const r = report([rc('finance.plans', { outcome: 'failed', model: 'nvidia/ultra', detail: 'daily token budget reached (990000 of 1000000)' })], { outcome: 'failed', error: 'x' });
    expect(r.suggestions.map((s) => s.kind)).toEqual(['cost']);
    expect(r.suggestions[0]!.text).toContain('daily token budget reached');
  });

  it('suggests a prompt fix when an answer writer was refused (failed the number check)', () => {
    const r = report([rc('owner.answer', { assistantId: 'owner', outcome: 'refused', model: 'nvidia/ultra', detail: 'answer: "8" is not a number in the data' })]);
    expect(r.suggestions).toEqual([{ kind: 'prompt', about: 'owner', text: 'owner.answer was refused: answer: "8" is not a number in the data' }]);
    // A refused approval code is not a system fault.
    expect(report([rc('approval.forward', { outcome: 'refused', detail: 'code refused' })]).suggestions).toEqual([]);
  });

  it('drops identical suggestions and keeps at most ten', () => {
    const same = Array.from({ length: 12 }, () => rc('x.step', { outcome: 'failed', detail: 'boom' }));
    expect(report(same, { outcome: 'failed' }).suggestions).toHaveLength(1);
    const distinct = Array.from({ length: 12 }, (_, i) => rc(`x.step${i}`, { outcome: 'failed', detail: 'boom' }));
    const r = report(distinct, { outcome: 'failed' });
    expect(r.suggestions).toHaveLength(10);
    expect(r.steps).toHaveLength(12);
    expect(WorkReport.safeParse(r).success).toBe(true);
  });

  it('says so once when a task failed outside any step, and still reports a task with no receipts', () => {
    const failed = report([], { outcome: 'failed', error: 'the sender is not registered or the text is empty' });
    expect(failed.suggestions).toEqual([{ kind: 'reliability', about: 'finance', text: 'The task failed: the sender is not registered or the text is empty' }]);
    expect(failed.summary).toBe('mailbox task failed in 5 s; no steps recorded; the sender is not registered or the text is empty');
    expect(failed.runId).toMatch(/^[0-9a-f-]{36}$/);
    const retry = report([rc('finance.plans')], { outcome: 'retrying', error: 'timeout' });
    expect(retry.outcome).toBe('retrying');
    expect(retry.summary).toContain('will retry');
  });

  it('never lets the end come before the start', () => {
    const r = buildWorkReport({ task, outcome: 'done', error: null, receipts: [], startedAt: t0, endedAt: new Date(t0.getTime() - 5000) });
    expect(r.endedAt).toBe(r.startedAt);
  });
});

describe('summarizeUsage', () => {
  const row = (assistant: UsageRow['assistant_id'], outcome: UsageRow['outcome'], calls: number, tin: number, tout: number, seconds: number): UsageRow => ({
    assistant_id: assistant, outcome, model_calls: calls, input_tokens: tin, output_tokens: tout, started_at: at(0), ended_at: at(seconds),
  });

  it('adds up tasks, outcomes, calls, tokens and average seconds per assistant, in assistant order', () => {
    const out = summarizeUsage([
      row('finance', 'done', 2, 1000, 3000, 100),
      row('owner', 'done', 1, 200, 100, 4),
      row('finance', 'failed', 1, 500, 0, 11),
      row('finance', 'retrying', 0, 0, 0, 0),
    ], t0);
    expect(out.since).toBe(t0.toISOString());
    expect(out.byAssistant.map((a) => a.assistant)).toEqual(['owner', 'finance']);
    expect(out.byAssistant[1]).toEqual({ assistant: 'finance', tasks: 3, done: 1, failed: 1, retrying: 1, modelCalls: 3, inputTokens: 1500, outputTokens: 3000, avgSeconds: 37 });
    expect(out.totals).toEqual({ tasks: 4, done: 2, failed: 1, retrying: 1, modelCalls: 4, inputTokens: 1700, outputTokens: 3100, avgSeconds: 28.8 });
  });

  it('is all zeros, with no assistants, when there was no work', () => {
    expect(summarizeUsage([], t0)).toEqual({
      since: t0.toISOString(), byAssistant: [],
      totals: { tasks: 0, done: 0, failed: 0, retrying: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, avgSeconds: 0 },
    });
  });
});

describe('numberTrace', () => {
  const digest = {
    byAssistant: [{ assistant: 'finance', tasks: 3, failed: 1, inputTokens: 1500, outputTokens: 3000, avgSeconds: 112.4 }],
    suggestions: [{ text: 'finance.plans took 75 s', share: 0.4 }],
  };
  const trace = (...texts: string[]) => numberTrace(texts.map((t, i) => [`text ${i + 1}`, t] as const), digest);

  it('passes numbers that are in the data, however they are written', () => {
    expect(trace('Finance used 1,500 tokens in and 3000 out.', 'That is 1.5k tokens in.', 'Average 112.4 s, so about 112 s.', 'One step took 75 s.', 'About 40% of runs.')).toEqual([]);
  });

  // Live run 2026-10-27: Nemotron wrote ROAS 7.1225 and a rate 0.002 for data values with more decimals, and 11 of 14
  // worker reports fell back to the rules. A value rounded to 3 or 4 decimals is still that value; anything else is not.
  it('passes a value rounded to 3 or 4 decimals, and still refuses a value the data does not hold', () => {
    const data = { roas: 7.122497, unsubscribe: 0.002137 };
    const t = (text: string) => numberTrace([['t', text]], data);
    expect(t('ROAS was 7.1225, or about 7.12.')).toEqual([]);
    expect(t('Unsubscribes ran at 0.002, or 0.21%.')).toEqual([]);
    expect(t('ROAS was 7.1226.')).toEqual(['t: "7.1226" is not a number in the data']);
    expect(t('Unsubscribes ran at 0.003.')).toEqual(['t: "0.003" is not a number in the data']);
  });

  it('ignores ids, dates, periods and model names, which are names and not claims', () => {
    expect(trace('See m:online.ads.google.roas on 2026-10-26 (period 2026-10-mtd) with nemotron-3-ultra.')).toEqual([]);
  });

  it('refuses a number that is not in the data, naming the text and the number', () => {
    expect(trace('Finance had 8 failures.', 'Average 113 s.')).toEqual([
      'text 1: "8" is not a number in the data',
      'text 2: "113" is not a number in the data',
    ]);
    expect(trace('It cost $4.20.')).toEqual(['text 1: "4.20" is not a number in the data']);
  });

  it('refuses larger numbers written as words instead of skipping them', () => {
    expect(trace('Twelve tasks failed.')).toEqual(['text 1: write "Twelve" in digits so it can be checked, and only if the number is in the data']);
    expect(trace('One task failed and three were slow.')).toEqual([]);
  });

  it('finds numbers inside the data\'s own strings and nested values', () => {
    expect(numberTrace([['t', 'The plan took 75 s.']], { deep: { list: ['finance.plans took 75 s'] } })).toEqual([]);
    expect(numberTrace([['t', 'It was 75.']], { deep: { list: [74] } })).toEqual(['t: "75" is not a number in the data']);
  });

  // Merge wave 1, item b: the twin of the data lane's fix 4e (packages/contracts validate.ts isRowId). A hyphen after a
  // word no longer hides a figure; only the digits that close a row id, or sit inside a name, are names.
  it('reads a figure written after a word and a hyphen, and skips only a row id or a name such as nemotron-3-ultra', () => {
    const data = { margin: 0.2, roas: 4.1, spend: 3000 };
    const t = (text: string) => numberTrace([['t', text]], data);
    expect(t('A high-35% margin.')).toEqual(['t: "35%" is not a number in the data']);
    expect(t('ROAS-9.5x this month.')).toEqual(['t: "9.5x" is not a number in the data']);
    expect(t('The top-100 buyers.')).toEqual(['t: "100" is not a number in the data']);
    expect(t('A sub-$5,000 test.')).toEqual(['t: "5,000" is not a number in the data']);
    expect(t('A mid-20% margin and ROAS-4.1x on a sub-$3,000 spend.')).toEqual([]); // in the data, so they pass
    expect(t('It ran on nvidia/nemotron-3.5-lightning-30b-a3b and nemotron-3-ultra.')).toEqual([]);
    expect(t("SUP-2201's total is 7.")).toEqual(['t: "2201" is not a number in the data', 't: "7" is not a number in the data']); // glued: not an id
  });

  // Second-key review of merge wave 1: the row id's digits were skipped and nothing else was asked, so a review could name
  // a repair or an invoice that does not exist. A row id must be one the data holds (any case), as a number must.
  it('refuses a row id that is not in the data, and passes one that is', () => {
    const text = 'Invoice SUP-2201 and repair demo-rt-01234 are open; so is demo-s-3.';
    expect(numberTrace([['t', text]], { margin: 0.2 })).toEqual([
      't: "SUP-2201" is not in the data', 't: "demo-rt-01234" is not in the data', 't: "demo-s-3" is not in the data',
    ]);
    expect(numberTrace([['t', text]], { rows: [{ id: 'sup-2201' }, { id: 'demo-rt-01234' }], note: 'Stylist DEMO-S-3 is out.' })).toEqual([]);
    expect(numberTrace([['t', 'Invoice SUP-9999 is open.']], { rows: [{ id: 'SUP-2201' }] })).toEqual(['t: "SUP-9999" is not in the data']);
  });
});

// Figures that once slipped past the trace (senior review, Law 5). Every case here failed before the fix.
describe('numberTrace: small counts, glued units, slashes and signs', () => {
  const quiet = { byAssistant: [{ assistant: 'finance', tasks: 12, failed: 0, inputTokens: 1500 }] };
  const trace = (data: unknown, ...texts: string[]) => numberTrace(texts.map((t, i) => [`text ${i + 1}`, t] as const), data);
  const no = (label: number, n: string) => `text ${label}: "${n}" is not a number in the data`;

  it('checks the plain numbers 1, 2 and 3 like any other', () => {
    expect(trace(quiet, 'Finance failed 3 times.')).toEqual([no(1, '3')]);
    expect(trace(quiet, 'Finance had 2 failed tasks and 1 pending approval.')).toEqual([no(1, '2'), no(1, '1')]);
    expect(trace(quiet, 'You have 2 pending approvals.')).toEqual([no(1, '2')]);
    expect(trace({ pending: 2 }, 'You have 2 pending approvals.')).toEqual([]);
    expect(trace(quiet, 'Finance had 12 tasks and 0 failed.')).toEqual([]);
  });

  it('checks ranks as well: nothing is exempt for being a rank', () => {
    expect(trace(quiet, 'Recommendation 2 of 3 is about the 1st assistant.')).toEqual([no(1, '2'), no(1, '3'), no(1, '1')]);
  });

  it('checks zero, one, two and three written as words', () => {
    expect(trace(quiet, 'Finance had two pending approvals.')).toEqual([no(1, 'two')]);
    expect(trace(quiet, 'Three tasks failed and one was slow.')).toEqual([no(1, 'Three'), no(1, 'one')]);
    expect(trace(quiet, 'Finance had zero failures.')).toEqual([]); // failed: 0 is in the data
    expect(trace({ failed: 1, tasks: 3 }, 'One task failed and three were slow.')).toEqual([]);
    expect(trace(quiet, 'Anyone, someone and everyone can ask.')).toEqual([]); // not number words
  });

  it('counts only digits in the data, never number words inside its strings', () => {
    expect(trace({ note: 'one retry, two tasks' }, 'There was 1 retry.')).toEqual([no(1, '1')]);
  });

  it('checks a number that has letters glued to it', () => {
    expect(trace(quiet, 'Over the last 48h finance failed.')).toEqual([no(1, '48')]);
    expect(trace(quiet, 'finance.plans took 95sec on average.')).toEqual([no(1, '95')]);
    expect(trace(quiet, 'Finance spent 4000tokens.')).toEqual([no(1, '4000')]);
    expect(trace(quiet, 'That is 7kg and 5xyz.')).toEqual([no(1, '7'), no(1, '5')]);
    expect(trace(quiet, 'Finance spent 1500tokens on 12tasks.')).toEqual([]);
    expect(trace(quiet, 'About 1.5k tokens in 12 tasks.')).toEqual([]); // k still means a thousand
  });

  it('checks ordinals as counts', () => {
    expect(trace(quiet, 'It failed for the 7th time.')).toEqual([no(1, '7')]);
    expect(trace(quiet, 'It was the 12th task.')).toEqual([]);
  });

  it('checks both sides of a slash or a colon', () => {
    expect(trace(quiet, 'Finance failed 7/40 tasks.')).toEqual([no(1, '7'), no(1, '40')]);
    expect(trace(quiet, 'A ratio of 7:40.')).toEqual([no(1, '7'), no(1, '40')]);
    expect(trace(quiet, '12/12 tasks ran.')).toEqual([]);
    expect(trace(quiet, 'Tasks:12 ran.')).toEqual([]);
    expect(trace(quiet, 'The ratio is nvidia/nemotron-3-ultra.')).toEqual([]); // a model name is a name
  });

  it('keeps the minus sign: -1500 is not 1500', () => {
    expect(trace(quiet, 'Finance changed by -1500 tokens.')).toEqual([no(1, '-1500')]);
    expect(trace(quiet, 'Finance changed by −1500 tokens (−12 tasks).')).toEqual([no(1, '−1500'), no(1, '−12')]);
    expect(trace(quiet, 'Finance changed by -$1500.')).toEqual([no(1, '-1500')]);
    expect(trace({ change: -1500 }, 'Finance changed by -1500 tokens.')).toEqual([]);
    expect(trace({ note: 'down -1500 tokens' }, 'Finance changed by −1500.')).toEqual([]);
    expect(trace({ change: -1500 }, 'Finance fell by 1500 tokens.')).toEqual([]); // a size may describe a drop
    expect(trace({ share: -0.05 }, 'Down -5%.')).toEqual([]);
    expect(trace({ share: 0.05 }, 'Down -5%.')).toEqual([no(1, '-5%')]);
  });

  it('does not read a range as a minus sign: both ends are checked as plain numbers', () => {
    expect(trace({ a: 10, b: 20 }, 'Between 10-20 tasks, 10–20 even.')).toEqual([]);
    expect(trace({ a: 10 }, 'Between 10-20 tasks.')).toEqual([no(1, '20')]);
    expect(trace({ a: 10, b: 20 }, 'Tasks - 20 of them.')).toEqual([]); // a spaced dash is not a sign
  });
});

// ---- The manager's own checks ----------------------------------------------------------------

describe('checkReview', () => {
  const digest = { byAssistant: [{ assistant: 'finance', tasks: 5, inputTokens: 1500 }], slowest: [{ seconds: 112 }] };
  const rec = (rank: number, assistant: string, change: string, why = 'Finance used 1500 tokens in.') => ({ rank, assistant, change, why });
  const review = (over: Record<string, unknown> = {}) => ({
    summary: 'Finance handled 5 tasks.', findings: [{ assistant: 'finance', text: 'The slowest step took 112 s.' }],
    recommendations: [rec(2, 'owner', 'Ask which business a question is about.'), rec(1, 'finance', 'Give every stop-loss a lever.')], ...over,
  });

  it('accepts a review whose numbers are all in the digest, and puts the recommendations in rank order', () => {
    const check = checkReview(review(), digest, []);
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.review.recommendations.map((r) => r.rank)).toEqual([1, 2]);
  });

  it('refuses what the schema refuses, naming the field', () => {
    const four = [1, 2, 3, 3].map((n) => rec(n, 'finance', `Change ${n}`));
    const check = checkReview(review({ recommendations: four }), digest, []);
    expect(check).toMatchObject({ ok: false });
    expect(check.ok === false && check.objections[0]).toContain('recommendations');
    expect(checkReview({ summary: '' }, digest, [])).toMatchObject({ ok: false });
  });

  it('refuses two recommendations with the same rank', () => {
    const check = checkReview(review({ recommendations: [rec(1, 'finance', 'First thing.'), rec(1, 'owner', 'Another thing.')] }), digest, []);
    expect(check).toEqual({ ok: false, objections: ['recommendation ranks must be different: rank each one 1, 2 or 3, once'] });
  });

  it('refuses a recommendation that repeats an adopted lesson for the same assistant, whatever its case or punctuation', () => {
    const adopted = [{ assistant: 'finance' as const, text: 'give every stop-loss a LEVER' }];
    expect(checkReview(review(), digest, adopted)).toEqual({ ok: false, objections: ['recommendation 1 repeats a lesson the owner already adopted'] });
    expect(checkReview(review(), digest, [{ assistant: 'owner', text: 'give every stop-loss a lever' }]).ok).toBe(true); // another assistant's lesson
  });

  it('traces every text: summary, findings, change and why', () => {
    const check = checkReview(review({
      summary: 'Finance handled 6 tasks.', findings: [{ assistant: 'finance', text: 'It took 113 s.' }],
      recommendations: [rec(1, 'finance', 'Cut 40 percent.', 'It used 1501 tokens.')],
    }), digest, []);
    expect(check).toEqual({
      ok: false,
      objections: [
        'summary: "6" is not a number in the data',
        'finding 1: "113" is not a number in the data',
        'recommendation 1 change: "40" is not a number in the data',
        'recommendation 1 why: "1501" is not a number in the data',
      ],
    });
  });

  it('checks the small numbers 1, 2 and 3 in every text, a rank mentioned in prose included', () => {
    const check = checkReview(review({
      summary: 'Finance failed 3 times.',
      recommendations: [rec(1, 'finance', 'Fix the check.', 'This follows recommendation 2 and two earlier problems.')],
    }), digest, []);
    expect(check).toEqual({
      ok: false,
      objections: [
        'summary: "3" is not a number in the data',
        'recommendation 1 why: "2" is not a number in the data',
        'recommendation 1 why: "two" is not a number in the data',
      ],
    });
  });

  it('reads a review from before kinds as lessons, and a typed one with its kind and detail', () => {
    const old = checkReview(review(), digest, []);
    expect(old.ok && old.review.recommendations.map((r) => r.kind)).toEqual(['lesson', 'lesson']);
    const typed = checkReview(review({
      recommendations: [{ ...rec(1, 'finance', 'Let finance see usage.'), kind: 'reads', reads: { add: ['usage_summary'] } }, { ...rec(2, 'online', 'Quote the return.'), kind: 'skill_note' }],
    }), digest, []);
    expect(typed.ok && typed.review.recommendations).toMatchObject([{ kind: 'reads', reads: { add: ['usage_summary'], remove: [] } }, { kind: 'skill_note' }]);
    // The detail must fit the kind: a reads change with no tools, or a lesson that carries tools, goes back to the writer.
    const bad = checkReview(review({ recommendations: [{ ...rec(1, 'finance', 'Let finance see usage.'), kind: 'reads' }, { ...rec(2, 'owner', 'Ask which.'), reads: { add: ['usage_summary'] } }] }), digest, []);
    expect(bad).toEqual({ ok: false, objections: ['recommendations.0.reads: a reads change needs the tool names to add or remove', 'recommendations.1.reads: a lesson recommendation takes no reads'] });
  });

  it('asks the caller whether each change could be made, and names the recommendation that could not', () => {
    const wouldApply = (r: { rank: number; assistant: string }) => (r.assistant === 'owner' ? 'the owner assistant has no such tool' : null);
    expect(checkReview(review(), digest, [], wouldApply)).toEqual({ ok: false, objections: ['recommendation 2 cannot be made: the owner assistant has no such tool'] });
    expect(checkReview(review({ recommendations: [rec(1, 'finance', 'Give every stop-loss a lever.')] }), digest, [], wouldApply).ok).toBe(true);
  });

  it('keeps a phone number and anything medical or about hair loss out of the summary, the findings and the recommendations', () => {
    const check = checkReview(review({
      summary: 'Finance handled 5 tasks; text +1 555 010 0001 about it.',
      findings: [{ assistant: 'finance', text: 'Customers with hair loss asked twice.' }],
      recommendations: [rec(1, 'finance', 'Give every stop-loss a lever.', 'A diagnosis came up in 5 tasks.')],
    }), digest, []);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.objections).toEqual(expect.arrayContaining([
      'summary: it holds a phone number',
      'finding 1: it touches medical or hair-loss data, which is never stored',
      'recommendation 1 why: it touches medical or hair-loss data, which is never stored',
    ]));
  });

  it('does not take a six-digit token count for a code', () => {
    const big = { byAssistant: [{ assistant: 'finance', tasks: 5, inputTokens: 150000 }] };
    expect(checkReview(review({ summary: 'Finance used 150000 tokens in.', findings: [], recommendations: [] }), big, []).ok).toBe(true);
  });
});

describe('renderFacts', () => {
  it('writes the facts as key: value pairs, nested keys joined by dots and list items numbered', () => {
    expect(renderFacts({ tasks: 12, byAssistant: [{ assistant: 'finance', failed: 1 }], none: null, empty: [] })).toBe(
      "Here's what I found: tasks: 12; byAssistant.1.assistant: finance; byAssistant.1.failed: 1; none: none; empty: none",
    );
    expect(renderFacts(42)).toBe("Here's what I found: result: 42");
    expect(renderFacts(null)).toBe("Here's what I found: result: none");
  });

  it('keeps to 600 characters', () => {
    const long = renderFacts({ text: 'x'.repeat(2000) });
    expect(long.length).toBeLessThanOrEqual(600);
    expect(long.endsWith('…')).toBe(true);
  });
});
