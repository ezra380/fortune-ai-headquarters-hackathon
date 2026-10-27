import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openBrain } from '@fahq/brain';
import type { Explained } from '../src/explain.ts';
import { handleTask, type WorkerDeps } from '../src/flows.ts';
import { PLAN_SYSTEM } from '../src/finance.ts';
import { createReadTools } from '../src/read-tools.ts';
import { runUntilIdle } from '../src/runner.ts';
import { createStore, type TaskRow } from '../src/store.ts';
import { SYNTHESIS_SYSTEM } from '../src/synthesis.ts';
import { dataMock, mockMetrics, onlinePlans, routerReply, SAFE, salonPlans, scriptedModel, validPlans } from './fixtures.ts';
import { dbUrl, haveMeterless, localApi, meterlessDir } from './localdb.ts';

// The whole chain on the real local database and the real Meterless engines: the owner asks for plans,
// every department proposes from its own data, Owner HQ picks three, the owner sends one on, the finance
// owner decides. Only NVIDIA (scripted per purpose) and the Zetaris adapter (fixtures.ts) are MOCKED; SMS
// is a dry run.

const api = haveMeterless ? localApi() : null;
if (!api) console.warn('SKIPPED chain test: needs local Supabase (npm run db:start) and Meterless (scripts/setup-meterless.sh)');

const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
afterAll(async () => pool.end());

const sid = () => 'SM' + randomBytes(16).toString('hex');

const picks = (...ids: [string, string][]) => JSON.stringify({
  picks: ids.map(([id, why]) => ({ id, why })),
  note: 'Different bets: ads, evenings and a Mazali push.',
});
const GOOD_PICKS = picks(
  ['online:1', 'Ads already return 2.4x, so more spend has room.'],
  ['salon:1', 'Evenings are untouched and wash and set earned $6,200.'],
  ['finance:1', 'It leans on $12,400 of Mazali revenue.'],
);
// A pick whose words hold a number that is not in the plan picked (sent twice, so the correction round fails too).
const BAD_PICKS = picks(['online:1', 'This could add 99% to profit.'], ['salon:1', 'Fine.'], ['finance:1', 'Fine.']);

type Message = { id: string; from_assistant: string; to_assistant: string; kind: string; status: string; dedupe_key: string; body: Record<string, any> };
type ReceiptRow = { step: string; assistant_id: string; outcome: string; model: string | null; input_tokens: number | null; output_tokens: number | null; detail: string | null };

