import { describe, expect, it } from 'vitest';
import { ProfitPlans } from '@fahq/contracts';
import { candidateId, checkSynthesis, pickByRule, synthesize, SYNTHESIS_SYSTEM, type Candidate } from '../src/synthesis.ts';
import { mockMetrics, onlinePlans, salonPlans, scriptedModel, validPlans } from './fixtures.ts';

// Owner HQ's pick of the final three: what a program accepts from the model, and the rule that takes over.
// The model is a FAKE (scripted); the plans are the department fixtures, already valid.

const candidates: Candidate[] = (['finance', 'salon', 'online'] as const).flatMap((department) =>
  ProfitPlans.parse({ finance: validPlans, salon: salonPlans, online: onlinePlans }[department]).plans.map((plan) => ({
    id: candidateId(department, plan.rank), department, plan, proposalId: `p-${department}`,
  })));

const reply = (picks: [string, string][], note = '') => JSON.stringify({ picks: picks.map(([id, why]) => ({ id, why })), note });
const GOOD = reply([
  ['online:1', 'Ads already return 2.4x, so more spend has room.'],
  ['salon:1', 'Wash and set earned $6,200 and evenings are untouched.'],
  ['finance:1', 'It leans on $12,400 of Mazali revenue.'],
], 'Different bets that fit together.');

const objectionsOf = (raw: unknown) => {
  const check = checkSynthesis(raw, candidates, mockMetrics);
  return check.ok ? [] : check.objections;
};

