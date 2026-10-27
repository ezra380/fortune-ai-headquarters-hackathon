import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ModelPort, Receipt } from '@fahq/contracts';
import { openBrain } from '@fahq/brain';
import { loadProfiles } from '@fahq/profiles';
import { handleTask, type WorkerDeps } from '../src/flows.ts';
import { ANSWER_RULES, REVIEW_RULES } from '../src/manager.ts';
import { buildWorkReport } from '../src/reports.ts';
import { runUntilIdle } from '../src/runner.ts';
import { createStore, type TaskRow } from '../src/store.ts';
import { dataMock, fakeCodeMode, okResult, routerReply, scriptedModel, validPlans } from './fixtures.ts';
import { dbUrl, haveMeterless, localApi, meterlessDir } from './localdb.ts';
import { memoryProfiles } from './profile-port.ts';

// The HQ Manager end to end on the real local database and the real Meterless engines. Only the models,
// Code Mode and the Zetaris adapter are fakes (scripted below); SMS is a dry run. The profile tables are in memory
// (profile-port.ts): a profile version cannot be taken back from the real table, so no test writes one there.
// As shipped, every change waits for the owner's one-time code (MANAGER_APPLIES is all false). The mechanism that lets the
// manager apply a lesson or a note itself is off and tested in manager-decides.test.ts; two tests here switch it on
// (deps.managerApplies, which nothing in production sets) to show the whole loop with it.

const api = haveMeterless ? localApi() : null;
if (!api) console.warn('SKIPPED manager tests: needs local Supabase (npm run db:start) and Meterless (scripts/setup-meterless.sh)');

const pool = new pg.Pool({ connectionString: dbUrl, max: 3 });
afterAll(async () => pool.end());

const sid = () => 'SM' + randomBytes(16).toString('hex');
const OWNER_NUMBER = '+15550100001';
const RULE_ON = { lesson: true, skill_note: true, reads: false, model: false } as const;

// ---- Fakes (fixtures.ts) --------------------------------------------------------------------------

const router = (target: string, intent = 'question') => routerReply(target, intent);

const digest = {
  byAssistant: [
    { assistant: 'finance', tasks: 5, failed: 1, inputTokens: 1500, outputTokens: 3000 },
    { assistant: 'owner', tasks: 4, failed: 0, inputTokens: 800, outputTokens: 400 },
  ],
  slowest: [{ step: 'finance.plans', seconds: 112 }],
  suggestions: [{ text: 'The plan writer needed a correction round.', count: 2 }],
};

// The database keeps adopted lessons between runs, and a review that repeats one is rejected, so every
// review these tests write carries recommendations nobody has adopted yet. The tag is letters only: the
// number trace must not see digits it cannot find in the digest.
const letters = (n: number) => { let s = ''; let rest = n; do { s = String.fromCharCode(97 + (rest % 26)) + s; rest = Math.floor(rest / 26); } while (rest > 0); return s; };
const RUN_TAG = letters(randomBytes(4).readUInt32BE());
let reviewCount = 0;

// What the mock skills say: a stored profile must still say it is read-only and keep its "You never" section.
const skillOf = (id: string) => `SKILL(${id}) This assistant is read-only.\n\n## You never\nChange anything.`;

type Rec = { rank: number; assistant: string; kind?: string; change: string; why: string; reads?: unknown; model?: unknown };
// Recommendation 1 is a lesson for finance. Recommendation 2 gives the online assistant a read tool. As shipped both wait
// for the owner's code; with the rule on, the manager applies the lesson by itself and only the read tool waits.
function makeReview(over: { summary?: string; recs?: Rec[] } = {}) {
  const tag = `${RUN_TAG}${letters(reviewCount++)}`;
  const lesson = `Give every stop-loss a lever so the first plan check passes (${tag}).`;
  const json = JSON.stringify({
    summary: over.summary ?? 'Finance handled 5 tasks and 1 failed; it used 1500 tokens in and 3000 out.',
    findings: [{ assistant: 'finance', text: 'The slowest step was finance.plans at 112 s.' }],
    recommendations: over.recs ?? [
      { rank: 1, assistant: 'finance', kind: 'lesson', change: lesson, why: 'The plan writer needed a correction round twice, and finance.plans took 112 s.' },
      { rank: 2, assistant: 'online', kind: 'reads', change: 'Let the online assistant read usage.', why: 'Owner lookups used 800 tokens in and 400 out.', reads: { add: ['usage_summary'] } },
    ],
  });
  return { json, lesson, readsLine: 'Read tools: add usage_summary' };
}
const badReview = () => makeReview({ summary: 'Finance had 8 failures.' }).json;

const reads: Record<string, string[]> = {
  manager: ['list_work_reports', 'usage_summary', 'open_items'],
  finance: ['get_finance_metrics', 'recall_my_decisions', 'my_lessons'],
  owner: ['usage_summary', 'latest_proposal', 'list_lessons'],
  salon: ['get_salon_metrics', 'recall_my_decisions', 'my_lessons'],
  online: ['get_online_metrics', 'recall_my_decisions', 'my_lessons'],
};

