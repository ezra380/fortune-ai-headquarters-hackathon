import { randomInt, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DIVISION_ASSISTANT, WORKER_IDS, workerDivision, type Attention, type DataPort, type Division, type Metric, type MetricInfo, type ModelPort, type RowRead, type WorkerId } from '@fahq/contracts';
import type { Brain } from '@fahq/brain';
import { handleTask, type WorkerDeps } from '../src/flows.ts';
import { createStore, type TaskRow } from '../src/store.ts';
import { WORKER_RULES, enqueueWorkers } from '../src/workers.ts';
import { scriptedModel } from './fixtures.ts';
import { dbUrl, localApi } from './localdb.ts';

// A division's daily workers end to end on the real local database. Only the model and the Zetaris adapter are fakes (a
// port with version 2's shape: division reads with a catalog that says who reads what, and row reads with totals). Every
// run is for a day in the 2100s that no other run of this test used. Nothing is texted: a worker's report is stored only.

const api = localApi();
if (!api) console.warn('SKIPPED worker tests: needs local Supabase (npm run db:start)');

const pool = new pg.Pool({ connectionString: dbUrl, max: 3 });
afterAll(async () => pool.end());

let freeDays: string[] = [];
const freshDate = () => {
  const day = freeDays.pop();
  if (!day) throw new Error('no free day is left for this test');
  return day;
};
async function pickFreeDays(count: number): Promise<string[]> {
  const taken = new Set((await pool.query(
    `select to_char(report_date, 'YYYY-MM-DD') as day from public.worker_reports where report_date between '2100-01-01' and '2199-12-31'
     union select substring(idempotency_key from '[0-9]{4}-[0-9]{2}-[0-9]{2}') from public.tasks where idempotency_key like 'worker:%:21__-__-__%'`)).rows.map((r) => r.day as string));
  const days = new Set<string>();
  while (days.size < count) {
    const day = new Date(Date.UTC(2100, 0, 1) + randomInt(0, 36_500) * 86_400_000).toISOString().slice(0, 10);
    if (!taken.has(day)) days.add(day);
  }
  return [...days];
}

// ---- A version 2 data port, faked -----------------------------------------------------------------------

const source = { system: 'zetaris' as const, view: 'fortune_demo_finance_mart', queryHash: 'd'.repeat(64), asOf: '2026-10-26T12:00:00Z' };
const DEFS: [id: string, label: string, value: number, unit: Metric['unit'], divisions: Division[]][] = [
  ['m:online.revenue.total', 'Online revenue', 48200, 'usd', ['online', 'finance', 'hq']],
  ['m:online.email.revenue', 'Email revenue', 5300, 'usd', ['online', 'finance']],
  ['m:online.email.sends', 'Email sends', 21400, 'count', ['online']],
  ['m:online.ads.google.spend', 'Google ad spend', 1800, 'usd', ['online', 'finance']],
  ['m:online.ads.google.roas', 'Google ad return', 2.4, 'ratio', ['online', 'finance']],
  ['m:online.budget.google.cap', 'Google budget', 2500, 'usd', ['finance']],
  ['m:online.budget.google.room', 'Google budget left', 700, 'usd', ['finance', 'hq']],
  ['m:online.budget.google.used', 'Google budget used', 0.72, 'ratio', ['finance', 'hq']],
  ['m:online.service.replied_1h.share', 'Replied within an hour', 0.61, 'ratio', ['online']],
  ['m:online.service.waiting_now.count', 'Messages waiting', 14, 'count', ['online', 'hq']],
  ['m:online.service.missed_sale_intent.count', 'Missed buyers', 3, 'count', ['online', 'hq']],
  ['m:salon.revenue.total', 'Salon revenue', 52000, 'usd', ['salon', 'finance', 'hq']],
  ['m:salon.appointments.count', 'Salon appointments', 310, 'count', ['salon', 'finance']],
  ['m:salon.repairs.revenue', 'Repairs revenue', 4100, 'usd', ['salon', 'finance']],
  ['m:salon.repairs.open.count', 'Open repairs', 23, 'count', ['salon', 'hq']],
  ['m:salon.repairs.open_over_14d.count', 'Repairs open over two weeks', 6, 'count', ['salon', 'hq']],
  ['m:salon.repairs.within_14d.share', 'Repairs done within two weeks', 0.74, 'ratio', ['salon', 'hq']],
];
const businessOf = (id: string) => id.slice(2, id.indexOf('.')) as 'salon' | 'online';
const catalog: MetricInfo[] = DEFS.map(([id, label, , unit, divisions]) => ({ id, label, unit, business: businessOf(id), divisions }));
const metricOf = ([id, label, value, unit]: (typeof DEFS)[number]): Metric => ({ id, label, value, unit, business: businessOf(id), period: '2026-09', source });
const ROW_TOTALS: Record<string, Record<string, number | Record<string, number>>> = {
  'repairs:late': { count: 6, quoteUsd: 1450, costUsd: 610 },
  'repairs:done': { count: 17, quoteUsd: 3900, costUsd: 1500 },
  waiting: { count: 14, byChannel: { email: 9, chat: 5 }, byIntent: { sale: 3, order: 11 } },
};

