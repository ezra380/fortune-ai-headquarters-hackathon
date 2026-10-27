import { describe, expect, it } from 'vitest';
import { ProfitPlans, type Division, type Metric, type MetricInfo, type Receipt } from '@fahq/contracts';
import { createZetarisDataPort } from '@fahq/data';
import { countNouns, departmentLine, departmentsFor, isDepartment, originsOf, sliceFor } from '../src/departments.ts';
import { planDigest } from '../src/finance.ts';
import { buildWorkReport, codeModeDetail } from '../src/reports.ts';
import { finalSms } from '../src/rounds.ts';
import { mockMetrics, onlinePlans, salonPlans, validPlans } from './fixtures.ts';

// Plain functions of the departments' round: who is asked, what each may read, how the owner's text is
// built, and how a round's steps read in the manager's reports. No database, no models.

describe('who is asked, and what each may read', () => {
  it('asks all three for Owner HQ or the manager, and only the one named otherwise', () => {
    expect(departmentsFor('owner')).toEqual(['finance', 'salon', 'online']);
    expect(departmentsFor('manager')).toEqual(['finance', 'salon', 'online']);
    for (const department of ['finance', 'salon', 'online'] as const) expect(departmentsFor(department)).toEqual([department]);
    expect(isDepartment('manager')).toBe(false);
  });

  it('gives finance every metric and the salon and online only their own business', () => {
    const combined: Metric = { ...mockMetrics[0]!, id: 'm:combined.revenue.total', business: 'combined' };
    const all = [...mockMetrics, combined];
    expect(sliceFor('finance', all)).toEqual(all);
    expect(sliceFor('salon', all).map((m) => m.id)).toEqual(['m:salon.revenue.wash_set', 'm:salon.appointments.count']);
    expect(sliceFor('online', all).map((m) => m.id)).toEqual(['m:online.revenue.mazali', 'm:online.ads.google.spend', 'm:online.ads.google.roas']);
    expect(sliceFor('salon', [])).toEqual([]);
  });

  it("gives each department its division's metrics when the data names divisions, and none kept out of plan writing", () => {
    const combined: Metric = { ...mockMetrics[0]!, id: 'm:combined.dq.rejected_invoices', business: 'combined' };
    const all = [...mockMetrics, combined];
    const catalog: MetricInfo[] = all.map(({ id, label, unit, business }) => ({ id, label, unit, business, divisions: [] }));
    const reads = (id: string, divisions: Division[], more: Partial<MetricInfo> = {}) => Object.assign(catalog.find((c) => c.id === id)!, { divisions, ...more });
    reads('m:online.revenue.mazali', ['online', 'finance']);
    reads('m:online.ads.google.spend', ['online', 'finance']);
    reads('m:online.ads.google.roas', ['online']); // online's own: finance does not get it
    reads('m:salon.revenue.wash_set', ['salon', 'finance']);
    reads('m:salon.appointments.count', ['salon', 'finance'], { planUse: false });
    reads('m:combined.dq.rejected_invoices', ['finance', 'hq']);
    expect(sliceFor('finance', all, catalog).map((m) => m.id)).toEqual(['m:online.revenue.mazali', 'm:online.ads.google.spend', 'm:salon.revenue.wash_set', 'm:combined.dq.rejected_invoices']);
    expect(sliceFor('online', all, catalog).map((m) => m.id)).toEqual(['m:online.revenue.mazali', 'm:online.ads.google.spend', 'm:online.ads.google.roas']);
    expect(sliceFor('salon', all, catalog).map((m) => m.id)).toEqual(['m:salon.revenue.wash_set']);
    // A metric the catalog does not know is not planned from.
    expect(sliceFor('finance', all, catalog.slice(1)).map((m) => m.id)).not.toContain('m:online.revenue.mazali');
    // Without divisions in the catalog, planUse still holds and the business rule decides.
    const plain = catalog.map(({ divisions: _d, ...rest }) => rest);
    expect(sliceFor('salon', all, plain).map((m) => m.id)).toEqual(['m:salon.revenue.wash_set']);
  });

  // Review 2026-10-27: the live default (data version 1) plans by division too, since its catalog names divisions.
  it("slices the real version 1 catalog: Finance plans from 28 of its 33 metrics, Salon from 11, Online from 22", () => {
    const port = createZetarisDataPort({}, { client: { run: async () => [] }, ensureSources: async () => undefined });
    const metrics = port.catalog!.map((m): Metric => ({ ...mockMetrics[0]!, id: m.id as Metric['id'], label: m.label, unit: m.unit, business: m.business }));
    expect(metrics).toHaveLength(33);
    const ids = (d: 'finance' | 'salon' | 'online') => sliceFor(d, metrics, port.catalog).map((m) => m.id);
    expect([ids('finance').length, ids('salon').length, ids('online').length]).toEqual([28, 11, 22]);
    expect(metrics.map((m) => m.id).filter((id) => !ids('finance').includes(id)).sort()).toEqual([
      'm:online.dq.rejected_orders', 'm:online.email.click_rate', 'm:online.email.sends', 'm:salon.dq.rejected_appointments', 'm:salon.no_shows.count',
    ]);
  });

  it('takes the count words of count metrics only from the catalog', () => {
    expect(countNouns([
      { id: 'm:salon.no_shows.count', label: 'x', unit: 'count', business: 'salon', nouns: ['no-show', 'no-shows'] },
      { id: 'm:salon.revenue.total', label: 'x', unit: 'usd', business: 'salon', nouns: ['dollar'] },
      { id: 'm:salon.appointments.count', label: 'x', unit: 'count', business: 'salon' },
    ])).toEqual(new Map([['m:salon.no_shows.count', ['no-show', 'no-shows']]]));
    expect(countNouns()).toEqual(new Map());
  });

  it('names the department and its data in one line', () => {
    expect(departmentLine('salon')).toBe('You are writing as the Salon department. Your data is only the salon metrics provided (the online business is not yours to plan for).');
    expect(departmentLine('online')).toBe('You are writing as the Online department. Your data is only the online metrics provided (the salon business is not yours to plan for).');
    expect(departmentLine('finance')).toBe('You are writing as the Finance department. Your data is the money metrics of both businesses provided, side by side (salon, online and combined).');
  });

  it('reads the origins a final proposal stores, and ignores anything malformed', () => {
    const good = { rank: 1, department: 'online', originalRank: 2, proposalId: 'p1' };
    expect(originsOf({ origins: [good, { rank: 2, department: 'marketing', originalRank: 1, proposalId: 'p2' }, { rank: 'x' }, null, 'online'] })).toEqual([good]);
    expect(originsOf({})).toEqual([]);
    expect(originsOf({ origins: 'online' })).toEqual([]);
  });
});