describe.skipIf(!api)('the HQ Manager (real database and Meterless; models and Code Mode scripted)', () => {
  const sms: { to: string; body: string }[] = [];
  const profileTables = memoryProfiles();
  let deps: WorkerDeps;
  const use = { rule: false };
  /** The worker's dependencies as shipped, or with the manager allowed to apply lessons and skill notes (the mechanism, off). */
  const current = (): WorkerDeps => (use.rule ? { ...deps, managerApplies: RULE_ON } : deps);
  let model: ReturnType<typeof scriptedModel>;
  let codeMode: ReturnType<typeof fakeCodeMode>;
  let ownerPhone = '';
  let financePhone = '';

  beforeAll(async () => {
    const phones = await pool.query(`select assistant_id, phone from public.people where assistant_id in ('owner','finance')`);
    for (const r of phones.rows as { assistant_id: string; phone: string }[]) {
      if (r.assistant_id === 'owner') ownerPhone = r.phone; else financePhone = r.phone;
    }
    deps = {
      // The real store, except the profile tables (in memory) and the outside session reports (this file looks at none).
      store: { ...createStore(api!.url, api!.key), ...profileTables.port, sessionReports: async () => [], expireSessionReports: async () => 0 },
      brain: await openBrain({ meterlessDir, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fahq-manager-')), actor: 'manager-test' }),
      models: { nvidia: undefined as unknown as ModelPort, planModel: 'MOCK/plans', routerModel: 'MOCK/router' },
      guard: null,
      data: dataMock,
      delivery: null,
      codeMode: null,
      profiles: {
        skill: skillOf,
        model: (id, job) => `MOCK/${id}/${job}`,
        reads: (id) => reads[id] ?? [],
      },
      now: () => new Date(),
      worker: 'manager-test-worker',
      live: false,
      period: '2026-09',
      smsLive: false,
      printers: {},
      printDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fahq-manager-print-')),
      smsSink: (m) => sms.push(m),
    };
  });

  beforeEach(async () => {
    // A clean queue and fresh scripts for each test (local test database only).
    await pool.query(`update public.tasks set status = 'cancelled' where status in ('queued','running','waiting')`);
    await pool.query(`update public.approvals set status = 'expired' where status = 'pending'`);
    await pool.query(`update public.outbox set status = 'skipped', last_error = 'reset by manager test' where status in ('pending','sending')`);
    sms.length = 0;
    use.rule = false;
    model = scriptedModel();
    codeMode = fakeCodeMode();
    deps.models = { ...deps.models, nvidia: model.port };
    deps.codeMode = codeMode.runner;
    codeMode.respond(() => okResult(digest));
  });

  const textIn = async (from: string, body: string) => {
    const messageSid = sid();
    await pool.query('select * from public.enqueue_inbound_text($1, $2, $3, $4)', [messageSid, from, OWNER_NUMBER, body]);
    await runUntilIdle(current());
    return messageSid;
  };
  const smsTo = (phone: string) => sms.filter((m) => m.to === phone).map((m) => m.body);
  const lastTo = (phone: string) => smsTo(phone).at(-1) ?? '';
  const adoptCode = (body: string) => /Reply ADOPT (?:<n>|\d) (\d{6})/.exec(body)?.[1] ?? '';
  const latestManagerTask = async () =>
    (await pool.query(`select id, assistant_id, kind, status, payload, attempts, max_attempts, last_error from public.tasks where assistant_id = 'manager' order by created_at desc limit 1`)).rows[0] as TaskRow & { last_error: string | null };
  const taskOfText = async (messageSid: string) =>
    (await pool.query(`select id, assistant_id, kind, status, payload, attempts, max_attempts from public.tasks where idempotency_key = $1`, ['sms:' + messageSid])).rows[0] as TaskRow;
  const reportOf = async (taskId: string) =>
    (await pool.query('select * from public.work_reports where task_id = $1', [taskId])).rows[0];
  const stepsOf = async (taskId: string) =>
    (await pool.query('select step, outcome, model, input_tokens, output_tokens, detail from public.receipts where task_id = $1 order by id', [taskId])).rows as
      { step: string; outcome: string; model: string | null; input_tokens: number | null; output_tokens: number | null; detail: string | null }[];

  /** REVIEW from the owner, with the scripted digest and review; returns the code on the owner's phone. */
  async function askForReview(...replies: string[]) {
    model.script('manager.review', ...(replies.length > 0 ? replies : [makeReview().json]));
    await textIn(ownerPhone, 'REVIEW');
    return { code: adoptCode(lastTo(ownerPhone)), task: await latestManagerTask() };
  }

  it('saves a report for every task the worker runs, with its steps, tokens and suggestions', async () => {
    const messageSid = await textIn(ownerPhone, 'STATUS');
    const row = await reportOf((await taskOfText(messageSid)).id);
    expect(row).toMatchObject({ assistant_id: 'owner', task_kind: 'inbound_text', outcome: 'done', model_calls: 0, input_tokens: 0, output_tokens: 0 });
    expect(row.summary).toMatch(/^inbound_text task done in \d+ s; no steps recorded$/);
    expect(row.suggestions).toEqual([]);
  });

  it('stores receipts with their tokens and builds the report from them', async () => {
    const taskId = (await pool.query(
      `insert into public.tasks (assistant_id, kind, idempotency_key, payload, status) values ('finance', 'mailbox', $1, '{}'::jsonb, 'done') returning id`,
      ['manager-test:' + randomUUID()],
    )).rows[0].id as string;
    const t0 = new Date('2026-10-26T12:00:00.000Z');
    const receipt: Receipt = {
      runId: randomUUID(), taskId, step: 'finance.plans', assistantId: 'finance', live: false, model: 'MOCK/plans', dataSource: null,
      startedAt: t0.toISOString(), endedAt: new Date(t0.getTime() + 90_000).toISOString(), costUsd: null, outcome: 'ok',
      detail: 'attempts 2, tokens 900, cited 5 metrics; first objection: plan 1: evidence is wrong', inputTokens: 300, outputTokens: 600,
    };
    await deps.store.receipt(receipt);
    const report = buildWorkReport({ task: { id: taskId, assistant_id: 'finance', kind: 'mailbox' }, outcome: 'done', error: null, receipts: [receipt], startedAt: t0, endedAt: new Date(t0.getTime() + 91_000) });
    await deps.store.saveWorkReport(report);
    const row = await reportOf(taskId);
    expect(row).toMatchObject({ outcome: 'done', model_calls: 1, input_tokens: 300, output_tokens: 600 });
    expect(row.summary).toBe('mailbox task done in 91 s; finance.plans ok (attempt 2 of 2)');
    expect(row.suggestions).toEqual([
      { kind: 'prompt', about: 'finance', text: 'The plan writer needed a correction round. First objection: plan 1: evidence is wrong' },
      { kind: 'speed', about: 'finance', text: 'finance.plans took 90 s' },
    ]);
    expect((await stepsOf(taskId))[0]).toMatchObject({ step: 'finance.plans', input_tokens: 300, output_tokens: 600 });
  });

  it('REVIEW → digest through Code Mode → a checked review → every change waits for the owner\'s code → ADOPT puts each in place as a version made by the owner', async () => {
    const r = makeReview();
    const financeBefore = profileTables.versionsOf('finance').length;
    const onlineBefore = profileTables.versionsOf('online').length;
    const { code, task } = await askForReview(r.json);
    const body = lastTo(ownerPhone);
    expect(code).toMatch(/^\d{6}$/);
    expect(body).toContain('HQ Manager review (last 24 h): Finance handled 5 tasks and 1 failed; it used 1500 tokens in and 3000 out.');
    expect(body).toContain(`Needs your code:\n1. [finance] lesson: ${r.lesson}\n2. [online] data access: ${r.readsLine}`);
    expect(body).not.toContain('I changed');
    expect(body).not.toContain('I did not apply');
    expect(body.endsWith(`Reply ADOPT <n> ${code} to approve one (ADOPT 1 2 ${code} for all). The code works for 12 hours.`)).toBe(true);
    expect(task).toMatchObject({ status: 'done', kind: 'scheduled', payload: { job: 'manager_review', hours: 24, requestedBy: 'demo-p-owner' } });

    // Code Mode got the manager's skill, model and tools; the review writer got the digest.
    expect(codeMode.calls).toHaveLength(1);
    expect(codeMode.calls[0]).toMatchObject({ purpose: 'manager.digest', model: 'MOCK/manager/code', skill: skillOf('manager') });
    expect(codeMode.calls[0]!.tools.map((t) => t.name)).toEqual(reads.manager);
    expect(codeMode.calls[0]!.question).toContain('last 24 hours');
    const written = model.of('manager.review');
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ model: 'MOCK/manager/review', json: true });
    expect(written[0]!.system).toBe(`${skillOf('manager')}\n\n${REVIEW_RULES}`);
    expect(REVIEW_RULES).not.toContain('Applied at once'); // no kind is applied without the owner's code, and the writer is not told otherwise
    // The writer is also told what each assistant may read and which models are in use, so it can only name real ones.
    expect(JSON.parse(written[0]!.user)).toMatchObject({
      digest, lessonsAlreadyAdopted: expect.any(Array),
      profiles: { readToolNames: expect.arrayContaining(['list_session_reports', 'get_online_metrics']), modelsInUse: expect.arrayContaining(['MOCK/online/code']), assistants: { online: { reads: reads.online }, finance: { reads: reads.finance } } },
    });

    // Stored: the review with its digest, the typed recommendations (all open), a report message, one adopt_change approval.
    const stored = (await pool.query('select * from public.manager_reviews where task_id = $1', [task.id])).rows[0];
    expect(stored).toMatchObject({ review_key: `review:${task.id}`, digest, model: 'MOCK/MOCK/manager/review' });
    expect(stored.report_count).toBeGreaterThanOrEqual(1);
    const recs = (await pool.query('select id, rank, assistant_id, kind, change, status, decided_by, applied_by, applied_version, detail from public.recommendations where review_id = $1 order by rank', [stored.id])).rows;
    expect(recs).toEqual([
      { id: recs[0].id, rank: 1, assistant_id: 'finance', kind: 'lesson', change: r.lesson, status: 'proposed', decided_by: null, applied_by: null, applied_version: null, detail: {} },
      { id: recs[1].id, rank: 2, assistant_id: 'online', kind: 'reads', change: r.readsLine, status: 'proposed', decided_by: null, applied_by: null, applied_version: null, detail: { reads: { add: ['usage_summary'], remove: [] } } },
    ]);
    // Nothing has been written to a profile, or remembered as a lesson.
    expect(profileTables.versionsOf('finance')).toHaveLength(financeBefore);
    expect(profileTables.versionsOf('online')).toHaveLength(onlineBefore);
    expect(deps.brain.memory('finance').lessons().map((m) => m.content)).not.toContain(r.lesson);
    const message = (await pool.query('select id, from_assistant, to_assistant, kind, body from public.assistant_messages where id = $1', [stored.message_id])).rows[0];
    expect(message).toMatchObject({ from_assistant: 'manager', to_assistant: 'owner', kind: 'report', body: { reviewId: stored.id } });
    const approval = (await pool.query(`select action, status, extract(epoch from (expires_at - created_at))::int as ttl, approver_person_id from public.approvals where message_id = $1`, [message.id])).rows;
    expect(approval).toEqual([{ action: 'adopt_change', status: 'pending', ttl: 12 * 3600, approver_person_id: 'demo-p-owner' }]);
    const sent = (await pool.query(`select from_assistant, body from public.outbox where dedupe_key = $1`, [`review-sms:${stored.id}`])).rows;
    expect(sent).toHaveLength(1);
    expect(sent[0].from_assistant).toBe('owner'); // the manager has no number: the text comes from Owner HQ
    expect(sent[0].body).not.toContain(code); // blanked once handled

    // The reports of the manager task: steps, tokens, Code Mode usage. The manager applied nothing.
    const reviewReport = await reportOf(task.id);
    expect(reviewReport).toMatchObject({ assistant_id: 'manager', outcome: 'done', model_calls: 2, input_tokens: 800, output_tokens: 350 });
    expect(reviewReport.steps.map((s: { step: string }) => s.step)).toEqual(['manager.digest', 'manager.review']);
    expect(reviewReport.usage.codeMode).toMatchObject({ scripts: 1, toolCalls: 3 });
    expect(reviewReport.suggestions).toEqual([]);

    // ADOPT 1 2: the code works once; the lesson and the read tool are each a new version made by the owner.
    const adoptSid = await textIn(ownerPhone, `ADOPT 1 2 ${code}`);
    expect(lastTo(ownerPhone)).toBe("Adopted: 1 (finance), 2 (online). They're now in place.");
    const after = (await pool.query('select rank, status, decided_by, applied_by, applied_version from public.recommendations where review_id = $1 order by rank', [stored.id])).rows;
    const financeNow = profileTables.row('finance');
    const onlineNow = profileTables.row('online');
    expect(after).toEqual([
      { rank: 1, status: 'adopted', decided_by: 'demo-p-owner', applied_by: 'owner', applied_version: financeNow.version },
      { rank: 2, status: 'adopted', decided_by: 'demo-p-owner', applied_by: 'owner', applied_version: onlineNow.version },
    ]);
    expect(profileTables.versionsOf('finance')).toHaveLength(financeBefore + 1);
    expect(profileTables.versionsOf('finance').at(-1)).toMatchObject({ madeBy: 'owner', change: { kind: 'lesson', recommendation: recs[0].id, review: stored.id, rank: 1 } });
    expect(profileTables.lessons('finance').at(-1)).toMatchObject({ text: r.lesson, source: recs[0].id, by: 'owner' });
    expect(onlineNow.reads).toEqual([...loadProfiles({}).online.reads, 'usage_summary']);
    expect(profileTables.versionsOf('online')).toHaveLength(onlineBefore + 1);
    expect(profileTables.versionsOf('online').at(-1)).toMatchObject({ madeBy: 'owner', change: { kind: 'reads', recommendation: recs[1].id, reads: { add: ['usage_summary'], remove: [] } } });
    expect(deps.brain.memory('finance').lessons().map((m) => m.content)).toContain(r.lesson); // H-MEM, a cache of the database
    expect(deps.brain.memory('manager').lessons().map((m) => m.content)).toContain(`For finance: ${r.lesson}`);
    expect(deps.brain.memory('finance').recallDecisions('business question lookup')).toEqual([]); // a lesson is never a decision
    expect(deps.brain.record.audit(2000).some((a) => a.summary.includes('-[adopted]->'))).toBe(true);
    expect((await stepsOf((await taskOfText(adoptSid)).id)).map((s) => [s.step, s.outcome])).toEqual([['approval.adopt', 'ok']]);

    // The same code again is refused (single use) and adopts nothing more.
    const versionsBefore = profileTables.history.length;
    await textIn(ownerPhone, `ADOPT 1 ${code}`);
    expect(lastTo(ownerPhone)).toBe("That code didn't work or has expired. Nothing was adopted.");
    expect(profileTables.history).toHaveLength(versionsBefore);

    // The ADOPT task run again (a crash after the code was spent) resumes: same reply, no second version.
    const smsBefore = sms.length;
    expect((await handleTask(await taskOfText(adoptSid), deps)).status).toBe('done');
    await runUntilIdle(deps);
    expect(profileTables.history).toHaveLength(versionsBefore);
    expect(sms.length).toBe(smsBefore);

    // The next review tells the writer which changes are already in force.
    model.script('manager.review', makeReview().json);
    await textIn(ownerPhone, 'REVIEW');
    const next = JSON.parse(model.of('manager.review').at(-1)!.user) as { lessonsAlreadyAdopted: { assistant: string; text: string }[] };
    expect(next.lessonsAlreadyAdopted).toContainEqual({ assistant: 'finance', text: r.lesson });
    expect(next.lessonsAlreadyAdopted).toContainEqual({ assistant: 'online', text: r.readsLine });
  });

  it('with the rule on: the manager applies the lesson itself, the owner is told, and ADOPT applies what still needs his code', async () => {
    use.rule = true;
    profileTables.row('online').reads = [...loadProfiles({}).online.reads]; // the test before adopted this read for online already
    const r = makeReview();
    const financeBefore = profileTables.versionsOf('finance').length;
    const onlineBefore = profileTables.versionsOf('online').length;
    const { code, task } = await askForReview(r.json);
    const body = lastTo(ownerPhone);
    expect(code).toMatch(/^\d{6}$/);
    expect(body).toContain('HQ Manager review (last 24 h): Finance handled 5 tasks and 1 failed; it used 1500 tokens in and 3000 out.');
    expect(body).toContain(`I changed (each is a new profile version; the old one stays in the history):\n1. [finance] lesson: ${r.lesson}`);
    expect(body).toContain(`Needs your code:\n2. [online] data access: ${r.readsLine}`);
    expect(body).not.toContain('I did not apply');
    expect(body.endsWith(`Reply ADOPT 2 ${code} to approve it. The code works for 12 hours.`)).toBe(true);
    expect(task).toMatchObject({ status: 'done', kind: 'scheduled', payload: { job: 'manager_review', hours: 24, requestedBy: 'demo-p-owner' } });

    // Code Mode got the manager's skill, model and tools; the review writer got the digest.
    expect(codeMode.calls).toHaveLength(1);
    expect(codeMode.calls[0]).toMatchObject({ purpose: 'manager.digest', model: 'MOCK/manager/code', skill: skillOf('manager') });
    expect(codeMode.calls[0]!.tools.map((t) => t.name)).toEqual(reads.manager);
    expect(codeMode.calls[0]!.question).toContain('last 24 hours');
    const written = model.of('manager.review');
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ model: 'MOCK/manager/review', json: true });
    expect(written[0]!.system).toBe(`${skillOf('manager')}\n\n${REVIEW_RULES}`);
    // The writer is also told what each assistant may read and which models are in use, so it can only name real ones.
    expect(JSON.parse(written[0]!.user)).toMatchObject({
      digest, lessonsAlreadyAdopted: expect.any(Array),
      profiles: { readToolNames: expect.arrayContaining(['list_session_reports', 'get_online_metrics']), modelsInUse: expect.arrayContaining(['MOCK/online/code']), assistants: { online: { reads: reads.online }, finance: { reads: reads.finance } } },
    });

    // Stored: the review with its digest, the typed recommendations, a report message, one adopt_change approval.
    const stored = (await pool.query('select * from public.manager_reviews where task_id = $1', [task.id])).rows[0];
    expect(stored).toMatchObject({ review_key: `review:${task.id}`, digest, model: 'MOCK/MOCK/manager/review' });
    expect(stored.report_count).toBeGreaterThanOrEqual(1);
    const recs = (await pool.query('select id, rank, assistant_id, kind, change, status, decided_by, applied_by, applied_version, detail from public.recommendations where review_id = $1 order by rank', [stored.id])).rows;
    const financeNow = profileTables.row('finance');
    expect(recs).toEqual([
      { id: recs[0].id, rank: 1, assistant_id: 'finance', kind: 'lesson', change: r.lesson, status: 'adopted', decided_by: null, applied_by: 'manager', applied_version: financeNow.version, detail: {} },
      { id: recs[1].id, rank: 2, assistant_id: 'online', kind: 'reads', change: r.readsLine, status: 'proposed', decided_by: null, applied_by: null, applied_version: null, detail: { reads: { add: ['usage_summary'], remove: [] } } },
    ]);

    // The manager wrote the lesson into finance's profile as a new version made by 'manager', and left online's alone.
    expect(profileTables.versionsOf('finance')).toHaveLength(financeBefore + 1);
    expect(profileTables.versionsOf('online')).toHaveLength(onlineBefore);
    const made = profileTables.versionsOf('finance').at(-1)!;
    expect(made).toMatchObject({ madeBy: 'manager', version: financeNow.version, change: { kind: 'lesson', recommendation: recs[0].id, review: stored.id, rank: 1 } });
    expect(made.reason).toMatch(/^The HQ Manager applied a lesson: /);
    expect(profileTables.lessons('finance').at(-1)).toMatchObject({ text: r.lesson, source: recs[0].id, by: 'manager' });
    expect(deps.brain.memory('finance').lessons().map((m) => m.content)).toContain(r.lesson); // H-MEM, a cache of the database
    expect(deps.brain.memory('manager').lessons().map((m) => m.content)).toContain(`For finance: ${r.lesson}`);
    const message = (await pool.query('select id, from_assistant, to_assistant, kind, body from public.assistant_messages where id = $1', [stored.message_id])).rows[0];
    expect(message).toMatchObject({ from_assistant: 'manager', to_assistant: 'owner', kind: 'report', body: { reviewId: stored.id } });
    const approval = (await pool.query(`select action, status, extract(epoch from (expires_at - created_at))::int as ttl, approver_person_id from public.approvals where message_id = $1`, [message.id])).rows;
    expect(approval).toEqual([{ action: 'adopt_change', status: 'pending', ttl: 12 * 3600, approver_person_id: 'demo-p-owner' }]);
    const sent = (await pool.query(`select from_assistant, body from public.outbox where dedupe_key = $1`, [`review-sms:${stored.id}`])).rows;
    expect(sent).toHaveLength(1);
    expect(sent[0].from_assistant).toBe('owner'); // the manager has no number: the text comes from Owner HQ
    expect(sent[0].body).not.toContain(code); // blanked once handled

    // The reports of the manager task: steps, tokens, Code Mode usage.
    const reviewReport = await reportOf(task.id);
    expect(reviewReport).toMatchObject({ assistant_id: 'manager', outcome: 'done', model_calls: 2, input_tokens: 800, output_tokens: 350 });
    expect(reviewReport.steps.map((s: { step: string }) => s.step)).toEqual(['manager.digest', 'manager.review', 'manager.apply']);
    expect(reviewReport.steps[2].detail).toBe(`applied 1 (finance lesson, version ${financeNow.version})`);
    expect(reviewReport.usage.codeMode).toMatchObject({ scripts: 1, toolCalls: 3 });
    expect(reviewReport.suggestions).toEqual([]);

    // ADOPT 2: the code works; the read tool is added to online's profile as a version made by the owner.
    const adoptSid = await textIn(ownerPhone, `ADOPT 2 ${code}`);
    expect(lastTo(ownerPhone)).toBe("Adopted: 2 (online). They're now in place.");
    const after = (await pool.query('select rank, status, decided_by, applied_by, applied_version from public.recommendations where review_id = $1 order by rank', [stored.id])).rows;
    const onlineNow = profileTables.row('online');
    expect(after).toEqual([
      { rank: 1, status: 'adopted', decided_by: null, applied_by: 'manager', applied_version: financeNow.version },
      { rank: 2, status: 'adopted', decided_by: 'demo-p-owner', applied_by: 'owner', applied_version: onlineNow.version },
    ]);
    expect(onlineNow.reads).toEqual([...loadProfiles({}).online.reads, 'usage_summary']);
    expect(profileTables.versionsOf('online')).toHaveLength(onlineBefore + 1);
    expect(profileTables.versionsOf('online').at(-1)).toMatchObject({ madeBy: 'owner', change: { kind: 'reads', recommendation: recs[1].id, reads: { add: ['usage_summary'], remove: [] } } });
    expect(deps.brain.memory('finance').recallDecisions('business question lookup')).toEqual([]); // a lesson is never a decision
    expect(deps.brain.record.audit(2000).some((a) => a.summary.includes('-[adopted]->'))).toBe(true);
    expect((await stepsOf((await taskOfText(adoptSid)).id)).map((s) => [s.step, s.outcome])).toEqual([['approval.adopt', 'ok']]);

    // The same code again is refused (single use) and adopts nothing more; the manager's own change stays as it was.
    await textIn(ownerPhone, `ADOPT 1 ${code}`);
    expect(lastTo(ownerPhone)).toBe("That code didn't work or has expired. Nothing was adopted.");
    expect((await pool.query(`select status, applied_by from public.recommendations where review_id = $1 and rank = 1`, [stored.id])).rows[0]).toEqual({ status: 'adopted', applied_by: 'manager' });

    // The ADOPT task run again (a crash after the code was spent) resumes: same reply, no second version.
    const versionsBefore = profileTables.history.length;
    const smsBefore = sms.length;
    expect((await handleTask(await taskOfText(adoptSid), current())).status).toBe('done');
    await runUntilIdle(current());
    expect(profileTables.history).toHaveLength(versionsBefore);
    expect(sms.length).toBe(smsBefore);

    // The next review tells the writer which changes are already in force, the manager's own among them.
    model.script('manager.review', makeReview().json);
    await textIn(ownerPhone, 'REVIEW');
    const next = JSON.parse(model.of('manager.review').at(-1)!.user) as { lessonsAlreadyAdopted: { assistant: string; text: string }[] };
    expect(next.lessonsAlreadyAdopted).toContainEqual({ assistant: 'finance', text: r.lesson });
    expect(next.lessonsAlreadyAdopted).toContainEqual({ assistant: 'online', text: r.readsLine });
  });

  it('rejects a review whose number is not in the digest, twice, and tells the owner plainly', async () => {
    const { task } = await askForReview(badReview(), badReview());
    expect(lastTo(ownerPhone)).toBe("The review didn't pass its checks, so I'm not sending it.");
    expect(smsTo(ownerPhone).filter((b) => b.includes('HQ Manager review'))).toEqual([]);
    expect(model.of('manager.review')).toHaveLength(2); // one correction round, then a plain failure
    expect(JSON.parse(model.of('manager.review')[1]!.user).previousAttemptRejectedBecause).toContain('summary: "8" is not a number in the data');
    expect(task).toMatchObject({ status: 'failed' });
    expect(task.last_error).toContain('did not pass its checks');
    expect((await pool.query('select count(*)::int as n from public.manager_reviews where task_id = $1', [task.id])).rows[0].n).toBe(0);
    const steps = await stepsOf(task.id);
    expect(steps.map((s) => [s.step, s.outcome])).toEqual([['manager.digest', 'ok'], ['manager.review', 'refused']]);
    expect(steps[1]).toMatchObject({ input_tokens: 200, output_tokens: 400, detail: expect.stringContaining('attempts 2') });
    const report = await reportOf(task.id);
    expect(report.outcome).toBe('failed');
    expect(report.suggestions[0]).toMatchObject({ kind: 'prompt', about: 'manager' });
  });

  it('rejects a review that makes up a small count just as it rejects a large one', async () => {
    const small = makeReview({ summary: 'Finance had 3 failures.' }).json; // the digest has no 3
    const { task } = await askForReview(small, small);
    expect(lastTo(ownerPhone)).toBe("The review didn't pass its checks, so I'm not sending it.");
    expect(smsTo(ownerPhone).filter((b) => b.includes('HQ Manager review'))).toEqual([]);
    expect(JSON.parse(model.of('manager.review')[1]!.user).previousAttemptRejectedBecause).toContain('summary: "3" is not a number in the data');
    expect(task).toMatchObject({ status: 'failed' });
  });

  it('accepts a review that passes on the correction round, and reports that it needed one', async () => {
    const { task } = await askForReview(badReview(), makeReview().json);
    expect(lastTo(ownerPhone)).toContain('HQ Manager review (last 24 h)');
    expect(model.of('manager.review')).toHaveLength(2);
    const report = await reportOf(task.id);
    expect(report.summary).toContain('manager.review ok (attempt 2 of 2)');
    expect(report.suggestions).toEqual([{ kind: 'prompt', about: 'manager', text: 'The review writer needed a correction round. First objection: summary: "8" is not a number in the data' }]);
  });

  it('refuses a review that repeats a lesson the owner already adopted', async () => {
    const first = makeReview();
    const { code } = await askForReview(first.json);
    await textIn(ownerPhone, `ADOPT 1 ${code}`); // the owner adopts rank 1
    const repeat = makeReview({ recs: [{ rank: 1, assistant: 'finance', kind: 'lesson', change: first.lesson.toUpperCase(), why: 'Finance used 1500 tokens in.' }] }).json;
    await askForReview(repeat, repeat);
    expect(lastTo(ownerPhone)).toBe("The review didn't pass its checks, so I'm not sending it.");
    expect(model.of('manager.review')).toHaveLength(3); // the first review, then the repeat and its correction round
    expect(JSON.parse(model.of('manager.review').at(-1)!.user).previousAttemptRejectedBecause).toContain('recommendation 1 repeats a lesson the owner already adopted');
  });

  it('runs a retried review once: same review, same code, same change, no second ask of any model', async () => {
    const { code, task } = await askForReview();
    const counts = () => ({ code: codeMode.calls.length, review: model.of('manager.review').length, sms: sms.length, versions: profileTables.history.length });
    const before = counts();
    expect((await handleTask(task, deps)).status).toBe('done');
    await runUntilIdle(deps);
    expect(counts()).toEqual(before);
    const reviews = (await pool.query('select id from public.manager_reviews where review_key = $1', [`review:${task.id}`])).rows;
    expect(reviews).toHaveLength(1);
    expect((await pool.query('select count(*)::int as n from public.recommendations where review_id = $1', [reviews[0].id])).rows[0].n).toBe(2);
    expect((await pool.query(`select count(*)::int as n from public.outbox where dedupe_key = $1`, [`review-sms:${reviews[0].id}`])).rows[0].n).toBe(1);
    await textIn(ownerPhone, `ADOPT 2 ${code}`); // the code that was sent still works
    expect(lastTo(ownerPhone)).toBe("Adopted: 2 (online). They're now in place.");
  });

  it('says plainly when there is no work to review', async () => {
    const future = { ...deps, now: () => new Date('2036-01-01T00:00:00Z') };
    const row = (await pool.query(
      `insert into public.tasks (assistant_id, kind, idempotency_key, payload, status) values ('manager', 'scheduled', $1, $2, 'done') returning id, assistant_id, kind, status, payload, attempts, max_attempts`,
      ['manager-test:' + randomUUID(), { job: 'manager_review', hours: 1, requestedBy: 'demo-p-owner' }],
    )).rows[0] as TaskRow;
    expect(await handleTask(row, future)).toEqual({ status: 'done' });
    await runUntilIdle(deps);
    expect(lastTo(ownerPhone)).toBe('HQ Manager: no assistant work to review in the last 1 hours.');
    expect(codeMode.calls).toHaveLength(0);
    expect(model.calls).toHaveLength(0);
  });

  it('refuses a review window that is not a whole number of hours from 1 to 168', async () => {
    for (const hours of [0, 500, 1.5, '24']) {
      const row = (await pool.query(
        `insert into public.tasks (assistant_id, kind, idempotency_key, payload, status) values ('manager', 'scheduled', $1, $2, 'done') returning id, assistant_id, kind, status, payload, attempts, max_attempts`,
        ['manager-test:' + randomUUID(), { job: 'manager_review', hours, requestedBy: 'demo-p-owner' }],
      )).rows[0] as TaskRow;
      expect(await handleTask(row, deps), String(hours)).toEqual({ status: 'failed', error: 'the review window must be a whole number of hours from 1 to 168' });
    }
    expect(codeMode.calls).toHaveLength(0);
  });

  it('tells the owner when the digest cannot be made, and fails the task with that reason', async () => {
    codeMode.respond(() => okResult(null, { ok: false, result: null, error: 'the script ran past its time limit', attempts: 2, toolCalls: 1, resultChars: 0 }));
    model.script('manager.review', makeReview().json);
    await textIn(ownerPhone, 'REVIEW');
    expect(lastTo(ownerPhone)).toBe("I couldn't review the work just now: the script ran past its time limit");
    const task = await latestManagerTask();
    expect(task.status).toBe('failed');
    expect(task.last_error).toBe('the digest failed: the script ran past its time limit');
    expect(model.of('manager.review')).toHaveLength(0);
    const steps = await stepsOf(task.id);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ step: 'manager.digest', outcome: 'failed', input_tokens: 700, output_tokens: 150 });
    expect(steps[0]!.detail).toBe('code mode: attempts 2, toolCalls 1, resultChars 0; error: the script ran past its time limit');
    expect((await reportOf(task.id)).suggestions).toEqual([{ kind: 'reliability', about: 'manager', text: expect.stringContaining('manager.digest failed') }]);
  });

  it('fails plainly, with a cost suggestion, when the review model hits its budget', async () => {
    const { task } = await askForReview(); // a review before, so the failing one below must be a different task
    model.script('manager.review', new Error('daily token budget reached (990000 of 1000000)'));
    await textIn(ownerPhone, 'REVIEW');
    expect(lastTo(ownerPhone)).toBe("I couldn't write the review just now: daily token budget reached (990000 of 1000000)");
    const failed = await latestManagerTask();
    expect(failed.id).not.toBe(task.id);
    expect(failed.status).toBe('failed');
    expect((await reportOf(failed.id)).suggestions).toEqual([{ kind: 'cost', about: 'manager', text: expect.stringContaining('daily token budget reached') }]);
  });

  it('lets only the owner ask for a review', async () => {
    const messageSid = await textIn(financePhone, 'review');
    expect(lastTo(financePhone)).toBe('Only the owner can ask for a review.');
    expect(codeMode.calls).toHaveLength(0);
    const task = await taskOfText(messageSid);
    expect((await pool.query('select count(*)::int as n from public.tasks where idempotency_key = $1', [`review:${task.id}`])).rows[0].n).toBe(0);
    expect((await stepsOf(task.id))[0]).toMatchObject({ step: 'manager.request', outcome: 'refused' });
  });

  it('answers a question about the assistants through the manager\'s own Q&A, prefixed [Manager]; a review is asked for with REVIEW', async () => {
    const facts = { byAssistant: [{ assistant: 'finance', tasks: 5, failed: 1 }] };
    codeMode.respond(() => okResult(facts));
    model.script('front-door', router('manager', 'question'));
    model.script('manager.answer', 'Finance did 5 tasks and 1 failed.');
    const messageSid = await textIn(ownerPhone, 'How are my assistants doing lately?');
    expect(lastTo(ownerPhone)).toBe('[Manager] Finance did 5 tasks and 1 failed.');
    expect(codeMode.calls[0]).toMatchObject({ purpose: 'manager.lookup', model: 'MOCK/manager/code', skill: skillOf('manager') });
    expect(codeMode.calls[0]!.tools.map((t) => t.name)).toEqual(reads.manager);
    expect(model.of('manager.answer')[0]).toMatchObject({ model: 'MOCK/manager/answer' });
    expect(model.of('manager.review')).toHaveLength(0);
    const task = await taskOfText(messageSid);
    expect((await pool.query('select count(*)::int as n from public.tasks where idempotency_key = $1', [`review:${task.id}`])).rows[0].n).toBe(0);
    expect((await stepsOf(task.id)).map((s) => [s.step, s.outcome])).toEqual([['front-door.screen', 'ok'], ['front-door', 'ok'], ['manager.lookup', 'ok'], ['manager.answer', 'ok']]);
  });

  it('turns away a code under the wrong command word, both ways, without spending it', async () => {
    const r = makeReview();
    const { code: adopt } = await askForReview(r.json);
    expect(adopt).toMatch(/^\d{6}$/);
    model.script('front-door', router('finance', 'plans'));
    model.script('finance.plans', JSON.stringify(validPlans));
    await textIn(ownerPhone, 'Ask the finance assistant for three plans to double profit.');
    const send = /SEND <1-3> (\d{6})/.exec(lastTo(ownerPhone))?.[1] ?? '';
    expect(send).toMatch(/^\d{6}$/);

    await textIn(ownerPhone, `ADOPT 1 ${send}`);
    expect(lastTo(ownerPhone)).toBe('That code is for sending a plan: reply SEND <1-3> <code>. Nothing was adopted.');
    await textIn(ownerPhone, `SEND 1 ${adopt}`);
    expect(lastTo(ownerPhone)).toBe('That code is for adopting a review recommendation: reply ADOPT <1-3> <code>. Nothing was sent.');
    await textIn(ownerPhone, `CONFIRM ${adopt}`);
    expect(lastTo(ownerPhone)).toBe('That code is for adopting a review recommendation: reply ADOPT <1-3> <code>. Nothing was recorded.');

    await textIn(ownerPhone, `ADOPT 1 2 ${adopt}`); // neither code was spent
    expect(lastTo(ownerPhone)).toBe("Adopted: 1 (finance), 2 (online). They're now in place.");
    await textIn(ownerPhone, `SEND 1 ${send}`);
    expect(lastTo(ownerPhone)).toContain('Sent plan 1');

    // The lesson the owner adopted reaches the plan writer as ownerLessons.
    await textIn(ownerPhone, 'Ask the finance assistant for three safer plans for next month.');
    const lastPlanCall = model.of('finance.plans').at(-1)!;
    expect(JSON.parse(lastPlanCall.user).ownerLessons).toContain(r.lesson);
  });

  it('says which ranks were not adopted, and (with the rule on) which the manager had already applied', async () => {
    // Merge wave 1, item d: a rank the review lacks is refused whole BEFORE the code is spent (as APPROVE does with
    // peek_approval_code), so one wrong digit never costs the owner his code.
    const { code } = await askForReview();
    const adoptSid = await textIn(ownerPhone, `ADOPT 2,3 ${code}`);
    expect(lastTo(ownerPhone)).toBe('This review has no open recommendation 3. Nothing was adopted, and your code still works.');
    expect((await stepsOf((await taskOfText(adoptSid)).id)).map((s) => [s.step, s.outcome, s.detail])).toEqual([['approval.adopt', 'refused', 'the review has no open recommendation 3; the code was not spent']]);
    await textIn(ownerPhone, `ADOPT 2 ${code}`); // the same code still works
    expect(lastTo(ownerPhone)).toBe("Adopted: 2 (online). They're now in place.");
    const again = await askForReview();
    await textIn(ownerPhone, `ADOPT 3 ${again.code}`);
    expect(lastTo(ownerPhone)).toBe('This review has no open recommendation 3. Nothing was adopted, and your code still works.');
    // With the rule on, rank 1 is a lesson the manager applied without a code: the owner's code does not need to, and does not, redo it.
    use.rule = true;
    const third = await askForReview();
    const versions = profileTables.history.length;
    await textIn(ownerPhone, `ADOPT 1 2 ${third.code}`);
    expect(lastTo(ownerPhone)).toBe("Adopted: 2 (online). Already in place, applied by the HQ Manager: 1 (finance). They're now in place.");
    expect(profileTables.history).toHaveLength(versions); // online already reads it (rank 2 above): nothing is written, and rank 1 is not redone
    const latest = (await pool.query(`select status, applied_by, applied_version from public.recommendations where rank = 2 and assistant_id = 'online' order by created_at desc limit 1`)).rows[0];
    expect(latest).toEqual({ status: 'adopted', applied_by: 'owner', applied_version: null }); // in force, and no version was needed
  });

  // Second-key review of merge wave 1. A recommendation the program closed (listed under "I did not apply") passed the
  // look before the spend, so ADOPT 1,2 spent the code on a half approval. And after the spend, ADOPT adopted the ranks
  // that existed where APPROVE records nothing: the same text got two outcomes depending on timing.
  describe('ADOPT is applied whole or not at all', () => {
    const recsOf = async (task: TaskRow) => (await pool.query(
      `select r.rank, r.status from public.recommendations r join public.manager_reviews m on m.id = r.review_id where m.review_key = $1 order by r.rank`, [`review:${task.id}`])).rows;
    const approvalOf = async (task: TaskRow) => (await pool.query(
      `select a.status, a.failed_attempts from public.approvals a join public.manager_reviews m on m.message_id = a.message_id where m.review_key = $1`, [`review:${task.id}`])).rows;
    const outcomeOf = async (messageSid: string) => (await pool.query('select status, last_error from public.tasks where idempotency_key = $1', ['sms:' + messageSid])).rows[0];

    it('refuses a rank the program closed before the code is spent, and the same code then adopts an open one', async () => {
      const { code, task } = await askForReview();
      await pool.query(
        `update public.recommendations set status = 'expired', detail = detail || '{"refused":"closed by the test"}'::jsonb
          where rank = 1 and review_id = (select id from public.manager_reviews where review_key = $1)`, [`review:${task.id}`]);
      const sid = await textIn(ownerPhone, `ADOPT 1,2 ${code}`);
      expect(lastTo(ownerPhone)).toBe('This review has no open recommendation 1. Nothing was adopted, and your code still works.');
      expect((await stepsOf((await taskOfText(sid)).id)).map((s) => [s.outcome, s.detail])).toEqual([['refused', 'the review has no open recommendation 1; the code was not spent']]);
      expect(await recsOf(task)).toEqual([{ rank: 1, status: 'expired' }, { rank: 2, status: 'proposed' }]);
      expect(await approvalOf(task)).toEqual([{ status: 'pending', failed_attempts: 0 }]);
      await textIn(ownerPhone, `ADOPT 2 ${code}`);
      expect(lastTo(ownerPhone)).toBe("Adopted: 2 (online). They're now in place.");
    });

    it('adopts nothing when a spent code finds a rank missing (a state the look before spending prevents)', async () => {
      const { code, task } = await askForReview();
      const store = deps.store;
      deps.store = { ...store, peekApprovalCode: async () => null }; // as if the look found nothing: the spend goes ahead
      try {
        const sid = await textIn(ownerPhone, `ADOPT 2,3 ${code}`);
        const error = 'the review has no recommendation 3, though the code was spent for it: nothing was adopted';
        expect(lastTo(ownerPhone)).toBe('This review has no recommendation 3, and the code was already used up, so nothing was adopted. Text REVIEW for a new review and code.');
        expect(await outcomeOf(sid)).toEqual({ status: 'failed', last_error: error });
        expect((await stepsOf((await taskOfText(sid)).id)).map((s) => [s.outcome, s.detail])).toEqual([['failed', error]]);
        expect(await recsOf(task)).toEqual([{ rank: 1, status: 'proposed' }, { rank: 2, status: 'proposed' }]);
        expect(await approvalOf(task)).toMatchObject([{ status: 'signed' }]);
      } finally {
        deps.store = store;
      }
    });

    it('adopts nothing when the code spent is not the one the look checked', async () => {
      const first = await askForReview();
      const second = await askForReview();
      const store = deps.store;
      // The look sees the first review's code (rank 2 open there); the spend then finds the second review's.
      deps.store = { ...store, peekApprovalCode: (a) => store.peekApprovalCode({ ...a, code: first.code }) };
      try {
        const sid = await textIn(ownerPhone, `ADOPT 2 ${second.code}`);
        const error = 'the code was spent for another message than the one checked before spending: nothing was adopted';
        expect(lastTo(ownerPhone)).toBe('Your code was used up, but not for the review it was checked against, so nothing was adopted. Text REVIEW for a new review and code.');
        expect(await outcomeOf(sid)).toEqual({ status: 'failed', last_error: error });
        expect(await recsOf(second.task)).toEqual([{ rank: 1, status: 'proposed' }, { rank: 2, status: 'proposed' }]);
        expect(await recsOf(first.task)).toEqual([{ rank: 1, status: 'proposed' }, { rank: 2, status: 'proposed' }]);
      } finally {
        deps.store = store;
      }
    });
  });

  describe('questions answered through Code Mode', () => {
    it('answers the owner: lookup with the owner\'s tools, one worded answer, numbers checked against the result', async () => {
      const facts = { tasks: 12, failed: 1 };
      const chars = JSON.stringify(facts).length;
      codeMode.respond(() => okResult(facts));
      model.script('front-door', router('owner', 'status'));
      model.script('owner.answer', 'Finance did 12 tasks and 1 failed.');
      const messageSid = await textIn(ownerPhone, 'How did finance do today?');
      expect(lastTo(ownerPhone)).toBe('Finance did 12 tasks and 1 failed.');
      expect(codeMode.calls).toHaveLength(1);
      expect(codeMode.calls[0]).toMatchObject({ purpose: 'owner.lookup', model: 'MOCK/owner/code', skill: skillOf('owner'), question: 'How did finance do today?' });
      expect(codeMode.calls[0]!.tools.map((t) => t.name)).toEqual(reads.owner);
      const answer = model.of('owner.answer');
      expect(answer).toHaveLength(1);
      expect(answer[0]).toMatchObject({ model: 'MOCK/owner/answer', thinking: false, json: false, maxTokens: 400 });
      expect(answer[0]!.system).toBe(`${skillOf('owner')}\n\n${ANSWER_RULES}`);
      expect(JSON.parse(answer[0]!.user)).toEqual({ question: 'How did finance do today?', facts });
      const steps = await stepsOf((await taskOfText(messageSid)).id);
      expect(steps.map((s) => [s.step, s.outcome])).toEqual([['front-door.screen', 'ok'], ['front-door', 'ok'], ['owner.lookup', 'ok'], ['owner.answer', 'ok']]);
      expect(steps[0]).toMatchObject({ step: 'front-door.screen', model: null, detail: 'screen off' });
      expect(steps[2]).toMatchObject({ input_tokens: 700, output_tokens: 150, detail: `code mode: attempts 1, toolCalls 3, resultChars ${chars}, untraced 0` });
      expect(steps[3]).toMatchObject({ input_tokens: 100, output_tokens: 200 });
      expect((await reportOf((await taskOfText(messageSid)).id)).usage.codeMode).toEqual({ scripts: 1, toolCalls: 3, resultChars: chars });
    });

    it('sends the facts as they are, and records a refusal, when the answer holds a number the facts do not, twice', async () => {
      codeMode.respond(() => okResult({ tasks: 12, failed: 1 }));
      model.script('front-door', router('owner'));
      model.script('owner.answer', 'Finance did 9 tasks.');
      const messageSid = await textIn(ownerPhone, 'How did finance do today?');
      expect(lastTo(ownerPhone)).toBe("Here's what I found: tasks: 12; failed: 1");
      expect(model.of('owner.answer')).toHaveLength(2);
      const steps = await stepsOf((await taskOfText(messageSid)).id);
      expect(steps.at(-1)).toMatchObject({ step: 'owner.answer', outcome: 'refused', detail: 'answer: "9" is not a number in the data', input_tokens: 200, output_tokens: 400 });
      expect((await reportOf((await taskOfText(messageSid)).id)).suggestions[0]).toMatchObject({ kind: 'prompt', about: 'owner' });
    });

    it('sends an answer that passes on the correction round, which names the numbers that failed', async () => {
      codeMode.respond(() => okResult({ latestProposal: null }));
      model.script('front-door', router('owner'));
      model.script('owner.answer', 'The latest proposal cited 4.2% and 3.8%.', 'There is no proposal yet.');
      const messageSid = await textIn(ownerPhone, 'What did the latest proposal cite?');
      expect(lastTo(ownerPhone)).toBe('There is no proposal yet.');
      const [first, second] = model.of('owner.answer');
      expect(JSON.parse(first!.user)).not.toHaveProperty('correction');
      expect(JSON.parse(second!.user).correction).toMatch(/^Your last answer used numbers that are not in the facts \(answer: "4\.2%" is not a number in the data/);
      expect((await stepsOf((await taskOfText(messageSid)).id)).at(-1)).toMatchObject({
        step: 'owner.answer', outcome: 'ok', input_tokens: 200, output_tokens: 400, detail: '25 characters; passed on the correction round',
      });
    });

    it('does not text the owner a made-up small count: 0 pending approvals is never "2"', async () => {
      codeMode.respond(() => okResult({ pendingApprovals: 0, openTasks: 4 }));
      model.script('front-door', router('owner', 'status'));
      model.script('owner.answer', 'You have 2 pending approvals.');
      const messageSid = await textIn(ownerPhone, 'Is anything waiting on me?');
      expect(lastTo(ownerPhone)).toBe("Here's what I found: pendingApprovals: 0; openTasks: 4");
      expect((await stepsOf((await taskOfText(messageSid)).id)).at(-1)).toMatchObject({ step: 'owner.answer', outcome: 'refused', detail: 'answer: "2" is not a number in the data' });
    });

    it('sends the facts as they are when the answer model fails', async () => {
      codeMode.respond(() => okResult({ tasks: 12 }));
      model.script('front-door', router('owner'));
      model.script('owner.answer', new Error('nvidia request failed; no fallback model was used'));
      const messageSid = await textIn(ownerPhone, 'How did finance do today?');
      expect(lastTo(ownerPhone)).toBe("Here's what I found: tasks: 12");
      expect((await stepsOf((await taskOfText(messageSid)).id)).at(-1)).toMatchObject({ outcome: 'refused', detail: 'the answer model failed: nvidia request failed; no fallback model was used' });
    });

    it('says plainly when the lookup fails, or Code Mode is not connected', async () => {
      codeMode.respond(() => okResult(null, { ok: false, result: null, error: 'the script used a tool that does not exist', attempts: 2 }));
      model.script('front-door', router('owner', 'status'));
      const messageSid = await textIn(ownerPhone, 'How did finance do today?');
      expect(lastTo(ownerPhone)).toBe("I couldn't look that up: the script used a tool that does not exist");
      expect(model.of('owner.answer')).toHaveLength(0);
      expect((await taskOfText(messageSid)).status).toBe('failed');

      const saved = deps.codeMode;
      deps.codeMode = null;
      try {
        await textIn(ownerPhone, 'And today?');
        expect(lastTo(ownerPhone)).toBe("I couldn't look that up: Code Mode isn't connected on this machine");
      } finally {
        deps.codeMode = saved;
      }
    });

    it('answers the finance owner directly with the finance tools, without the front door', async () => {
      codeMode.respond(() => okResult({ view: 'fortune_demo_finance_mart', revenue: 12400 }));
      model.script('finance.answer', 'Online Mazali revenue is 12400 dollars.');
      await textIn(financePhone, 'What is Mazali revenue?');
      expect(lastTo(financePhone)).toBe('Online Mazali revenue is 12400 dollars.');
      expect(model.of('front-door')).toHaveLength(0);
      expect(codeMode.calls[0]).toMatchObject({ purpose: 'finance.lookup', model: 'MOCK/finance/code', skill: skillOf('finance') });
      expect(codeMode.calls[0]!.tools.map((t) => t.name)).toEqual(reads.finance);
      expect(model.of('finance.answer')[0]).toMatchObject({ model: 'MOCK/finance/answer' });
    });

    it('answers a department head from her own assistant\'s tools, never the owner\'s', async () => {
      const salonPhone = '+15550111003';
      codeMode.respond(() => okResult({ view: 'fortune_demo_finance_mart', washSet: 6200 }));
      model.script('front-door', router('owner', 'status'));
      model.script('salon.answer', 'Wash and set brought in 6200 dollars.');
      await textIn(salonPhone, 'How did finance do today?');
      expect(lastTo(salonPhone)).toBe('Wash and set brought in 6200 dollars.');
      expect(codeMode.calls[0]).toMatchObject({ purpose: 'salon.lookup', model: 'MOCK/salon/code', skill: skillOf('salon') });
      expect(codeMode.calls[0]!.tools.map((t) => t.name)).toEqual(reads.salon);
    });

    it('tells a department head that plans for another department are the owner\'s to ask for', async () => {
      const salonPhone = '+15550111003';
      model.script('front-door', router('online', 'plans'));
      await textIn(salonPhone, 'Get the online team three plans.');
      expect(lastTo(salonPhone)).toBe('The owner asks the departments for plans. I can answer questions about your own numbers.');
      expect(codeMode.calls).toHaveLength(0);
    });
  });
});
