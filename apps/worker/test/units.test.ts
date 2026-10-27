import { describe, expect, it } from 'vitest';
import type { AssistantMemory } from '@fahq/brain';
import { WorkReport, type Receipt } from '@fahq/contracts';
import { parseCommand } from '../src/commands.ts';
import { PlanError, planDigest, writePlans } from '../src/finance.ts';
import { checkReview, renderFacts } from '../src/manager.ts';
import { buildWorkReport, codeModeDetail, numberTrace, summarizeUsage, type UsageRow } from '../src/reports.ts';
import { dataMock, modelMock, validPlans } from './fixtures.ts';

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