describe.skipIf(!api)('plans from every department, end to end (real DB + real Meterless; models and data mocked)', () => {
  const sms: { to: string; body: string }[] = [];
  let deps: WorkerDeps;
  let model: ReturnType<typeof scriptedModel>;
  let ownerPhone = '';
  let financePhone = '';

  beforeAll(async () => {
    const phones = await pool.query(`select assistant_id, phone from public.people where assistant_id in ('owner','finance')`);
    for (const r of phones.rows as { assistant_id: string; phone: string }[]) {
      if (r.assistant_id === 'owner') ownerPhone = r.phone; else financePhone = r.phone;
    }
    deps = {
      store: createStore(api!.url, api!.key),
      brain: await openBrain({ meterlessDir, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fahq-chain-')), actor: 'chain-test' }),
      models: { nvidia: undefined as never, planModel: 'nvidia/nemotron-3-ultra-550b-a55b', routerModel: 'nvidia/nemotron-3.5-lightning-30b-a3b' },
      guard: { model: 'MOCK/guard' },
      data: dataMock,
      delivery: null,
      codeMode: null, // the plan chain needs no Code Mode; manager.test.ts and departments.test.ts cover the steps that do
      profiles: { skill: () => '', model: () => 'MOCK', reads: () => [] },
      now: () => new Date(),
      worker: 'chain-test-worker',
      live: false,
      period: '2026-09',
      smsLive: false,
      printers: {},
      printDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fahq-print-')),
      smsSink: (m) => sms.push(m),
    };
  });

  beforeEach(async () => {
    // A clean queue for each test (local test database only).
    await pool.query(`update public.tasks set status = 'cancelled' where status in ('queued','running','waiting')`);
    await pool.query(`update public.approvals set status = 'expired' where status = 'pending'`);
    await pool.query(`update public.outbox set status = 'skipped', last_error = 'reset by chain test' where status in ('pending','sending')`);
    sms.length = 0;
    model = scriptedModel({
      'guard.screen': SAFE,
      'front-door': routerReply('owner', 'plans'),
      'finance.plans': JSON.stringify(validPlans),
      'salon.plans': JSON.stringify(salonPlans),
      'online.plans': JSON.stringify(onlinePlans),
      'owner.synthesis': GOOD_PICKS,
    });
    deps.models = { ...deps.models, nvidia: model.port };
  });

  const textIn = async (from: string, body: string) => {
    const messageSid = sid();
    await pool.query('select * from public.enqueue_inbound_text($1, $2, $3, $4)', [messageSid, from, '+15550100001', body]);
    await runUntilIdle(deps);
    return messageSid;
  };
  const lastTo = (phone: string) => sms.filter((m) => m.to === phone).at(-1)?.body ?? '';
  const taskBy = async (key: string) =>
    (await pool.query(`select id, assistant_id, kind, status, payload, attempts, max_attempts from public.tasks where idempotency_key = $1`, [key])).rows[0] as TaskRow;
  const roundTask = (roundId: string) => taskBy('round:' + roundId);
  const messages = async (roundId: string) =>
    (await pool.query(`select id, from_assistant, to_assistant, kind, status, dedupe_key, body from public.assistant_messages where dedupe_key like $1 order by dedupe_key collate "C"`, [`%${roundId}%`])).rows as Message[];
  const receiptsOf = async (...taskIds: string[]) =>
    (await pool.query(`select step, assistant_id, outcome, model, input_tokens, output_tokens, detail from public.receipts where task_id = any($1) order by id`, [taskIds])).rows as ReceiptRow[];
  const planCalls = () => model.calls.filter((c) => /\.plans$/.test(c.purpose)).length;
  const planPurposes = () => model.calls.filter((c) => /\.plans$/.test(c.purpose)).map((c) => c.purpose);

  /** The owner asks for plans; returns the round's id (the inbound text's task id) and the code on the owner's phone. */
  async function askForPlans(body = 'Give me three plans to grow profit.') {
    const messageSid = await textIn(ownerPhone, body);
    const inbound = await taskBy('sms:' + messageSid);
    return { roundId: inbound.id, inbound, code: /SEND <1-3> (\d{6})/.exec(lastTo(ownerPhone))?.[1] ?? '' };
  }

  it("asks every department, picks three, and runs SEND → CONFIRM into the origin department's memory and finance's", async () => {
    const { roundId, inbound, code } = await askForPlans();
    const proposalSms = lastTo(ownerPhone);
    expect(proposalSms).toContain("Your departments' best 3 plans (every number checked against fortune_demo_finance_mart):");
    expect(proposalSms).toContain('1. [Online] Raise Google ad spend 20% (Google spend after the raise: $2,160)');
    expect(proposalSms).toContain('Why: Ads already return 2.4x, so more spend has room.');
    expect(proposalSms).toContain('2. [Salon] Open evening wash and set slots (Wash and set revenue with evenings: $7,130)');
    expect(proposalSms).toContain('3. [Finance] Push Google ads on Mazali (Google spend after the raise: $2,160)');
    expect(proposalSms).not.toContain("couldn't produce");
    expect(proposalSms).not.toContain('picked by rule');
    expect(proposalSms.endsWith(`Reply SEND <1-3> ${code} to send one to Demo Finance Owner. The code expires in 15 minutes.`)).toBe(true);

    // One request to each department, one proposal back from each, and the final three from Owner HQ.
    const rows = await messages(roundId);
    expect(rows.map((r) => [r.dedupe_key.replace(roundId, '<round>'), r.from_assistant, r.to_assistant, r.kind])).toEqual([
      ['final:<round>', 'owner', 'owner', 'proposal'],
      ['proposal:<round>:finance', 'finance', 'owner', 'proposal'],
      ['proposal:<round>:online', 'online', 'owner', 'proposal'],
      ['proposal:<round>:salon', 'salon', 'owner', 'proposal'],
      ['round:<round>:finance', 'owner', 'finance', 'request'],
      ['round:<round>:online', 'owner', 'online', 'request'],
      ['round:<round>:salon', 'owner', 'salon', 'request'],
    ]);
    expect(rows.filter((r) => r.kind === 'request').every((r) => r.status === 'answered' && r.body.roundId === roundId && r.body.text === 'Give me three plans to grow profit.')).toBe(true);
    const proposalOf = (department: string) => rows.find((r) => r.kind === 'proposal' && r.dedupe_key === `proposal:${roundId}:${department}`)!;
    const final = rows.find((r) => r.dedupe_key.startsWith('final:'))!;
    expect(final.body.origins).toEqual([
      { rank: 1, department: 'online', originalRank: 1, proposalId: proposalOf('online').id },
      { rank: 2, department: 'salon', originalRank: 1, proposalId: proposalOf('salon').id },
      { rank: 3, department: 'finance', originalRank: 1, proposalId: proposalOf('finance').id },
    ]);
    expect(final.body).toMatchObject({ pickedBy: 'model', view: 'fortune_demo_finance_mart', failedDepartments: [], requestText: 'Give me three plans to grow profit.', departments: ['finance', 'salon', 'online'] });
    expect(final.body.plans.plans.map((p: { rank: number; title: string }) => [p.rank, p.title])).toEqual([[1, 'Raise Google ad spend 20%'], [2, 'Open evening wash and set slots'], [3, 'Push Google ads on Mazali']]);
    expect(final.body.metrics.map((m: { id: string }) => m.id).sort()).toEqual(['m:online.ads.google.roas', 'm:online.ads.google.spend', 'm:online.revenue.mazali', 'm:salon.revenue.wash_set']);

    // Each department planned from its own slice, under its own name; Owner HQ's picker got the candidates.
    const slice = (purpose: string) => (JSON.parse(model.of(purpose)[0]!.user).metrics as { id: string }[]).map((m) => m.id).sort();
    expect(slice('finance.plans')).toEqual(mockMetrics.map((m) => m.id).sort());
    expect(slice('salon.plans')).toEqual(['m:salon.appointments.count', 'm:salon.revenue.wash_set']);
    expect(slice('online.plans')).toEqual(['m:online.ads.google.roas', 'm:online.ads.google.spend', 'm:online.revenue.mazali']);
    expect(model.of('finance.plans')[0]!.system).toBe(PLAN_SYSTEM + '\nYou are writing as the Finance department. Your data is every metric provided (salon, online and combined).');
    expect(model.of('salon.plans')[0]!.system).toContain('You are writing as the Salon department. Your data is only the salon metrics provided');
    expect(model.of('online.plans')[0]!.system).toContain('You are writing as the Online department. Your data is only the online metrics provided');
    const synthesis = model.of('owner.synthesis');
    expect(synthesis).toHaveLength(1);
    expect(synthesis[0]).toMatchObject({ model: 'nvidia/nemotron-3-ultra-550b-a55b', json: true, thinking: true, maxTokens: 6000, system: SYNTHESIS_SYSTEM });
    expect(JSON.parse(synthesis[0]!.user).candidates.map((c: { id: string }) => c.id)).toEqual(
      ['finance:1', 'finance:2', 'finance:3', 'salon:1', 'salon:2', 'salon:3', 'online:1', 'online:2', 'online:3']);

    // Receipts: the screen, the front door and the ask; then one per department, the picker and the final.
    const asked = await receiptsOf(inbound.id);
    expect(asked.map((r) => [r.step, r.outcome])).toEqual([['front-door.screen', 'ok'], ['front-door', 'ok'], ['owner.round', 'ok']]);
    expect(asked[0]).toMatchObject({ model: 'MOCK/MOCK/guard', input_tokens: 100, output_tokens: 200, detail: expect.stringMatching(/^safe in \d+ ms$/) });
    const round = await roundTask(roundId);
    expect(round).toMatchObject({ assistant_id: 'owner', kind: 'mailbox', status: 'done', payload: { job: 'plan_round', roundId, departments: ['finance', 'salon', 'online'] } });
    const steps = await receiptsOf(round.id);
    expect(steps.map((r) => [r.step, r.assistant_id, r.outcome]).sort()).toEqual([
      ['finance.plans', 'finance', 'ok'], ['online.plans', 'online', 'ok'], ['owner.final', 'owner', 'ok'], ['owner.synthesis', 'owner', 'ok'], ['salon.plans', 'salon', 'ok'],
    ]);
    expect(steps.filter((r) => r.step.endsWith('.plans')).every((r) => r.input_tokens === 100 && r.output_tokens === 200)).toBe(true);
    expect(steps.find((r) => r.step === 'owner.synthesis')).toMatchObject({ input_tokens: 100, output_tokens: 200, detail: 'attempts 1, 9 candidates' });
    const report = (await pool.query(`select assistant_id, outcome, model_calls, input_tokens, output_tokens, suggestions, summary from public.work_reports where task_id = $1`, [round.id])).rows[0];
    expect(report).toMatchObject({ assistant_id: 'owner', outcome: 'done', model_calls: 4, input_tokens: 400, output_tokens: 800, suggestions: [] });
    expect(report.summary).toContain('finance.plans ok (attempt 1 of 2)');

    // SEND 1 goes to the finance owner, who sees which department wrote the plan.
    await textIn(ownerPhone, `SEND 1 ${code}`);
    expect(lastTo(ownerPhone)).toContain('Sent plan 1');
    const forwardSms = lastTo(financePhone);
    expect(forwardSms).toContain('plan 1: Raise Google ad spend 20%');
    expect(forwardSms).toContain('From the Online department.');
    const decideCode = /CONFIRM (\d{6})/.exec(forwardSms)?.[1] ?? '';
    expect(decideCode).toMatch(/^\d{6}$/);
    await textIn(ownerPhone, `SEND 1 ${code}`); // the same code again
    expect(lastTo(ownerPhone)).toContain("didn't work");

    await textIn(financePhone, `CONFIRM ${decideCode}`);
    expect(lastTo(financePhone)).toContain('Recorded: you approved plan 1');
    expect(lastTo(ownerPhone)).toContain('approved plan 1: Raise Google ad spend 20%');

    // The decision lands in the department that wrote the plan AND in finance's memory; the salon heard nothing.
    expect(deps.brain.memory('online').recallDecisions('raise google ad spend')[0]?.memory.content).toContain('approved plan 1 "Raise Google ad spend 20%"');
    expect(deps.brain.memory('finance').recallDecisions('raise google ad spend')[0]?.memory.content).toContain('approved plan 1 "Raise Google ad spend 20%"');
    expect(deps.brain.memory('salon').recallDecisions('raise google ad spend')).toEqual([]);

    // "Why did you propose plan 1?" is answered from what was kept.
    const tools = createReadTools({ store: deps.store, brain: deps.brain, data: deps.data, now: deps.now }, 'owner');
    const why = (await tools.explain_proposal!.run({})) as Explained;
    expect(why.proposal).toMatchObject({ id: final.id.slice(0, 8), pickedBy: 'model', requestText: 'Give me three plans to grow profit.', view: 'fortune_demo_finance_mart', queryHash: 'c'.repeat(64) });
    expect(why.plans.map((p) => [p.rank, p.department, p.originalRank])).toEqual([[1, 'online', 1], [2, 'salon', 1], [3, 'finance', 1]]);
    expect(why.plans[0]!.why).toBe('Ads already return 2.4x, so more spend has room.');
    expect(why.cited).toContainEqual({ id: 'm:online.ads.google.roas', label: 'Google ad return', value: 2.4, unit: 'ratio', business: 'online' });
    expect(why.cited).toContainEqual({ id: 'm:salon.revenue.wash_set', label: 'Salon wash and set revenue', value: 6200, unit: 'usd', business: 'salon' });
    expect(why.record).toMatchObject({ askedBy: 'Demo Owner', request: { text: 'Give me three plans to grow profit.', from: 'owner' } });
    expect(why.record!.cites).toHaveLength(4);
    expect(why.decisions.map((d) => [d.by, d.action, d.planRank])).toEqual([['Demo Owner', 'forwarded', 1], ['Demo Finance Owner', 'approved', 1]]);
    expect(why.approvals.map((a) => [a.action, a.status])).toEqual([['forward_plan', 'signed'], ['decide_plan', 'signed']]);
    expect(why.notes).toEqual([]);
    expect(JSON.stringify(why)).not.toMatch(/\b\d{6}\b/);
    // The same trail by the short id, and a department's own proposal by its id.
    expect(((await tools.explain_proposal!.run({ proposal: final.id.slice(0, 8) })) as Explained).plans).toHaveLength(3);
    const salon = (await tools.explain_proposal!.run({ proposal: proposalOf('salon').id.slice(0, 8) })) as Explained;
    expect(salon.plans.map((p) => p.department)).toEqual(['salon', 'salon', 'salon']);

    // The shared record keeps every link: the final proposal cites four metrics, and the codes are blanked once handled.
    expect(deps.brain.record.explainProposal(final.id).cites).toHaveLength(4);
    const stored = await pool.query(`select body from public.outbox where body like '%SEND <1-3>%' order by created_at desc limit 1`);
    expect(stored.rows[0].body).not.toMatch(/\d{6}/);
  });

  it('carries on without a department whose plans fail the number check, and says which one', async () => {
    const wrong = structuredClone(onlinePlans);
    wrong.plans[0]!.evidence[0]!.value = 99999;
    model.script('online.plans', JSON.stringify(wrong));
    model.script('owner.synthesis', picks(['salon:1', 'Evenings are untouched.'], ['finance:1', 'It leans on $12,400 of Mazali revenue.'], ['salon:2', 'It uses the 310 appointments already booked.']));
    const { roundId, code } = await askForPlans();
    const proposalSms = lastTo(ownerPhone);
    expect(proposalSms).toContain('1. [Salon] Open evening wash and set slots');
    expect(proposalSms).toContain('2. [Finance] Push Google ads on Mazali');
    expect(proposalSms).toContain('3. [Salon] Fill the quiet weekday gaps');
    expect(proposalSms).not.toContain('[Online]');
    expect(proposalSms).toContain("Online couldn't produce checked plans.");
    expect(proposalSms.endsWith(`Reply SEND <1-3> ${code} to send one to Demo Finance Owner. The code expires in 15 minutes.`)).toBe(true);

    expect(model.of('online.plans')).toHaveLength(2); // its one correction round, then a plain failure
    expect(JSON.parse(model.of('online.plans')[1]!.user).previousAttemptRejectedBecause[0]).toContain('says 99999');
    expect((JSON.parse(model.of('owner.synthesis')[0]!.user).candidates as { id: string }[]).some((c) => c.id.startsWith('online'))).toBe(false);

    const rows = await messages(roundId);
    const failedReport = rows.find((r) => r.dedupe_key === `round-failed:${roundId}:online`)!;
    expect(failedReport).toMatchObject({ from_assistant: 'online', to_assistant: 'owner', kind: 'report', body: { roundId, failed: true } });
    expect(failedReport.body.reason).toContain('says 99999');
    expect(rows.find((r) => r.dedupe_key === `round:${roundId}:online`)!.status).toBe('closed');
    const round = await roundTask(roundId);
    expect(round.status).toBe('done');
    expect((await receiptsOf(round.id)).find((r) => r.step === 'online.plans')).toMatchObject({
      assistant_id: 'online', outcome: 'failed', input_tokens: 200, output_tokens: 400, detail: expect.stringContaining('says 99999'),
    });
    expect(rows.find((r) => r.dedupe_key.startsWith('final:'))!.body).toMatchObject({ failedDepartments: ['online'], departments: ['finance', 'salon'], pickedBy: 'model' });

    // The failure reaches the manager's report as a reliability suggestion about the online department.
    const report = (await pool.query(`select suggestions from public.work_reports where task_id = $1`, [round.id])).rows[0];
    expect(report.suggestions).toContainEqual({ kind: 'reliability', about: 'online', text: expect.stringContaining('online.plans failed') });
  });

  it('picks by rule, and says so, when the picker fails its number check twice', async () => {
    model.script('owner.synthesis', BAD_PICKS);
    const { roundId } = await askForPlans();
    const proposalSms = lastTo(ownerPhone);
    expect(proposalSms).toContain("Your departments' best 3 plans (picked by rule; every number checked against fortune_demo_finance_mart):");
    // Each department's rank 1 plan, in the order finance, online, salon.
    expect(proposalSms).toContain('1. [Finance] Push Google ads on Mazali');
    expect(proposalSms).toContain('2. [Online] Raise Google ad spend 20%');
    expect(proposalSms).toContain('3. [Salon] Open evening wash and set slots');
    expect(model.of('owner.synthesis')).toHaveLength(2);
    expect(JSON.parse(model.of('owner.synthesis')[1]!.user).previousAttemptRejectedBecause).toContain('pick 1 why: "99%" is not a number in the data');

    const round = await roundTask(roundId);
    const synthesis = (await receiptsOf(round.id)).find((r) => r.step === 'owner.synthesis')!;
    expect(synthesis).toMatchObject({ outcome: 'refused', input_tokens: 200, output_tokens: 400, detail: expect.stringContaining('picked by rule') });
    const final = (await messages(roundId)).find((r) => r.dedupe_key.startsWith('final:'))!;
    expect(final.body.pickedBy).toBe('rule');
    expect(final.body.origins.map((o: { department: string }) => o.department)).toEqual(['finance', 'online', 'salon']);
    const report = (await pool.query(`select suggestions from public.work_reports where task_id = $1`, [round.id])).rows[0];
    expect(report.suggestions).toContainEqual({ kind: 'prompt', about: 'owner', text: expect.stringContaining('owner.synthesis was refused') });
  });

  it('picks by rule too when the picker model itself fails, and does not ask it again', async () => {
    model.script('owner.synthesis', new Error('daily token budget reached (990000 of 1000000)'));
    const { roundId } = await askForPlans();
    expect(lastTo(ownerPhone)).toContain('picked by rule');
    expect(model.of('owner.synthesis')).toHaveLength(1);
    const synthesis = (await receiptsOf((await roundTask(roundId)).id)).find((r) => r.step === 'owner.synthesis')!;
    expect(synthesis).toMatchObject({ outcome: 'failed', detail: expect.stringContaining('daily token budget reached') });
  });

  it('asks only the department named: its own three plans, no picker, no other department', async () => {
    model.script('front-door', routerReply('online', 'plans'));
    const { roundId } = await askForPlans('Ask online for ideas to bring back lapsed customers.');
    const proposalSms = lastTo(ownerPhone);
    expect(proposalSms).toContain('1. [Online] Raise Google ad spend 20%');
    expect(proposalSms).toContain('2. [Online] Email Mazali buyers a restock note');
    expect(proposalSms).toContain('3. [Online] Hold Google spend and test new ads');
    expect(proposalSms).not.toContain('picked by rule');
    expect(proposalSms).not.toContain('Why:');
    expect(planPurposes()).toEqual(['online.plans']);
    expect(model.of('owner.synthesis')).toHaveLength(0);
    expect((await messages(roundId)).map((r) => r.dedupe_key.replace(roundId, '<round>'))).toEqual(['final:<round>', 'proposal:<round>:online', 'round:<round>:online']);
    expect((await roundTask(roundId)).payload).toMatchObject({ departments: ['online'] });
  });

  it('asks every department when the text goes to the manager, which sits under Owner HQ', async () => {
    model.script('front-door', routerReply('manager', 'plans'));
    await askForPlans('Plans please.');
    expect(planPurposes().sort()).toEqual(['finance.plans', 'online.plans', 'salon.plans']);
  });

  it('runs the round once: a task that runs again keeps the plans, the picks and the code already sent', async () => {
    const { roundId, code } = await askForPlans();
    const before = { plans: planCalls(), picks: model.of('owner.synthesis').length, texts: sms.length };
    expect(code).toMatch(/^\d{6}$/);

    // The round runs again (as after a crash past its last write): nothing new is asked, written or sent.
    expect((await handleTask(await roundTask(roundId), deps)).status).toBe('done');
    await runUntilIdle(deps);
    expect({ plans: planCalls(), picks: model.of('owner.synthesis').length, texts: sms.length }).toEqual(before);
    expect((await messages(roundId)).filter((r) => r.kind === 'proposal')).toHaveLength(4);

    // The inbound text runs again: the same requests and the same round, not a second one.
    const inbound = (await pool.query(`select id, assistant_id, kind, status, payload, attempts, max_attempts from public.tasks where id = $1`, [roundId])).rows[0] as TaskRow;
    expect((await handleTask(inbound, deps)).status).toBe('done');
    await runUntilIdle(deps);
    expect({ plans: planCalls(), texts: sms.length }).toEqual({ plans: before.plans, texts: before.texts });
    expect((await pool.query(`select count(*)::int as n from public.tasks where idempotency_key = $1`, ['round:' + roundId])).rows[0].n).toBe(1);

    // The code that was sent still works, and the wrong command word is refused without spending it.
    await textIn(ownerPhone, `CONFIRM ${code}`);
    expect(lastTo(ownerPhone)).toContain('That code is for sending a plan');
    await textIn(ownerPhone, `SEND 2 ${code}`);
    expect(lastTo(ownerPhone)).toContain('Sent plan 2');
    expect(lastTo(financePhone)).toContain('From the Salon department.');
    const sendTask = (await pool.query(`select id, assistant_id, kind, status, payload, attempts, max_attempts from public.tasks where kind = 'inbound_text' and payload->>'body' = $1`, [`SEND 2 ${code}`])).rows[0] as TaskRow;
    const forwards = () => sms.filter((m) => m.to === financePhone && m.body.includes('sent you plan')).length;
    const forwardsBefore = forwards();
    expect((await handleTask(sendTask, deps)).status).toBe('done'); // resumes instead of "That code didn't work"
    await runUntilIdle(deps);
    expect(forwards()).toBe(forwardsBefore);
    expect((await pool.query(`select outcome from public.receipts where task_id = $1 and step = 'approval.forward' order by id`, [sendTask.id])).rows.map((r: { outcome: string }) => r.outcome)).toEqual(['ok', 'ok']);
  });

  it('fails plainly, and sends nothing, when no department can produce checked plans', async () => {
    const wrong = (plans: typeof onlinePlans | typeof salonPlans | typeof validPlans) => {
      const bad = structuredClone(plans);
      bad.plans[0]!.evidence[0]!.value = 99999;
      return JSON.stringify(bad);
    };
    model.script('finance.plans', wrong(validPlans));
    model.script('salon.plans', wrong(salonPlans));
    model.script('online.plans', wrong(onlinePlans));
    const { roundId } = await askForPlans();
    expect(lastTo(ownerPhone)).toBe("I couldn't get plans whose numbers all check out from any department, so I'm not sending any. The reasons are on the console.");
    expect(sms.filter((m) => m.body.includes('SEND <1-3>'))).toHaveLength(0);
    expect((await roundTask(roundId)).status).toBe('failed');
    expect(model.of('owner.synthesis')).toHaveLength(0);
    expect((await messages(roundId)).filter((r) => r.kind === 'proposal')).toEqual([]);
  });

  it('says plainly when business data is not connected, and when it cannot be read', async () => {
    const saved = deps.data;
    try {
      deps.data = null;
      await askForPlans();
      expect(lastTo(ownerPhone)).toBe("Business data isn't connected yet, so I can't prepare plans. Nothing was sent.");
      deps.data = { health: async () => ({ ok: false, detail: 'down' }), getFinanceMetrics: async () => { throw new Error('zetaris is down'); } };
      const { roundId } = await askForPlans();
      expect(lastTo(ownerPhone)).toBe("I couldn't read the business data just now, so no department could plan. Nothing was sent.");
      expect((await receiptsOf((await roundTask(roundId)).id))[0]).toMatchObject({ step: 'owner.data', outcome: 'failed', detail: 'zetaris is down' });
      expect(planCalls()).toBe(0);
    } finally {
      deps.data = saved;
    }
  });

  it('keeps the old finance-only mailbox handler working for a request that was queued before', async () => {
    const requestTask = '11111111-1111-4111-8111-' + randomBytes(6).toString('hex');
    const ask = 'Three safe plans for next month, please.';
    const request = await deps.store.postMessage({
      from: 'owner', to: 'finance', kind: 'request', replyTo: null, dedupeKey: `request:${requestTask}`,
      body: { text: ask, personId: 'demo-p-owner', risks: [], taskId: requestTask },
    });
    await deps.brain.record.request({ taskId: requestTask, personId: 'demo-p-owner', personName: 'Demo Owner', from: 'owner', to: 'finance', text: ask, at: new Date().toISOString(), runId: requestTask });
    await deps.store.enqueueTask({ assistant: 'finance', kind: 'mailbox', key: `mailbox:${request.id}`, payload: { messageId: request.id }, now: new Date() });
    await runUntilIdle(deps);
    const proposalSms = lastTo(ownerPhone);
    expect(proposalSms).toContain("Your finance assistant's 3 plans (every number checked against fortune_demo_finance_mart):");
    expect(proposalSms).toContain('1. Push Google ads on Mazali');
    expect(proposalSms).not.toContain('[Finance]');
    expect(model.calls.map((c) => c.purpose)).toEqual(['finance.plans']);
    expect(model.of('finance.plans')[0]!.system).toBe(PLAN_SYSTEM); // no department line on the old path

    // It still works all the way: SEND, then CONFIRM, remembered in finance's memory.
    const code = /SEND <1-3> (\d{6})/.exec(proposalSms)?.[1] ?? '';
    await textIn(ownerPhone, `SEND 2 ${code}`);
    expect(lastTo(financePhone)).toContain('plan 2: Evening wash and set slots');
    expect(lastTo(financePhone)).not.toContain('From the');
    await textIn(financePhone, `CONFIRM ${/CONFIRM (\d{6})/.exec(lastTo(financePhone))?.[1]}`);
    expect(deps.brain.memory('finance').recallDecisions('evening wash and set slots')[0]?.memory.content).toContain('approved plan 2');
  });
});