describe('the owner\'s text', () => {
  const picked = ProfitPlans.parse({
    plans: [onlinePlans.plans[0], salonPlans.plans[0], validPlans.plans[0]].map((p, i) => ({ ...p, rank: i + 1 })),
    memoryConflicts: [],
  });
  const origins = [
    { rank: 1, department: 'online', originalRank: 1, proposalId: 'po' },
    { rank: 2, department: 'salon', originalRank: 1, proposalId: 'ps' },
    { rank: 3, department: 'finance', originalRank: 1, proposalId: 'pf' },
  ];
  const body = (over: Record<string, unknown> = {}) => ({
    plans: picked, metrics: mockMetrics, origins, view: 'fortune_demo_finance_mart', pickedBy: 'model', departments: ['finance', 'salon', 'online'], failedDepartments: [],
    why: [{ rank: 1, text: 'Ads return well.' }, { rank: 2, text: 'Evenings are free.' }, { rank: 3, text: 'It rests on real revenue.' }], ...over,
  });
  const tail = 'Reply SEND <1-3> 123456 to send one to Dana. The code expires in 15 minutes.';

  it('lists the three plans with their departments and a reason each, then the SEND tail', () => {
    expect(finalSms(body(), 'Dana', '123456')).toBe([
      "Your departments' best 3 plans (every number checked against fortune_demo_finance_mart):",
      '1. [Online] Raise Google ad spend 20% (Google spend after the raise: $2,160)',
      'Why: Ads return well.',
      '2. [Salon] Open evening wash and set slots (Wash and set revenue with evenings: $7,130)',
      'Why: Evenings are free.',
      '3. [Finance] Push Google ads on Mazali (Google spend after the raise: $2,160)',
      'Why: It rests on real revenue.',
      tail,
    ].join('\n'));
  });

  it('says "picked by rule" only when several departments answered and a rule chose', () => {
    expect(finalSms(body({ pickedBy: 'rule' }), 'Dana', '123456')).toContain("best 3 plans (picked by rule; every number checked against");
    expect(finalSms(body({ pickedBy: 'rule', departments: ['online'] }), 'Dana', '123456')).not.toContain('picked by rule');
    expect(finalSms(body({ pickedBy: 'model' }), 'Dana', '123456')).not.toContain('picked by rule');
  });

  it('names the departments that could not produce checked plans, and any plan that resembles a declined idea', () => {
    const sms = finalSms(body({ failedDepartments: ['salon', 'online'], declinedEchoes: [{ rank: 2, memoryId: 'm1' }, { rank: 2, memoryId: 'm2' }] }), 'Dana', '123456');
    expect(sms).toContain("Salon and Online couldn't produce checked plans.");
    expect(sms).toContain('Note: plan 2 resembles an idea that was declined before.');
    expect(sms.endsWith(tail)).toBe(true);
  });

  it('keeps the reasons while the text fits, and drops them, not the tail or the failed-department line, when it would be too long', () => {
    const reasons = (text: string) => [1, 2, 3].map((rank) => ({ rank, text }));
    const fits = finalSms(body({ why: reasons('x'.repeat(300)), failedDepartments: ['online'] }), 'Dana', '123456');
    expect(fits).toContain(`Why: ${'x'.repeat(300)}`);
    expect(fits.length).toBeLessThanOrEqual(1600);
    const tooLong = finalSms(body({ why: reasons('y'.repeat(700)), failedDepartments: ['online'] }), 'Dana', '123456');
    expect(tooLong.length).toBeLessThanOrEqual(1600);
    expect(tooLong).not.toContain('Why:');
    expect(tooLong).toContain("Online couldn't produce checked plans.");
    expect(tooLong.endsWith(tail)).toBe(true);
  });

  it('shows the department on each line of the digest when origins exist, and nothing extra when they do not', () => {
    expect(planDigest(picked, mockMetrics, originsOf({ origins })).split('\n')).toEqual([
      '1. [Online] Raise Google ad spend 20% (Google spend after the raise: $2,160)',
      '2. [Salon] Open evening wash and set slots (Wash and set revenue with evenings: $7,130)',
      '3. [Finance] Push Google ads on Mazali (Google spend after the raise: $2,160)',
    ]);
    expect(planDigest(picked, mockMetrics)).not.toContain('[');
  });
});

