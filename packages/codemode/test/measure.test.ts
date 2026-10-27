import { describe, expect, it } from 'vitest';
import type { ModelPort, ReadTool } from '@fahq/contracts';
import { loadProfiles, pickTools, READ_TOOL_NAMES } from '@fahq/profiles';
import { buildQuestions, measure, renderReport, type Row } from '../../../scripts/measure-codemode.ts';
import { fakeTool } from './model.mock.ts';

// The measurement harness with a MOCK model and MOCK read tools: this checks the counting, the oracle
// and the report, not any real model. The live run happens after merge.

const owner = loadProfiles({}).owner;
const metricsData = {
  metrics: [
    { id: 'm:online.ads.google.spend', label: 'Google ad spend', value: 4100 },
    { id: 'm:online.ads.google.revenue', label: 'Google ad revenue', value: 14760 },
    { id: 'm:online.ads.google.roas', label: 'Google ad return', value: 3.6 },
    { id: 'm:online.ads.amazon.spend', label: 'Amazon ad spend', value: 2000 },
    { id: 'm:online.ads.amazon.revenue', label: 'Amazon ad revenue', value: 5000 },
    { id: 'm:online.ads.amazon.roas', label: 'Amazon ad return', value: 2.5 },
    { id: 'm:online.email.revenue', label: 'Email revenue', value: 9000 },
    { id: 'm:salon.revenue.total', label: 'Salon revenue', value: 12500 },
    { id: 'm:salon.revenue.wash_set', label: 'Salon Wash and set revenue', value: 6200 },
    { id: 'm:salon.revenue.color', label: 'Salon Color revenue', value: 4800 },
    { id: 'm:salon.no_shows.count', label: 'Salon no-shows', value: 7 },
  ],
};
const proposal = { title: 'Move budget to Google', cites: [{ id: 'm:online.ads.google.roas', value: 3.6 }] };
const decisions = { decisions: [{ id: 'd1', text: 'Declined a 20% discount on Mazali' }] };

function fakeTools(): ReadTool[] {
  const all = Object.fromEntries(READ_TOOL_NAMES.map((n) => [n, fakeTool(n, async () => ({}))]));
  all.get_finance_metrics = fakeTool('get_finance_metrics', async () => metricsData);
  all.latest_proposal = fakeTool('latest_proposal', async () => proposal);
  all.recall_decisions = fakeTool('recall_decisions', async () => decisions);
  return pickTools(all, owner);
}

const SCRIPTS: Record<string, string> = {
  google: 'async () => { const m = await codemode.get_finance_metrics({ period: "2026-09" }); return m.metrics.filter((x) => x.id.startsWith("m:online.")).map((x) => ({ id: x.id, value: x.value })); }',
  salon: 'async () => { const m = await codemode.get_finance_metrics({ period: "2026-09" }); return m.metrics.filter((x) => x.id.startsWith("m:salon.")).map((x) => ({ id: x.id, value: x.value })); }',
  proposal: 'async () => ({ p: await codemode.latest_proposal({}), d: await codemode.recall_decisions({ assistant: "finance", query: "ads plan" }) })',
};
const ANSWERS: Record<string, string> = {
  google: 'Google spent $4,100 and earned $14,760, a ROAS of 3.6x. Amazon spent $2,000 and earned $5,000, 2.5x. Email earned $9,000.',
  salon: 'Wash and set brought in the most, $6,200, and there were 7 no-shows.',
  proposal: 'The latest proposal cited a Google return of 3.6x. Yes, a 20% discount was declined before.',
};
const LOOP_INVENTION = 'Google spent $4,100 and earned $14,760 (3.6x). Amazon spent $2,000 and earned $5,000 (2.5x). Email earned $9,999.';

const which = (user: string) => (user.includes('Google and Amazon') ? 'google' : user.includes('salon service') ? 'salon' : 'proposal');