describe('checkSynthesis', () => {
  it('accepts three different candidates whose words use only numbers from the plans picked', () => {
    const check = checkSynthesis(JSON.parse(GOOD), candidates, mockMetrics);
    expect(check).toMatchObject({ ok: true, note: 'Different bets that fit together.' });
    expect(check.ok && check.picks.map((p) => p.id)).toEqual(['online:1', 'salon:1', 'finance:1']);
  });

  it('refuses what the schema refuses: not three picks, an empty reason, a missing id', () => {
    expect(objectionsOf({ picks: [{ id: 'online:1', why: 'x' }], note: '' })[0]).toMatch(/^picks:/);
    expect(objectionsOf({ picks: [{ id: 'online:1', why: '' }, { id: 'salon:1', why: 'x' }, { id: 'finance:1', why: 'x' }] })[0]).toMatch(/^picks\.0\.why:/);
    expect(objectionsOf({ note: '' })[0]).toMatch(/^picks:/);
    expect(objectionsOf('three please')[0]).toMatch(/^answer:/);
  });

  it('refuses an id that is not a candidate, and the same candidate twice', () => {
    const base = (ids: string[]) => ({ picks: ids.map((id) => ({ id, why: 'Fine.' })), note: '' });
    expect(objectionsOf(base(['online:1', 'salon:1', 'online:9']))).toEqual(['"online:9" is not one of the candidate ids']);
    expect(objectionsOf(base(['online:1', 'salon:1', 'online:1']))).toEqual(['the three picks must be three different candidates']);
    expect(objectionsOf(base(['salon:1', 'salon:2', 'salon:3']))).toEqual([]); // a department may have all three
  });

  it('refuses a number in a reason that the plan it is about does not have, naming the pick', () => {
    const wrong = reply([['online:1', 'This could add 99% to profit.'], ['salon:1', 'Fine.'], ['finance:1', 'Fine.']]);
    expect(objectionsOf(JSON.parse(wrong))).toEqual(['pick 1 why: "99%" is not a number in the data']);
    // A number from ANOTHER pick's plan is not this plan's number either.
    const borrowed = reply([['online:1', 'Wash and set earned $6,200.'], ['salon:1', 'Fine.'], ['finance:1', 'Fine.']]);
    expect(objectionsOf(JSON.parse(borrowed))).toEqual(['pick 1 why: "6,200" is not a number in the data']);
  });

  it('checks the note against all three plans picked, and a number written in words is refused', () => {
    const picks: [string, string][] = [['online:1', 'Fine.'], ['salon:1', 'Fine.'], ['finance:1', 'Fine.']];
    expect(objectionsOf(JSON.parse(reply(picks, 'Evenings earned $6,200. Ads return 2.4x.')))).toEqual([]);
    expect(objectionsOf(JSON.parse(reply(picks, 'They could add 77% to profit.')))).toEqual(['note: "77%" is not a number in the data']);
    expect(objectionsOf(JSON.parse(reply([['online:1', 'It returns twenty percent more.'], ['salon:1', 'Fine.'], ['finance:1', 'Fine.']])))[0]).toContain('write "twenty" in digits');
  });

  it('does not count a candidate id written in the text as a number', () => {
    const picks: [string, string][] = [['online:1', 'Plan online:1 leads because ads return 2.4x.'], ['salon:1', 'Fine.'], ['finance:1', 'Fine.']];
    expect(objectionsOf(JSON.parse(reply(picks)))).toEqual([]);
  });

  it('refuses one sentence that puts a salon number next to an online number', () => {
    // 6,200 is the salon plan's alone and 1,800 the online plan's alone; the note may use both, in separate sentences.
    const separate = reply([['online:3', 'Fine.'], ['salon:1', 'Fine.'], ['finance:2', 'Fine.']], 'Online spends $1,800. The salon earned $6,200.');
    expect(objectionsOf(JSON.parse(separate))).toEqual([]);
    const mixed = reply([['online:3', 'Fine.'], ['salon:1', 'Fine.'], ['finance:2', 'Fine.']], 'Online spends $1,800 while the salon earned $6,200.');
    expect(objectionsOf(JSON.parse(mixed))).toEqual(['note: one sentence mixes a salon number and an online number ($1,800, $6,200)']);
  });

  describe('the salon and online rule judges each number by the metric it traces to, not by how many businesses the plan touches', () => {
    // finance:3 cites BOTH businesses: Mazali revenue $12,400 (online) and wash and set revenue $6,200 (salon).
    const BOTH = 'Mazali brought in $12,400 while the wash and set earned $6,200.';
    const MIXED = 'one sentence mixes a salon number and an online number ($12,400, $6,200)';

    it("refuses a reason that quotes a salon number and an online number from a plan that cites both businesses", () => {
      const picks = reply([['finance:3', BOTH], ['online:1', 'Fine.'], ['salon:1', 'Fine.']]);
      expect(objectionsOf(JSON.parse(picks))).toEqual([`pick 1 why: ${MIXED}`]);
    });

    it('refuses the same sentence in the note', () => {
      const picks = reply([['online:1', 'Fine.'], ['salon:1', 'Fine.'], ['finance:3', 'Fine.']], BOTH);
      expect(objectionsOf(JSON.parse(picks))).toEqual([`note: ${MIXED}`]);
    });

    it('lets that plan quote each side in its own sentence, and one side with itself in one sentence', () => {
      const why = 'Mazali brought in $12,400, which becomes $13,020 with the lift. The wash and set earned $6,200.';
      expect(objectionsOf(JSON.parse(reply([['finance:3', why], ['online:1', 'Fine.'], ['salon:1', 'Fine.']])))).toEqual([]);
    });

    it("is not hidden by a plan that cites both businesses among the picks: a number another pick also has keeps its side", () => {
      // $6,200 is in the salon plan AND in finance:3; 2.4x is the online plan's. Together in one sentence they still mix.
      const picks = reply([['online:1', 'Fine.'], ['salon:1', 'Fine.'], ['finance:3', 'Fine.']], 'Ads return 2.4x while the salon earned $6,200.');
      expect(objectionsOf(JSON.parse(picks))).toEqual(['note: one sentence mixes a salon number and an online number (2.4x, $6,200)']);
    });
  });
});