describe("a round in the manager's reports", () => {
  const RUN = '00000000-0000-4000-8000-0000000000a1';
  const TASK = '00000000-0000-4000-8000-0000000000b1';
  const t0 = new Date('2026-10-26T12:00:00.000Z');
  const at = (s: number) => new Date(t0.getTime() + s * 1000).toISOString();
  const rc = (step: string, over: Partial<Receipt> = {}): Receipt => ({
    runId: RUN, taskId: TASK, step, assistantId: 'owner', live: false, model: 'MOCK/m', dataSource: null,
    startedAt: at(0), endedAt: at(2), costUsd: null, outcome: 'ok', detail: null, inputTokens: 10, outputTokens: 20, ...over,
  });
  const report = (receipts: Receipt[], over: { outcome?: 'done' | 'failed'; error?: string | null; assistant?: 'owner' } = {}) =>
    buildWorkReport({ task: { id: TASK, assistant_id: 'owner', kind: over.assistant ? 'inbound_text' : 'mailbox' }, outcome: over.outcome ?? 'done', error: over.error ?? null, receipts, startedAt: t0, endedAt: new Date(t0.getTime() + 5000) });

  it('reads the attempts of any department\'s plan step, and blames the department that needed a second round', () => {
    const r = report([
      rc('finance.plans', { assistantId: 'finance', detail: 'attempts 1, tokens 300, cited 5 metrics' }),
      rc('online.plans', { assistantId: 'online', detail: 'attempts 2, tokens 900, cited 3 metrics; first objection: plan 1 summary: "20%" is not one of its numbers' }),
      rc('owner.synthesis', { detail: 'attempts 2, 9 candidates; first objection: pick 1 why: "99%" is not a number in the data' }),
    ]);
    expect(r.summary).toBe('mailbox task done in 5 s; finance.plans ok (attempt 1 of 2), online.plans ok (attempt 2 of 2), owner.synthesis ok (attempt 2 of 2)');
    expect(r.suggestions).toEqual([
      { kind: 'prompt', about: 'online', text: 'The plan writer needed a correction round. First objection: plan 1 summary: "20%" is not one of its numbers' },
      { kind: 'prompt', about: 'owner', text: 'The plan picker needed a correction round. First objection: pick 1 why: "99%" is not a number in the data' },
    ]);
    expect(r.usage).toMatchObject({ modelCalls: 3, inputTokens: 30, outputTokens: 60 });
  });

  it('files a refused safety screen without a suggestion, and one that could not run as a reliability problem', () => {
    const unsafe = report([rc('front-door.screen', { outcome: 'refused', detail: 'unsafe: Fraud/Deception' })], { outcome: 'failed', error: 'the safety check refused this text', assistant: 'owner' });
    expect(unsafe.suggestions).toEqual([]);
    expect(unsafe.outcome).toBe('failed');
    const down = report([rc('front-door.screen', { outcome: 'failed', model: 'MOCK/m', detail: 'the safety check could not run' })], { outcome: 'failed', error: 'the safety check could not run', assistant: 'owner' });
    expect(down.suggestions).toEqual([{ kind: 'reliability', about: 'owner', text: 'front-door.screen failed: the safety check could not run' }]);
  });

  it('writes the untraced count on a Code Mode receipt and still reads the rest of it back', () => {
    const detail = codeModeDetail({ attempts: 2, toolCalls: 4, resultChars: 120, untraced: 3 });
    expect(detail).toBe('code mode: attempts 2, toolCalls 4, resultChars 120, untraced 3');
    expect(codeModeDetail({ attempts: 1, toolCalls: 1, resultChars: 5 })).toBe('code mode: attempts 1, toolCalls 1, resultChars 5');
    expect(codeModeDetail({ attempts: 1, toolCalls: 1, resultChars: 5, untraced: 0, error: 'boom' })).toBe('code mode: attempts 1, toolCalls 1, resultChars 5, untraced 0; error: boom');
    const r = report([rc('owner.lookup', { detail })]);
    expect(r.usage.codeMode).toEqual({ scripts: 1, toolCalls: 4, resultChars: 120 });
    expect(r.suggestions).toEqual([{ kind: 'prompt', about: 'owner', text: 'owner.lookup: the script needed 2 attempts. Sandbox error: not recorded' }]);
  });
});