/** A MOCK model that behaves like a good one: a script for Code Mode, two tool calls then an answer for the loop. */
function scriptedModel() {
  const model: ModelPort = {
    async chat(input) {
      const text = input.system.includes('## Your read-only API')
        ? SCRIPTS[which(input.user)]!
        : input.system.includes('## Your read-only tools')
          ? loopTurn(input.user)
          : ANSWERS[which(input.user)]!;
      return { text, model: input.model, inputTokens: 100, outputTokens: 20, costUsd: 0 };
    },
  };
  return model;
}

function loopTurn(user: string): string {
  const reads = user.split('returned:').length - 1;
  if (reads === 0) return '{"call":{"tool":"get_finance_metrics","args":{"period":"2026-09"}}}';
  if (reads === 1) return '{"call":{"tool":"latest_proposal","args":{}}}';
  return JSON.stringify({ answer: which(user) === 'google' ? LOOP_INVENTION : ANSWERS[which(user)] });
}

describe('the measurement harness', () => {
  it('builds each question from the read tools called directly', async () => {
    const questions = await buildQuestions(fakeTools());
    expect(questions).toHaveLength(3);
    expect(questions.map((q) => q.oracleError)).toEqual([null, null, null]);
    expect((questions[0]!.facts as { id: string }[]).map((m) => m.id)).toHaveLength(7);
    expect(questions[0]!.keys).toHaveLength(7);
    expect((questions[1]!.facts as { id: string }[]).map((m) => m.id)).toEqual(['m:salon.revenue.wash_set', 'm:salon.revenue.color', 'm:salon.no_shows.count']);
    expect(questions[1]!.keys.map((k) => k.name)).toEqual(['top service: m:salon.revenue.wash_set', 'its revenue: 6200', 'no-shows: 7']);
    expect(questions[2]!.facts).toEqual({ latestProposal: proposal, decisions });
  });

  it('says plainly when the oracle cannot be read, and then does not claim a number check', async () => {
    const tools = fakeTools().map((t) => (t.name === 'get_finance_metrics' ? fakeTool(t.name, async () => { throw new Error('Zetaris is down'); }) : t));
    const questions = await buildQuestions(tools);
    expect(questions.map((q) => q.oracleError)).toEqual(['Zetaris is down', 'Zetaris is down', null]);
    expect(questions[0]!.facts).toBeNull();
    const rows = await measure({ model: scriptedModel(), modelId: 'test/model', skill: owner.skill, tools, questions, clock: () => 0 });
    expect(rows[0]).toMatchObject({ objections: null, keysFound: null });
    const report = renderReport({ date: '2099-01-01', modelId: 'test/model', skillName: 'fortune-hq-owner', toolNames: tools.map((t) => t.name), rows, questions });
    expect(report).toContain('The oracle could not be read, so numbers were not checked: Zetaris is down');
  });

  it('counts tokens, model calls, tool calls and time for each arm, and checks the numbers', async () => {
    const tools = fakeTools();
    const questions = await buildQuestions(tools);
    let now = 0;
    const clock = () => (now += 0.5);
    const rows = await measure({ model: scriptedModel(), modelId: 'test/model', skill: owner.skill, tools, questions, clock });

    expect(rows.map((r) => `${r.question.slice(0, 12)}|${r.arm}`)).toEqual([
      'How did Goog|Code Mode', 'How did Goog|Tool loop', 'Which salon |Code Mode', 'Which salon |Tool loop', 'What did the|Code Mode', 'What did the|Tool loop',
    ]);
    const [a1, b1, a2, b2, a3, b3] = rows as [Row, Row, Row, Row, Row, Row];
    // Code Mode: one script call and one answer call, whatever the data size.
    for (const a of [a1, a2, a3]) expect(a).toMatchObject({ ok: true, modelCalls: 2, inputTokens: 200, outputTokens: 40, seconds: 0.5 });
    expect([a1.toolCalls, a2.toolCalls, a3.toolCalls]).toEqual([1, 1, 2]);
    expect(a1.script).toBe(SCRIPTS.google);
    expect(a1.answer).toBe(ANSWERS.google);
    // Tool loop: two tool rounds then the answer round.
    for (const b of [b1, b2, b3]) expect(b).toMatchObject({ ok: true, modelCalls: 3, inputTokens: 300, outputTokens: 60, toolCalls: 2, script: null });

    // Numbers: Code Mode's reply traces; the loop's invented $9,999 does not.
    expect(a1.objections).toEqual([]);
    expect(a1.keysFound).toEqual({ found: 7, of: 7 });
    expect(b1.objections).toEqual(['"$9,999" is not in the facts']);
    expect(b1.keysFound).toEqual({ found: 6, of: 7 });
    expect(a2.keysFound).toEqual({ found: 3, of: 3 });
    expect(a3).toMatchObject({ objections: [], keysFound: null });
  });

  it('records a failed arm with its reason instead of throwing', async () => {
    const tools = fakeTools();
    const questions = await buildQuestions(tools);
    const broken: ModelPort = { chat: async () => { throw new Error('provider down'); } };
    const rows = await measure({ model: broken, modelId: 'test/model', skill: owner.skill, tools, questions, clock: () => 0 });
    expect(rows).toHaveLength(6);
    for (const r of rows) expect(r).toMatchObject({ ok: false, answer: null, objections: null, keysFound: null, modelCalls: 1, inputTokens: 0 });
    expect(rows[0]!.error).toBe('the model could not be reached');
    expect(rows[1]!.error).toBe('the model could not be reached');
  });

  it('renders a table with totals and the savings it measured, marked LIVE', async () => {
    const tools = fakeTools();
    const questions = await buildQuestions(tools);
    const rows = await measure({ model: scriptedModel(), modelId: 'test/model', skill: owner.skill, tools, questions, clock: () => 0 });
    const report = renderReport({ date: '2099-01-01', modelId: 'test/model', skillName: 'fortune-hq-owner', toolNames: tools.map((t) => t.name), rows, questions });

    expect(report).toContain('# Code Mode against tool calling: measured 2099-01-01 (LIVE)');
    expect(report).toContain('**LIVE run.**');
    expect(report).toContain('Nothing was sent to anyone and nothing was written except this report.');
    expect(report).toContain('| # | Arm | Answered | Model calls | Input tokens | Output tokens | Total tokens | Tool calls | Seconds | Numbers trace to the data | Key numbers stated |');
    expect(report).toContain('| Q1 | Code Mode | yes | 2 | 200 | 40 | 240 | 1 | 0.0 | yes | 7 of 7 |');
    expect(report).toContain('| Q1 | Tool loop | yes | 3 | 300 | 60 | 360 | 2 | 0.0 | no (1) | 6 of 7 |');
    expect(report).toContain('| Q3 | Code Mode | yes | 2 | 200 | 40 | 240 | 2 | 0.0 | yes | n/a |');
    expect(report).toContain('| **All** | **Code Mode** | 3 of 3 | 6 | 600 | 120 | 720 | 4 | 0.0 | | |');
    expect(report).toContain('| **All** | **Tool loop** | 3 of 3 | 9 | 900 | 180 | 1,080 | 6 | 0.0 | | |');
    expect(report).toContain('- Total tokens: 33.3% fewer');
    expect(report).toContain('- Model calls: 33.3% fewer');
    expect(report).toContain('Numbers not in the data: "$9,999" is not in the facts');
    expect(report).toContain(`\`\`\`js\n${SCRIPTS.google}\n\`\`\``);
    expect(report).not.toContain('not like for like');
  });

  it('says "more" when Code Mode costs more, and warns when an arm gave no answer', async () => {
    const tools = fakeTools();
    const questions = await buildQuestions(tools);
    const rows = await measure({ model: scriptedModel(), modelId: 'm', skill: owner.skill, tools, questions, clock: () => 0 });
    const swapped = rows.map((r) => ({ ...r, inputTokens: r.arm === 'Code Mode' ? 900 : 100, ok: r.arm === 'Code Mode' ? false : r.ok, error: r.arm === 'Code Mode' ? 'x' : r.error }));
    const report = renderReport({ date: '2099-01-01', modelId: 'm', skillName: 'fortune-hq-owner', toolNames: [], rows: swapped, questions });
    expect(report).toMatch(/- Input tokens: \d+\.\d% more/);
    expect(report).toContain('| Q1 | Code Mode | no |');
    expect(report).toContain('not like for like');
  });
});