describe('pickByRule', () => {
  it("takes each department's rank 1 plan in the order finance, online, salon", () => {
    expect(pickByRule(candidates).map((p) => p.id)).toEqual(['finance:1', 'online:1', 'salon:1']);
    expect(pickByRule(candidates)[0]!.why).toBe("The Finance department's own top plan.");
  });

  it('then the rank 2 plans when fewer than three departments answered', () => {
    const two = candidates.filter((c) => c.department !== 'salon');
    expect(pickByRule(two).map((p) => p.id)).toEqual(['finance:1', 'online:1', 'finance:2']);
    expect(pickByRule(two)[2]!.why).toBe("The Finance department's own second plan.");
    expect(pickByRule(candidates.filter((c) => c.department === 'salon')).map((p) => p.id)).toEqual(['salon:1', 'salon:2', 'salon:3']);
  });
});

describe('synthesize', () => {
  const run = (model: ReturnType<typeof scriptedModel>) =>
    synthesize({ model: model.port, planModel: 'nvidia/ultra', request: 'Plans please', candidates, metrics: mockMetrics, lessons: ['Prefer cheap tests.'] });

  it('asks once with the candidates and the lessons, and returns the checked picks', async () => {
    const model = scriptedModel({ 'owner.synthesis': GOOD });
    const result = await run(model);
    expect(result).toMatchObject({ ok: true, attempts: 1, inputTokens: 100, outputTokens: 200, firstObjection: null });
    const sent = model.calls[0]!;
    expect(sent).toMatchObject({ purpose: 'owner.synthesis', model: 'nvidia/ultra', system: SYNTHESIS_SYSTEM, json: true, thinking: true, maxTokens: 6000 });
    const user = JSON.parse(sent.user);
    expect(user.request).toBe('Plans please');
    expect(user.ownerLessons).toEqual(['Prefer cheap tests.']);
    expect(user.candidates).toHaveLength(9);
    expect(user.candidates[0]).toEqual({
      id: 'finance:1', title: 'Push Google ads on Mazali', summary: expect.any(String), businesses: ['online'], risks: ['Ad costs rise'],
      projections: [{ label: 'Google spend after the raise', factor: 1.2, result: 2160, assumption: 'Budget raised 20%' }],
      levers: [], test: 'Run 14 days on Mazali only.', stopLoss: 'Stop if spend passes $2,160 without new orders.',
    });
    expect(sent.user).not.toContain('baseMetricId'); // the picker reads plans, not metric wiring
  });

  it('gives the model one correction round with the exact objections', async () => {
    const bad = reply([['online:1', 'This could add 99% to profit.'], ['salon:1', 'Fine.'], ['finance:1', 'Fine.']]);
    const model = scriptedModel();
    model.script('owner.synthesis', bad, GOOD);
    const result = await run(model);
    expect(result).toMatchObject({ ok: true, attempts: 2, inputTokens: 200, outputTokens: 400, firstObjection: 'pick 1 why: "99%" is not a number in the data' });
    expect(JSON.parse(model.calls[1]!.user).previousAttemptRejectedBecause).toEqual(['pick 1 why: "99%" is not a number in the data']);
  });

  it('fails after the correction round when the picks still do not check out', async () => {
    const bad = reply([['online:1', 'This could add 99% to profit.'], ['salon:1', 'Fine.'], ['finance:1', 'Fine.']]);
    const result = await run(scriptedModel({ 'owner.synthesis': bad }));
    expect(result).toMatchObject({ ok: false, why: 'check', attempts: 2, inputTokens: 200, outputTokens: 400 });
    expect(result.ok === false && result.reason).toContain('"99%"');
  });

  it('treats text that is not JSON as an objection, and a model that throws as a model failure, without asking again', async () => {
    const notJson = scriptedModel();
    notJson.script('owner.synthesis', 'I would pick ads', GOOD);
    expect(await run(notJson)).toMatchObject({ ok: true, attempts: 2 });
    const thrown = scriptedModel({ 'owner.synthesis': new Error('daily token budget reached (1 of 2)') });
    expect(await run(thrown)).toMatchObject({ ok: false, why: 'model', reason: 'daily token budget reached (1 of 2)', attempts: 1 });
    expect(thrown.calls).toHaveLength(1);
  });
});
