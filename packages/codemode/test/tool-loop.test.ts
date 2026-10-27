import { describe, expect, it } from 'vitest';
import { ModelError } from '@fahq/models';
import { toolLoopAnswer } from '../src/tool-loop.ts';
import { fakeTool, mockModel } from './model.mock.ts';

const SKILL = '# Owner HQ\nYou are read-only.';
const metrics = { metrics: [{ id: 'm:online.ads.google.spend', value: 4100 }, { id: 'm:online.ads.google.revenue', value: 14760 }] };
const decisions = { decisions: [{ id: 'd1', text: 'Declined a twenty percent discount' }] };

function setup(replies: readonly (string | Error)[], maxRounds?: number) {
  const finance = fakeTool('get_finance_metrics', async () => metrics);
  const recall = fakeTool('recall_my_decisions', async () => decisions, '(args: { query: string }) => Promise<unknown>');
  const { model, calls } = mockModel(replies);
  const ask = () => toolLoopAnswer({ model, modelId: 'test/model', skill: SKILL, question: 'What did Google earn?', tools: [finance, recall], ...(maxRounds ? { maxRounds } : {}) });
  return { ask, calls };
}

const call = (tool: string, args: unknown = {}) => JSON.stringify({ call: { tool, args } });

describe('toolLoopAnswer', () => {
  it('re-sends the whole transcript, with every full tool result, each round', async () => {
    const t = setup([call('get_finance_metrics', { period: '2026-09' }), call('recall_my_decisions', { query: 'google' }), '{"answer":"Google earned $14,760 on $4,100 of spend."}']);
    const r = await t.ask();
    expect(r).toMatchObject({ ok: true, answer: 'Google earned $14,760 on $4,100 of spend.', rounds: 3, inputTokens: 300, outputTokens: 60, error: null });

    expect(t.calls).toHaveLength(3);
    for (const c of t.calls) expect(c).toMatchObject({ purpose: 'toolloop', model: 'test/model', temperature: 0, json: false, thinking: false });
    expect(t.calls[0]!.user).toBe('Question: What did Google earn?\n\nTool calls so far:\nNo tool calls yet.');
    // Round 2 carries the first result in full; round 3 carries both.
    expect(t.calls[1]!.user).toContain(`1. get_finance_metrics({"period":"2026-09"}) returned: ${JSON.stringify(metrics)}`);
    expect(t.calls[2]!.user).toContain(`1. get_finance_metrics({"period":"2026-09"}) returned: ${JSON.stringify(metrics)}`);
    expect(t.calls[2]!.user).toContain(`2. recall_my_decisions({"query":"google"}) returned: ${JSON.stringify(decisions)}`);
    expect(t.calls[1]!.user.length).toBeGreaterThan(t.calls[0]!.user.length);
    expect(t.calls[2]!.user.length).toBeGreaterThan(t.calls[1]!.user.length);
    expect(r.transcriptChars).toBe(t.calls[2]!.user.length);
  });

  it('lists each tool with its description and signature, and the answer rules', async () => {
    const t = setup(['{"answer":"Done."}']);
    await t.ask();
    const system = t.calls[0]!.system;
    expect(system.startsWith(SKILL)).toBe(true);
    expect(system).toContain('- get_finance_metrics: Fake get_finance_metrics for tests.\n  (args: { period: "2026-09" }) => Promise<unknown>');
    expect(system).toContain('- recall_my_decisions: Fake recall_my_decisions for tests.');
    expect(system).toContain('{"call":{"tool":"<name>","args":{...}}}');
    expect(system).toContain('{"answer":"<text>"}');
    expect(system).toMatch(/at most 3 short sentences/);
  });

  it('accepts a fenced JSON reply', async () => {
    const t = setup(['```json\n{"answer":"Yes."}\n```']);
    expect(await t.ask()).toMatchObject({ ok: true, answer: 'Yes.', rounds: 1 });
  });

  it('tells the model when a tool is unknown, fails, or its own reply was not usable, and keeps going', async () => {
    const t = setup([
      call('propose_task', { text: 'send it' }),
      'I will look at the numbers now.',
      call('get_finance_metrics', undefined),
      '{"answer":"Spend was $4,100."}',
    ]);
    const r = await t.ask();
    expect(r).toMatchObject({ ok: true, rounds: 4 });
    expect(t.calls[1]!.user).toContain('1. propose_task({"text":"send it"}) is not one of your tools.');
    expect(t.calls[2]!.user).toContain('Your last reply was not one JSON object with "call" or "answer"');
    expect(t.calls[3]!.user).toContain('2. get_finance_metrics({}) returned:');
  });

  it('reports a tool that throws as a plain failure line', async () => {
    const broken = fakeTool('get_finance_metrics', async () => { throw new Error('period must be 2026-09'); });
    const { model, calls } = mockModel([call('get_finance_metrics', { period: '2026-08' }), '{"answer":"I could not read the metrics."}']);
    const r = await toolLoopAnswer({ model, modelId: 'm', skill: SKILL, question: 'q', tools: [broken] });
    expect(r.ok).toBe(true);
    expect(calls[1]!.user).toContain('1. get_finance_metrics({"period":"2026-08"}) failed: period must be 2026-09');
  });

  it('stops after the round limit with a plain reason', async () => {
    const t = setup([call('get_finance_metrics'), call('get_finance_metrics'), call('get_finance_metrics')], 2);
    const r = await t.ask();
    expect(r).toMatchObject({ ok: false, answer: null, rounds: 2, error: 'no answer after 2 rounds', inputTokens: 200 });
    expect(t.calls).toHaveLength(2);
  });

  it('asks for the answer on the last round, and only then', async () => {
    const t = setup([call('get_finance_metrics'), call('get_finance_metrics'), '{"answer":"Google earned $14,760."}'], 3);
    const r = await t.ask();
    expect(r.ok).toBe(true);
    expect(t.calls[0]!.user).not.toContain('last turn');
    expect(t.calls[1]!.user).not.toContain('last turn');
    expect(t.calls[2]!.user).toContain('This is your last turn');
  });

  it('defaults to six rounds', async () => {
    const t = setup(Array.from({ length: 8 }, () => call('get_finance_metrics')));
    const r = await t.ask();
    expect(r).toMatchObject({ ok: false, rounds: 6 });
  });

  it('turns a model failure into a plain not-ok result and keeps the tokens already spent', async () => {
    const t = setup([call('get_finance_metrics'), new ModelError('daily token budget reached (1 of 1)', 'budget')]);
    const r = await t.ask();
    expect(r).toMatchObject({ ok: false, answer: null, rounds: 2, inputTokens: 100, error: 'daily token budget reached (1 of 1)' });
    expect((await setup([new TypeError('socket detail')]).ask()).error).toBe('the model could not be reached');
  });
});
