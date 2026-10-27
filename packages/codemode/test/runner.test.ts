import { describe, expect, it, vi } from 'vitest';
import type { ReadTool } from '@fahq/contracts';
import { ModelError } from '@fahq/models';
import { createCodeModeRunner, declarations, QuickJsExecutor } from '../src/index.ts';
import { extractScript } from '../src/runner.ts';
import { fakeTool, mockModel } from './model.mock.ts';

const SKILL = '# Owner HQ\n\n## Job\nYou are the owner chief of staff. You are read-only.';
const metrics = [
  { id: 'm:online.ads.google.spend', value: 4100, unit: 'usd', business: 'online' },
  { id: 'm:online.ads.google.revenue', value: 14760, unit: 'usd', business: 'online' },
  { id: 'm:salon.revenue.wash_set', value: 6200, unit: 'usd', business: 'salon' },
];

function setup(replies: readonly (string | Error)[], opts: { maxResultChars?: number } = {}) {
  const financeArgs: unknown[] = [];
  const forbidden = vi.fn(async () => ({ queued: true }));
  const finance = fakeTool('get_finance_metrics', async (args) => { financeArgs.push(args); return { metrics }; });
  const decisions = fakeTool('recall_my_decisions', async () => ({ decisions: [{ id: 'd1', text: 'Declined a twenty percent discount' }] }), '(args: { query: string }) => Promise<unknown>');
  const propose = fakeTool('propose_task', forbidden); // exists in the building, but is never handed to the script
  const { model, calls } = mockModel(replies);
  const run = createCodeModeRunner({ model, executor: new QuickJsExecutor({ timeoutMs: 5000, maxToolCalls: 5 }), ...opts });
  const ask = (tools: readonly ReadTool[] = [finance, decisions]) =>
    run({ purpose: 'owner.lookup', model: 'test/code-model', skill: SKILL, question: 'What did Google ads earn?', tools });
  return { ask, calls, financeArgs, forbidden, propose, finance, decisions };
}

const GOOD = `async () => {
  const r = await codemode.get_finance_metrics({ period: "2026-09" });
  const spend = r.metrics.find((m) => m.id === "m:online.ads.google.spend").value;
  const revenue = r.metrics.find((m) => m.id === "m:online.ads.google.revenue").value;
  return { spend, revenue, roas: Math.round((revenue / spend) * 100) / 100 };
}`;

describe('declarations', () => {
  it('lists every tool as a typed member with its description', () => {
    const a = fakeTool('get_finance_metrics', async () => ({}), '(args: { period: "2026-09" }) => Promise<{ metrics: Metric[] }>');
    const b = { ...fakeTool('open_items', async () => ({}), '() => Promise<unknown>'), description: 'Open items.\nEnds a comment */ early?' };
    expect(declarations([a, b])).toBe([
      'declare const codemode: {',
      '  /** Fake get_finance_metrics for tests. */',
      '  get_finance_metrics: (args: { period: "2026-09" }) => Promise<{ metrics: Metric[] }>;',
      '  /** Open items. Ends a comment * / early? */',
      '  open_items: () => Promise<unknown>;',
      '}',
    ].join('\n'));
  });
});

describe('extractScript', () => {
  const fn = 'async () => { return { a: 1 }; }';
  it.each([
    ['plain', fn],
    ['fenced', `Here you go:\n\`\`\`js\n${fn}\n\`\`\`\nDone.`],
    ['fenced without a language', `\`\`\`\n${fn}\n\`\`\``],
    ['an unclosed fence', `\`\`\`javascript\n${fn}`],
    ['a reasoning block first', `<think>I could use an async approach here</think>\n${fn}`],
    ['a trailing semicolon', `${fn};\n`],
    ['prose that says async first', `This is an async function.\n${fn}`],
  ])('finds the function in %s', (_name, reply) => {
    expect(extractScript(reply)).toBe(fn);
  });

  it('takes an async function expression too, and returns null when there is no function', () => {
    expect(extractScript('async function () { return 1; }')).toBe('async function () { return 1; }');
    expect(extractScript('I cannot do that.')).toBeNull();
    expect(extractScript('')).toBeNull();
  });
});