const reads = (division: string) => ({ finance: ['get_finance_metrics', 'get_budget_room'], online: ['get_online_metrics'], salon: ['get_salon_metrics'] } as Record<string, string[]>)[division] ?? [];

describe.skipIf(!api)('daily workers (real database; the model and the data port scripted)', () => {
  const attention: Partial<Record<Division, Attention[]>> = {};
  /** Metrics a division read hands over that its division does not read (a port that leaks). */
  const leaks: Partial<Record<Division, Metric[]>> = {};
  const outbox: string[] = [];
  const rowReads: RowRead[] = [];
  let failRows: Error | null = null;
  let deps: WorkerDeps;
  let model: ReturnType<typeof scriptedModel>;

  beforeAll(async () => {
    freeDays = await pickFreeDays(100);
    const real = createStore(api!.url, api!.key);
    const data: DataPort = {
      health: async () => ({ ok: true, detail: 'MOCK data' }),
      getFinanceMetrics: async () => { throw new Error('a version 2 port is read by division'); },
      getDivisionMetrics: async ({ division }) => ({
        division, metrics: [...DEFS.filter((d) => d[4].includes(division)).map(metricOf), ...(leaks[division] ?? [])],
        attention: attention[division] ?? [], queryHash: source.queryHash, view: source.view,
      }),
      readRows: async (r) => {
        rowReads.push(r);
        if (failRows) throw failRows;
        const key = r.table === 'repairs' ? `repairs:${r.status}` : r.table;
        return { table: r.table, rows: [], totals: ROW_TOTALS[key] ?? {}, dataDate: '2026-10-26', queryHash: 'e'.repeat(64), view: 'fortune_demo_rows' };
      },
      catalog,
    };
    deps = {
      store: { ...real, addOutbox: async (o) => { outbox.push(o.dedupeKey); return real.addOutbox(o); } },
      brain: { memory: () => ({ lessons: () => [] }) } as unknown as Brain,
      models: { nvidia: undefined as unknown as ModelPort, planModel: 'MOCK/plans', routerModel: 'MOCK/router' },
      guard: null,
      data,
      delivery: null,
      codeMode: null,
      profiles: { skill: (id) => `SKILL(${id})`, model: (id, job) => `MOCK/${id}/${job}`, reads },
      now: () => new Date(),
      worker: 'workers-test',
      live: false,
      period: '2026-09',
      smsLive: false,
      printers: {},
      printDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fahq-workers-print-')),
    };
  });

  beforeEach(() => {
    for (const k of Object.keys(attention)) delete attention[k as Division];
    for (const k of Object.keys(leaks)) delete leaks[k as Division];
    outbox.length = 0;
    rowReads.length = 0;
    failRows = null;
    model = scriptedModel();
    deps.models = { ...deps.models, nvidia: model.port };
  });

  const taskOf = async (assistant: string, payload: Record<string, unknown>, key = `workers-test:${randomUUID()}`): Promise<TaskRow> => {
    const id = (await pool.query(
      `insert into public.tasks (assistant_id, kind, idempotency_key, payload, status) values ($1, 'scheduled', $2, $3::jsonb, 'done') returning id`,
      [assistant, key, JSON.stringify(payload)])).rows[0].id as string;
    return { id, assistant_id: assistant as TaskRow['assistant_id'], kind: 'scheduled', status: 'done', payload, attempts: 1, max_attempts: 3 };
  };
  const workerTask = (id: WorkerId, date: string, over: Record<string, unknown> = {}) =>
    taskOf(DIVISION_ASSISTANT[workerDivision(id)], { job: 'division_worker', worker: id, date, ...over }, `worker:${id}:${date}${over.request ? `:${over.request}` : ''}`);
  const rows = async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows;
  const stored = async (key: string) => (await rows("select *, to_char(report_date, 'YYYY-MM-DD') as day from public.worker_reports where report_key = $1", [key]))[0];
  const stepsOf = async (taskId: string) => rows('select step, outcome, assistant_id, model, data_source, detail from public.receipts where task_id = $1 order by id', [taskId]);
  const run = async (id: WorkerId, date = freshDate()) => {
    const task = await workerTask(id, date);
    const outcome = await handleTask(task, deps);
    const key = `worker:${id}:${date}`;
    return { task, outcome, key, date, row: await stored(key) };
  };
  const given = (purpose: string, n = 0) => JSON.parse(model.of(purpose)[n]!.user);

  const googleWords = {
    headline: 'Google ads return 2.4x on $1,800 of spend; $700 of budget room is left.',
    findings: [
      { text: 'Google ads returned 2.4x on $1,800 of spend.', cites: ['m:online.ads.google.roas', 'm:online.ads.google.spend'] },
      { text: '72% of the Google budget is used, with $700 left.', cites: ['m:online.budget.google.used', 'm:online.budget.google.room'] },
    ],
  };

  it("Finance (George): the Google worker reads its numbers and the budget room, one model call writes it, and it is stored with the program's status", async () => {
    attention.finance = [
      { metricId: 'm:online.budget.google.used', level: 'watch', rule: 'Most of the Google budget is used.' },
      { metricId: 'm:salon.revenue.total', level: 'act', rule: 'Salon revenue fell.' }, // not this worker's: it does not set its status
    ];
    model.script('finance.google_ads.report', JSON.stringify({ ...googleWords, status: 'normal' })); // a status from the model is ignored
    const { task, outcome, row, date } = await run('finance.google_ads');
    expect(outcome).toEqual({ status: 'done' });

    const ids = ['m:online.ads.google.spend', 'm:online.ads.google.roas', 'm:online.budget.google.cap', 'm:online.budget.google.room', 'm:online.budget.google.used'];
    expect(row).toMatchObject({
      worker_id: 'finance.google_ads', division: 'finance', day: date, period: '2026-09', status: 'watch', written_by: 'model',
      data_source: 'fortune_demo_finance_mart#dddddddddddd', task_id: task.id,
    });
    expect(row.report).toMatchObject({
      workerId: 'finance.google_ads', day: date, period: '2026-09', status: 'watch', writtenBy: 'model', ...googleWords,
      attention: [attention.finance[0]], rows: [{ read: 'budget_room.google', totals: { capUsd: 2500, spendUsd: 1800, roomUsd: 700, used: 0.72 } }],
      dataSource: 'fortune_demo_finance_mart#dddddddddddd',
    });
    expect(row.report.metrics.map((m: Metric) => m.id)).toEqual(ids);
    expect(row.report).not.toHaveProperty('status', 'normal');

    // One model call: the brief writer's model, reasoning on, JSON, with the division's skill and the worker's rules.
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]).toMatchObject({ purpose: 'finance.google_ads.report', model: 'MOCK/plans', json: true, thinking: true, system: `SKILL(finance)\n\n${WORKER_RULES}` });
    const input = given('finance.google_ads.report');
    expect(input).toMatchObject({ worker: 'finance.google_ads', manager: 'George', status: 'watch', period: '2026-09', attention: [attention.finance[0]], ownerLessons: [] });
    expect(input.metrics.map((m: { id: string }) => m.id)).toEqual(ids);
    expect(input.rows).toEqual([{ read: 'budget_room.google', totals: { capUsd: 2500, spendUsd: 1800, roomUsd: 700, used: 0.72 } }]);
    expect(`${model.calls[0]!.system}\n${model.calls[0]!.user}`).not.toMatch(/\+1\d{10}|(?<!\d)\d{6}(?!\d)|@/);

    // A receipt for every step, the data source on the read; and no text, no printout.
    expect((await stepsOf(task.id)).map((s) => [s.step, s.outcome, s.assistant_id])).toEqual([
      ['worker.data', 'ok', 'finance'], ['worker.rows', 'ok', 'finance'], ['worker.write', 'ok', 'finance'], ['worker.save', 'ok', 'finance'],
    ]);
    const steps = await stepsOf(task.id);
    expect(steps[0]).toMatchObject({ data_source: 'zetaris:fortune_demo_finance_mart#dddddddddddd', detail: '5 of 10 finance metrics are this worker\'s; 1 attention rules fired on them' });
    expect(steps[1]!.detail).toBe('budget_room.google: 4 totals');
    expect(steps[2]).toMatchObject({ model: 'MOCK/MOCK/plans', detail: 'attempts 1, 2 findings' });
    expect(outbox).toEqual([]);
  });

  it("Online (Georgette): the messages worker keeps the waiting totals, and an act rule on its metric makes it act", async () => {
    attention.online = [{ metricId: 'm:online.service.missed_sale_intent.count', level: 'act', rule: 'Buyers who asked to buy got no answer.' }];
    const words = {
      headline: '3 buyers went unanswered and 14 messages are waiting.',
      findings: [
        { text: '14 messages are waiting: 9 by email and 5 in chat.', cites: ['m:online.service.waiting_now.count'] },
        { text: '61% got a reply within an hour.', cites: ['m:online.service.replied_1h.share'] },
      ],
    };
    model.script('online.messages.report', JSON.stringify(words));
    const { task, row } = await run('online.messages');
    expect(row).toMatchObject({ division: 'online', status: 'act', written_by: 'model' });
    expect(row.report.rows).toEqual([{ read: 'waiting', totals: { count: 14, 'byChannel.email': 9, 'byChannel.chat': 5, 'byIntent.sale': 3, 'byIntent.order': 11 } }]);
    expect(row.report.metrics.map((m: Metric) => m.id)).toEqual(['m:online.service.replied_1h.share', 'm:online.service.waiting_now.count', 'm:online.service.missed_sale_intent.count']);
    expect(rowReads).toEqual([{ table: 'waiting', olderThanHours: 0, asOf: expect.any(String) }]);
    expect(given('online.messages.report').manager).toBe('Georgette');
    expect((await stepsOf(task.id)).map((s) => s.step)).toEqual(['worker.data', 'worker.rows', 'worker.write', 'worker.save']);
  });

  it("Salon (Cindy): the turnaround worker reads late and done repairs, and says the personalization read is not connected yet", async () => {
    const words = {
      headline: '6 repairs are late.',
      findings: [{ text: '23 repairs are open and 6 are late, with $1,450 quoted on the late ones.', cites: ['m:salon.repairs.open.count', 'm:salon.repairs.open_over_14d.count'] }],
    };
    model.script('salon.turnaround.report', JSON.stringify(words));
    const { task, row } = await run('salon.turnaround');
    expect(row).toMatchObject({ division: 'salon', status: 'normal', written_by: 'model' });
    expect(row.report.rows).toEqual([
      { read: 'repairs_late', totals: { count: 6, quoteUsd: 1450, costUsd: 610 } },
      { read: 'repairs_done', totals: { count: 17, quoteUsd: 3900, costUsd: 1500 } },
    ]);
    expect(row.report.metrics.every((m: Metric) => m.id.startsWith('m:salon.repairs.'))).toBe(true);
    expect(given('salon.turnaround.report').manager).toBe('Cindy');
    const rowsStep = (await stepsOf(task.id)).find((s) => s.step === 'worker.rows')!;
    expect(rowsStep).toMatchObject({ outcome: 'ok', detail: 'repairs_late: 3 totals; repairs_done: 3 totals; personalization_late: not connected yet (the data lane adds it in this wave)' });
  });

  it('a report with a number nobody read is corrected once, then refused, and a program writes it from the rules', async () => {
    attention.finance = [{ metricId: 'm:online.budget.google.used', level: 'act', rule: 'The Google budget is nearly spent.' }];
    model.script('finance.google_ads.report', JSON.stringify({ ...googleWords, headline: 'Google spend reached $9,999.' })); // the last reply repeats
    const { task, outcome, row } = await run('finance.google_ads');
    expect(outcome).toEqual({ status: 'done' });

    const attempts = model.of('finance.google_ads.report');
    expect(attempts).toHaveLength(2);
    expect(JSON.parse(attempts[0]!.user)).not.toHaveProperty('previousAttemptRejectedBecause');
    expect(JSON.parse(attempts[1]!.user).previousAttemptRejectedBecause).toEqual(['headline: "9,999" is not a number in the data']);

    expect(row).toMatchObject({ status: 'act', written_by: 'rule' });
    expect(row.report.headline).toBe('Rule-written report, because the usual write-up did not pass its number check. Status: act.');
    expect(row.report.findings).toEqual([{ text: 'Google budget used is 0.72x. Rule that fired (act): The Google budget is nearly spent.', cites: ['m:online.budget.google.used'] }]);
    const write = (await stepsOf(task.id)).find((s) => s.step === 'worker.write')!;
    expect(write).toMatchObject({ outcome: 'refused', model: 'MOCK/MOCK/plans' });
    expect(write.detail).toBe('attempts 2; rule-written report used; headline: "9,999" is not a number in the data');
  });

  it("a report citing a metric that is not the worker's is corrected, and the corrected one is the model's", async () => {
    model.script('finance.google_ads.report',
      JSON.stringify({ ...googleWords, findings: [{ text: 'Email brought money.', cites: ['m:online.email.revenue'] }] }), JSON.stringify(googleWords));
    const { task, row } = await run('finance.google_ads');
    expect(row).toMatchObject({ written_by: 'model' });
    expect(JSON.parse(model.of('finance.google_ads.report')[1]!.user).previousAttemptRejectedBecause).toEqual(['finding 1: "m:online.email.revenue" is not one of your metric ids']);
    expect((await stepsOf(task.id)).find((s) => s.step === 'worker.write')!.detail).toBe('attempts 2, 2 findings; first objection: finding 1: "m:online.email.revenue" is not one of your metric ids');
  });

  it('a model that cannot be reached also leaves a rule-written report, and the receipt says it failed', async () => {
    model.script('finance.google_ads.report', new Error('the provider is down'));
    const { task, row } = await run('finance.google_ads');
    expect(row).toMatchObject({ written_by: 'rule', status: 'normal' });
    expect((await stepsOf(task.id)).find((s) => s.step === 'worker.write')).toMatchObject({ outcome: 'failed', detail: 'attempts 1; rule-written report used; the provider is down' });
  });

  it('runs again after the report was stored: nothing is read or asked twice, and one report is kept', async () => {
    model.script('finance.google_ads.report', JSON.stringify(googleWords));
    const first = await run('finance.google_ads');
    expect(model.calls).toHaveLength(1);
    const readsBefore = rowReads.length;

    expect(await handleTask(first.task, deps)).toEqual({ status: 'done' });
    expect(await handleTask(first.task, deps)).toEqual({ status: 'done' });
    expect(model.calls).toHaveLength(1);
    expect(rowReads).toHaveLength(readsBefore);
    expect(await rows('select id from public.worker_reports where report_key = $1', [first.key])).toHaveLength(1);
    const steps = (await stepsOf(first.task.id)).map((s) => s.step);
    expect(steps.filter((s) => s === 'worker.reuse')).toHaveLength(2);
    expect((await stepsOf(first.task.id)).find((s) => s.step === 'worker.reuse')!.detail).toBe(`the finance.google_ads report of ${first.date} was already stored; no model was asked again`);
  });

  it("never sees another division's metric, even when the division read hands one over", async () => {
    // Finance's read wrongly carries Online's email sends and a salon repairs count.
    leaks.finance = [metricOf(DEFS.find((d) => d[0] === 'm:online.email.sends')!), metricOf(DEFS.find((d) => d[0] === 'm:salon.repairs.open.count')!)];
    model.script('finance.email.report', JSON.stringify({ headline: 'Email brought in $5,300.', findings: [{ text: 'Email brought in $5,300.', cites: ['m:online.email.revenue'] }] }));
    const { row } = await run('finance.email');
    expect(given('finance.email.report').metrics.map((m: { id: string }) => m.id)).toEqual(['m:online.email.revenue']);
    expect(row.report.metrics.map((m: Metric) => m.id)).toEqual(['m:online.email.revenue']);
    expect(JSON.stringify(given('finance.email.report'))).not.toContain('21400');
  });

  it('a worker none of whose metrics are in the data yet stops plainly, and no model is asked', async () => {
    const { task, outcome, row } = await run('online.site_content');
    expect(outcome).toEqual({ status: 'failed', error: 'the online data has no metrics for the online.site_content worker yet' });
    expect(row).toBeUndefined();
    expect(model.calls).toHaveLength(0);
    expect((await stepsOf(task.id))).toMatchObject([{ step: 'worker.data', outcome: 'failed' }]);
  });

  it('a row read that fails stops the task plainly with a receipt, before any model is asked', async () => {
    failRows = new Error('HTTP 500: AnalysisException on zetaris-node-7.internal');
    const { task, outcome, row } = await run('salon.turnaround');
    expect(outcome).toEqual({ status: 'failed', error: 'the salon.turnaround rows (repairs_late) could not be read: Business data could not be read (ZETARIS_READ).' });
    expect(row).toBeUndefined();
    expect(model.calls).toHaveLength(0);
    expect((await stepsOf(task.id)).map((s) => [s.step, s.outcome])).toEqual([['worker.data', 'ok'], ['worker.rows', 'failed']]);
  });

  it('a run asked for by hand is its own report, keyed by its task', async () => {
    model.script('salon.turnaround.report', JSON.stringify({ headline: '23 repairs are open.', findings: [] }));
    const date = freshDate();
    const request = randomUUID();
    const task = await workerTask('salon.turnaround', date, { request });
    expect(await handleTask(task, deps)).toEqual({ status: 'done' });
    expect(await stored(`worker:salon.turnaround:${date}:${request}`)).toMatchObject({ worker_id: 'salon.turnaround', written_by: 'model' });
    expect(await stored(`worker:salon.turnaround:${date}`)).toBeUndefined();
  });

  it('refuses a worker job for the wrong assistant, an unknown worker or a bad date', async () => {
    const wrong = await taskOf('online', { job: 'division_worker', worker: 'finance.email', date: freshDate() });
    expect(await handleTask(wrong, deps)).toEqual({ status: 'failed', error: 'the finance.email worker belongs to the finance assistant, not the online assistant' });
    for (const payload of [{ worker: 'finance.tiktok', date: '2100-01-01' }, { worker: 'finance.email', date: 'tomorrow' }, { worker: 'finance.email' }]) {
      const task = await taskOf('finance', { job: 'division_worker', ...payload });
      expect(await handleTask(task, deps)).toEqual({ status: 'failed', error: 'the worker job needs a worker id (such as finance.email) and a date (YYYY-MM-DD)' });
    }
    expect(model.calls).toHaveLength(0);
  });

  it("queues each worker once a day, however often it is asked, and the database keeps a report's key to its worker and day", async () => {
    const date = freshDate();
    const far = { store: deps.store, now: () => new Date('2100-01-01T00:00:00Z') }; // not due yet: no worker can claim them
    await enqueueWorkers(far, date);
    await enqueueWorkers(far, date);
    const queued = await rows(`select id, assistant_id, payload, status from public.tasks where idempotency_key like $1 order by idempotency_key`, [`worker:%:${date}`]);
    try {
      expect(queued).toHaveLength(WORKER_IDS.length);
      expect(queued.every((t) => t.status === 'queued' && t.assistant_id === workerDivision(t.payload.worker))).toBe(true);
      expect(queued.map((t) => t.payload.worker).sort()).toEqual([...WORKER_IDS].sort());
    } finally {
      await pool.query(`update public.tasks set status = 'cancelled' where id = any($1)`, [queued.map((t) => t.id)]);
    }
    await expect(pool.query(`insert into public.worker_reports (worker_id, division, report_key, report_date, period, status, written_by, report)
      values ('finance.email', 'finance', $1, $2, 'p', 'normal', 'model', '{}'::jsonb)`, [`worker:finance.meta:${date}`, date])).rejects.toThrow(/worker_reports_check/);
  });
});