describe('createCodeModeRunner', () => {
  it('runs one script against the read API and returns only its small result', async () => {
    const t = setup([`\`\`\`js\n${GOOD}\n\`\`\``]);
    const r = await t.ask();
    expect(r).toMatchObject({ ok: true, result: { spend: 4100, revenue: 14760, roas: 3.6 }, error: null, attempts: 1, toolCalls: 1, inputTokens: 100, outputTokens: 20, model: 'test/code-model' });
    expect(r.script).toBe(GOOD);
    expect(r.resultChars).toBe(JSON.stringify(r.result).length);
    expect(t.financeArgs).toEqual([{ period: '2026-09' }]);

    // What the model was asked: the skill, then the typed API, then the rules; the question as JSON.
    expect(t.calls).toHaveLength(1);
    const call = t.calls[0]!;
    expect(call).toMatchObject({ purpose: 'owner.lookup', model: 'test/code-model', maxTokens: 1200, temperature: 0, json: false, thinking: false });
    expect(call.system.startsWith(`${SKILL}\n\n## Your read-only API\n\`\`\`ts\ndeclare const codemode: {`)).toBe(true);
    expect(call.system).toContain('get_finance_metrics: (args');
    expect(call.system).toContain('recall_my_decisions: (args');
    expect(call.system).not.toContain('propose_task');
    expect(call.system).toContain('## How to answer');
    expect(call.system).toContain('codemode.get_finance_metrics({ period: "2026-09" })');
    expect(call.system).toMatch(/no TypeScript annotations, no imports, no require, no fetch, no timers/);
    expect(call.system).toMatch(/at most 40 values/);
    expect(JSON.parse(call.user)).toEqual({ question: 'What did Google ads earn?' });
  });

  it('retries once with the sandbox error and sums tokens and tool calls over both attempts', async () => {
    const broken = 'async () => { const r = await codemode.get_finance_metrics({ period: "2026-09" }); return r.metrics.nothing.value; }';
    const t = setup([broken, GOOD]);
    const r = await t.ask();
    expect(r).toMatchObject({ ok: true, attempts: 2, toolCalls: 2, inputTokens: 200, outputTokens: 40 });
    expect(r.result).toEqual({ spend: 4100, revenue: 14760, roas: 3.6 });
    const second = JSON.parse(t.calls[1]!.user) as { question: string; previousScript: string; error: string };
    expect(second.question).toBe('What did Google ads earn?');
    expect(second.previousScript).toBe(broken);
    expect(second.error).toMatch(/nothing|undefined/);
  });

  it('fails plainly after the retry, with the last script and the last error', async () => {
    const t = setup(['async () => { throw new Error("first"); }', 'async () => { throw new Error("second"); }', GOOD]);
    const r = await t.ask();
    expect(r).toMatchObject({ ok: false, result: null, attempts: 2, script: 'async () => { throw new Error("second"); }' });
    expect(r.error).toBe('the script did not give a usable answer: second');
    expect(t.calls).toHaveLength(2); // never a third try
  });

  it('proves the script is read-only: a tool that is not in the list does not exist in the sandbox', async () => {
    const t = setup(['async () => codemode.propose_task({ text: "send it" })', 'async () => codemode.propose_task({ text: "send it" })']);
    const r = await t.ask([t.finance, t.decisions]); // t.propose is not handed over
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown tool codemode\.propose_task/);
    expect(t.forbidden).not.toHaveBeenCalled();
    expect(r.toolCalls).toBe(2); // the two refused calls, one per attempt

    // Handing it over is the only way to reach it.
    const allowed = setup(['async () => codemode.propose_task({ text: "x" })']);
    const r2 = await allowed.ask([allowed.propose]);
    expect(r2.ok).toBe(true);
    expect(allowed.forbidden).toHaveBeenCalledTimes(1);
  });

  it('gives the script no fetch, require, process or timers', async () => {
    for (const body of ['await fetch("https://example.com")', 'require("fs").readFileSync("/etc/passwd")', 'process.env.NEMOTRON_API_KEY', 'await new Promise((r) => setTimeout(r, 1))']) {
      const script = `async () => { return ${body}; }`;
      const t = setup([script, script]);
      const r = await t.ask();
      expect(r.ok, body).toBe(false);
      expect(r.error, body).toMatch(/not defined/i);
    }
  });

  it('retries when the result is too large, and says so', async () => {
    const big = 'async () => { const r = await codemode.get_finance_metrics({}); return { rows: Array.from({ length: 400 }, (_, i) => ({ id: "m:online.row" + i, value: i })) }; }';
    const t = setup([big, GOOD], { maxResultChars: 1000 });
    const r = await t.ask();
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
    const second = JSON.parse(t.calls[1]!.user) as { error: string };
    expect(second.error).toMatch(/^result too large: return fewer values/);

    const stuck = setup([big, big], { maxResultChars: 1000 });
    const r2 = await stuck.ask();
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/result too large/);
    expect(r2.resultChars).toBeGreaterThan(1000);
    expect(r2.result).toBeNull();
  });

  it('treats an empty or missing result as a failure to retry', async () => {
    for (const empty of ['async () => {}', 'async () => ({})', 'async () => null', 'async () => []']) {
      const t = setup([empty, GOOD]);
      const r = await t.ask();
      expect(r.ok, empty).toBe(true);
      expect(JSON.parse(t.calls[1]!.user).error, empty).toMatch(/returned nothing/);
    }
  });

  it('retries when the reply holds no function', async () => {
    const t = setup(['I think Google did well.', GOOD]);
    const r = await t.ask();
    expect(r.ok).toBe(true);
    const second = JSON.parse(t.calls[1]!.user) as { previousScript: string; error: string };
    expect(second.previousScript).toBe('I think Google did well.');
    expect(second.error).toMatch(/no JavaScript function/);
  });

  it('turns a model failure into a plain not-ok result and never throws', async () => {
    for (const code of ['budget', 'http', 'timeout', 'incomplete'] as const) {
      const message = `the provider said ${code}`;
      const t = setup([new ModelError(message, code)]);
      const r = await t.ask();
      expect(r).toMatchObject({ ok: false, error: message, attempts: 1, toolCalls: 0, script: null, result: null });
    }
    const odd = await setup([new TypeError('socket detail that should not be echoed')]).ask();
    expect(odd).toMatchObject({ ok: false, error: 'the model could not be reached' });

    // A failure on the retry keeps what the first attempt already cost.
    const late = await setup(['async () => { throw new Error("x"); }', new ModelError('daily token budget reached (1 of 1)', 'budget')]).ask();
    expect(late).toMatchObject({ ok: false, attempts: 2, inputTokens: 100, outputTokens: 20, error: 'daily token budget reached (1 of 1)' });
  });

  it('refuses tools it cannot expose safely, before any model call', async () => {
    const t = setup([GOOD]);
    const odd = fakeTool('get-finance metrics', async () => ({}));
    expect((await t.ask([odd])).error).toMatch(/not a valid function name/);
    expect((await t.ask([t.finance, t.finance])).error).toMatch(/listed twice/);
    expect(t.calls).toHaveLength(0);
  });

  it('reports a tool that fails as a script error the model can correct', async () => {
    const flaky = fakeTool('get_finance_metrics', async () => { throw new Error('period must be 2026-09'); });
    const t = setup(['async () => codemode.get_finance_metrics({ period: "2026-08" })', GOOD]);
    const r = await t.ask([flaky]);
    expect(r.ok).toBe(false); // the second script also hits the failing tool
    expect(JSON.parse(t.calls[1]!.user).error).toBe('period must be 2026-09');
  });
});
