import { randomInt, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DIVISION_ASSISTANT, type Attention, type DataPort, type Division, type ManagedDivision, type Metric, type MetricInfo, type ModelPort, type WorkerReport } from '@fahq/contracts';
import type { Brain } from '@fahq/brain';
import { NEEDS_RULES } from '../src/brief.ts';
import { handleTask, type WorkerDeps } from '../src/flows.ts';
import { createStore, type TaskRow } from '../src/store.ts';
import { STANDING_ASKS, WEEKLY_ENDING, WEEKLY_RULES, addDays } from '../src/weekly.ts';
import { fakeCodeMode, okResult, scriptedModel } from './fixtures.ts';
import { dbUrl, localApi } from './localdb.ts';

// A division's weekly report end to end on the real local database. Only the models, Code Mode, the World Model and the
// Zetaris adapter are fakes. Every report is for a Monday in the 2100s whose week no other run of this test, or of the
// workers' test, has used. SMS, email and printouts never leave the database (nothing flushes the outbox), and every row a
// test leaves pending is settled afterwards.

const api = localApi();
if (!api) console.warn('SKIPPED weekly report tests: needs local Supabase (npm run db:start)');

const pool = new pg.Pool({ connectionString: dbUrl, max: 3 });
afterAll(async () => pool.end());

const HEAD: Record<ManagedDivision, string> = { finance: 'demo-p-finance-owner', online: 'demo-p-online-staff', salon: 'demo-p-head-stylist' };

// Mondays in the 2100s with no worker report from the week before to the day after, and no weekly report or task.
let freeMondays: string[] = [];
const freshMonday = () => {
  const day = freeMondays.pop();
  if (!day) throw new Error('no free Monday is left for this test');
  return day;
};
async function pickFreeMondays(count: number): Promise<string[]> {
  const taken = (await pool.query(
    `select to_char(report_date, 'YYYY-MM-DD') as day from public.worker_reports where report_date between '2100-01-01' and '2199-12-31'
     union select to_char(week_of, 'YYYY-MM-DD') from public.weekly_reports where week_of between '2100-01-01' and '2199-12-31'
     union select to_char(brief_date, 'YYYY-MM-DD') from public.division_briefs where brief_date between '2100-01-01' and '2199-12-31'
     union select substring(idempotency_key from '[0-9]{4}-[0-9]{2}-[0-9]{2}') from public.tasks where idempotency_key ~ '^(worker|weekly|brief):.*:21[0-9]{2}-'`)).rows.map((r) => r.day as string);
  const near = (monday: string) => taken.some((day) => day >= addDays(monday, -9) && day <= addDays(monday, 7));
  const days = new Set<string>();
  while (days.size < count) {
    const monday = new Date(Date.UTC(2100, 0, 4) + randomInt(0, 5000) * 7 * 86_400_000).toISOString().slice(0, 10); // 2100-01-04 is a Monday
    if (!near(monday)) days.add(monday);
  }
  return [...days];
}

// ---- A version 2 data port, faked -----------------------------------------------------------------------

// Each division reads its own mart, with its own query hash: a number keeps the source of the division that read it.
const VIEW: Record<Division, string> = { finance: 'fortune_demo_v2_finance_mart', online: 'fortune_demo_v2_online_mart', salon: 'fortune_demo_v2_salon_mart', hq: 'fortune_demo_v2_hq_mart' };
const HASH: Record<Division, string> = { finance: 'f'.repeat(64), online: 'b'.repeat(64), salon: 'c'.repeat(64), hq: 'a'.repeat(64) };
const sourceOf = (division: Division) => ({ system: 'zetaris' as const, view: VIEW[division], queryHash: HASH[division], asOf: '2026-10-26T12:00:00Z' });
const DEFS: [id: string, label: string, value: number, unit: Metric['unit'], divisions: Division[]][] = [
  ['m:online.revenue.total', 'Online revenue', 48200, 'usd', ['online', 'finance', 'hq']],
  ['m:online.email.revenue', 'Email revenue', 5300, 'usd', ['online', 'finance']],
  ['m:online.ads.google.spend', 'Google ad spend', 1800, 'usd', ['online', 'finance']],
  ['m:online.ads.google.roas', 'Google ad return', 2.4, 'ratio', ['online', 'finance']],
  ['m:online.budget.google.room', 'Google budget left', 700, 'usd', ['finance', 'hq']],
  ['m:online.service.replied_1h.share', 'Replied within an hour', 0.61, 'ratio', ['online']],
  ['m:online.service.waiting_now.count', 'Messages waiting', 14, 'count', ['online', 'hq']],
  ['m:online.service.missed_sale_intent.count', 'Missed buyers', 3, 'count', ['online', 'hq']],
  ['m:salon.revenue.total', 'Salon revenue', 52000, 'usd', ['salon', 'finance', 'hq']],
  ['m:salon.appointments.count', 'Salon appointments', 310, 'count', ['salon', 'finance']],
  ['m:salon.repairs.revenue', 'Repairs revenue', 4100, 'usd', ['salon', 'finance']],
  ['m:salon.repairs.open_over_14d.count', 'Repairs open over two weeks', 6, 'count', ['salon', 'hq']],
];
const businessOf = (id: string) => id.slice(2, id.indexOf('.')) as 'salon' | 'online';
// The salon's repair turnaround in days: in the catalog only (no division read here), and kept out of plan writing.
const catalog: MetricInfo[] = [
  ...DEFS.map(([id, label, , unit, divisions]): MetricInfo => ({ id, label, unit, business: businessOf(id), divisions })),
  { id: 'm:salon.repairs.avg_days', label: 'Average repair days', unit: 'days', business: 'salon', divisions: ['salon'], planUse: false },
];
const metricOf = (id: string, division: Division = 'finance'): Metric => {
  const [, label, value, unit] = DEFS.find((d) => d[0] === id)!;
  return { id, label, value, unit, business: businessOf(id), period: '2026-09', source: sourceOf(division) };
};
const reads: Record<string, string[]> = { finance: ['get_finance_metrics', 'get_budget_room'], online: ['get_online_metrics'], salon: ['get_salon_metrics'] };

// ---- What the models and the other divisions would say ---------------------------------------------------

const workerWords: Record<string, object> = {
  'finance.email.report': { headline: 'Email brought in $5,300.', findings: [{ text: 'Email brought in $5,300.', cites: ['m:online.email.revenue'] }] },
  'finance.online_money.report': { headline: 'Online revenue is $48,200.', findings: [{ text: 'Online revenue is $48,200.', cites: ['m:online.revenue.total'] }] },
  'finance.salon_money.report': { headline: 'Salon revenue is $52,000, with $4,100 from repairs.', findings: [{ text: 'Repairs brought in $4,100.', cites: ['m:salon.repairs.revenue'] }] },
  'online.messages.report': { headline: '14 messages are waiting and 3 buyers went unanswered.', findings: [{ text: '61% got a reply within an hour.', cites: ['m:online.service.replied_1h.share'] }] },
  'salon.turnaround.report': { headline: '6 repairs are open past their time.', findings: [{ text: '6 repairs are open past their time.', cites: ['m:salon.repairs.open_over_14d.count'] }] },
  'salon.appointments.report': { headline: 'The salon booked 310 appointments.', findings: [{ text: 'The salon booked 310 appointments.', cites: ['m:salon.appointments.count'] }] },
};

const financeWords = (monday: string) => ({
  summary: 'Google ads return 2.4x on $1,800 of spend, with $700 of budget room left. Email brought in $5,300. The salon counts 42 frequent clients.',
  sections: [
    { workerId: 'finance.email', summary: 'Email brought in $5,300.', cites: ['m:online.email.revenue'] },
    { workerId: 'finance.google_ads', summary: 'Google ads return 2.4x on $1,800 of spend; $700 of budget room is left.', cites: ['m:online.ads.google.roas', 'm:online.ads.google.spend', 'm:online.budget.google.room'] },
    { workerId: 'finance.online_money', summary: 'Online revenue is $48,200.', cites: ['m:online.revenue.total'] },
    { workerId: 'finance.salon_money', summary: 'Salon revenue is $52,000, with $4,100 from repairs.', cites: ['m:salon.revenue.total', 'm:salon.repairs.revenue'] },
  ],
  actions: [],
  goal: { title: 'Lift online revenue from $48,200 to $50,000', metricId: 'm:online.revenue.total', from: 48200, to: 50000, by: addDays(monday, 4), why: 'Google ads return 2.4x, so the room left can pay.' },
  ceoLine: 'Finance has something to watch; its head has the detail.',
});

const plan = <T extends Record<string, unknown>>(rank: number, over: T) => ({ rank, actions: ['Do it for a short trial'], risks: ['It may not work'], businesses: ['online'], ...over });
const financePaths = {
  plans: [
    plan(1, {
      title: 'Raise Google ad spend 20%', summary: 'Google ads return 2.4x on $1,800 of spend; a 20% raise makes it $2,160.',
      evidence: [{ metricId: 'm:online.ads.google.spend', value: 1800 }, { metricId: 'm:online.ads.google.roas', value: 2.4 }],
      projections: [{ label: 'Google spend after the raise', baseMetricId: 'm:online.ads.google.spend', factor: 1.2, result: 2160, assumption: 'Budget raised 20%' }],
      test: 'Run 14 days.', stopLoss: 'Stop if spend passes $2,160 without new orders.',
    }),
    plan(2, {
      title: 'Email buyers a restock note', summary: 'Email brought in $5,300; a 5% lift would make it $5,565.',
      evidence: [{ metricId: 'm:online.email.revenue', value: 5300 }],
      projections: [{ label: 'Email revenue with the note', baseMetricId: 'm:online.email.revenue', factor: 1.05, result: 5565, assumption: 'A small lift from one email' }],
      test: 'Send once and compare orders for 7 days.', stopLoss: 'Stop if orders do not rise within 7 days.',
    }),
    plan(3, {
      title: 'Hold Google spend and test new ads', summary: 'Keep spend at $1,800 and test new ads to lift the 2.4x return by 10%.',
      evidence: [{ metricId: 'm:online.ads.google.spend', value: 1800 }, { metricId: 'm:online.ads.google.roas', value: 2.4 }],
      projections: [{ label: 'Google return with new ads', baseMetricId: 'm:online.ads.google.roas', factor: 1.1, result: 2.64, assumption: 'New creative lifts the return 10%' }],
      test: 'Test two new ads for 14 days.', stopLoss: 'Stop if the return falls below the current level.',
    }),
  ],
  memoryConflicts: [],
};

const onlineWords = {
  summary: '14 messages are waiting and 3 buyers went unanswered. Finance reports 2 Amazon products out of stock. The salon has 6 repairs open past their time.',
  sections: [{ workerId: 'online.messages', summary: '14 messages are waiting; 61% got a reply within an hour.', cites: ['m:online.service.waiting_now.count', 'm:online.service.replied_1h.share'] }],
  actions: [{ rank: 1, title: 'Answer the waiting buyers first', why: '3 buyers went unanswered.', steps: 'Sort the inbox by buyers and answer them today.', cites: ['m:online.service.missed_sale_intent.count'] }],
  goal: null,
  ceoLine: 'Online needs a decision from its head.',
};

const amazonOut = [{ id: 'm:online.amazon.stock.out.count', value: 2, unit: 'count' }];
const lateRepairs = [{ id: 'm:salon.repairs.open_over_14d.count', value: 6, unit: 'count' }, { id: 'm:salon.repairs.avg_days', value: 9.5, unit: 'days' }];
const clientSegments = [{ id: 'm:salon.clients.frequent.count', value: 42, unit: 'count' }];
/** What the answering division's own metrics tool returned: its mart, its query hash and the ids it read. */
const metricsTool = (division: Division, facts: readonly { id: string; value: number; unit: string }[]) => ({
  tool: `get_${division}_metrics`, output: { view: VIEW[division], queryHash: HASH[division], metrics: Object.fromEntries(facts.map((f) => [f.id, { value: f.value, unit: f.unit }])) },
});

describe.skipIf(!api)('weekly reports (real database; the models, Code Mode and the data port scripted)', () => {
  const attention: Partial<Record<Division, Attention[]>> = {};
  const numbers: Record<string, string | null> = {};
  const mine = { tasks: new Set<string>(), reports: new Set<string>() };
  const briefs = new Set<string>();
  const digests = new Set<string>();
  // The texts as they were queued and the codes issued (the database blanks a code once a text is handled).
  const sent = new Map<string, string>();
  const issued: { key: string; code: string; created: boolean }[] = [];
  const recorded: { kind: string; input: Record<string, unknown> }[] = [];
  let deps: WorkerDeps;
  let model: ReturnType<typeof scriptedModel>;
  let codeMode: ReturnType<typeof fakeCodeMode>;
  let phone: Record<string, string>;

  beforeAll(async () => {
    freeMondays = await pickFreeMondays(40);
    phone = Object.fromEntries((await pool.query('select id, phone from public.people')).rows.map((r) => [r.id, r.phone]));
    const real = createStore(api!.url, api!.key);
    const data: DataPort = {
      health: async () => ({ ok: true, detail: 'MOCK data' }),
      getFinanceMetrics: async () => { throw new Error('a version 2 port is read by division'); },
      getDivisionMetrics: async ({ division }) => ({
        division, metrics: DEFS.filter((d) => d[4].includes(division)).map((d) => metricOf(d[0], division)),
        attention: attention[division] ?? [], queryHash: HASH[division], view: VIEW[division],
      }),
      readRows: async (r) => ({ table: r.table, rows: [], totals: {}, dataDate: '2026-10-26', queryHash: 'e'.repeat(64), view: 'fortune_demo_rows' }),
      catalog,
    };
    const memory = { lessons: () => [], recallDecisions: () => [], declinedSimilarTo: () => [], rememberDecision: (input: Record<string, unknown>) => { recorded.push({ kind: 'remember', input }); } };
    const record = async (kind: string, input: Record<string, unknown>) => { recorded.push({ kind, input }); };
    deps = {
      store: {
        ...real,
        assistantNumber: async (a) => numbers[a] ?? null,
        addOutbox: async (o) => { if (!sent.has(o.dedupeKey)) sent.set(o.dedupeKey, o.body); return real.addOutbox(o); },
        issueApproval: async (a) => {
          const result = await real.issueApproval(a);
          issued.push({ key: a.smsDedupeKey, code: a.code, created: result.created });
          if (result.created) sent.set(a.smsDedupeKey, a.smsBody);
          return result;
        },
      },
      brain: {
        memory: () => memory,
        record: { request: (i: Record<string, unknown>) => record('request', i), proposal: (i: Record<string, unknown>) => record('proposal', i), decision: (i: Record<string, unknown>) => record('decision', i) },
      } as unknown as Brain,
      models: { nvidia: undefined as unknown as ModelPort, planModel: 'MOCK/plans', routerModel: 'MOCK/router' },
      guard: null,
      data,
      delivery: null,
      codeMode: null,
      profiles: { skill: (id) => `SKILL(${id})`, model: (id, job) => `MOCK/${id}/${job}`, reads: (id) => reads[id] ?? [] },
      now: () => new Date(),
      worker: 'weekly-test',
      live: false,
      period: '2026-09',
      smsLive: false,
      printers: {},
      printDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fahq-weekly-print-')),
    };
  });

  beforeEach(() => {
    for (const k of Object.keys(attention)) delete attention[k as Division];
    Object.assign(numbers, { finance: '+12125550123', online: '+12125550124', salon: null, owner: null });
    recorded.length = 0;
    model = scriptedModel();
    for (const [purpose, words] of Object.entries(workerWords)) model.script(purpose, JSON.stringify(words));
    codeMode = fakeCodeMode();
    codeMode.respond((input) => {
      const result = input.purpose === 'finance.lookup' ? amazonOut : input.purpose === 'salon.lookup' && input.question.includes('Online') ? lateRepairs : clientSegments;
      return okResult(result, { toolOutputs: [metricsTool(input.purpose.split('.')[0] as Division, result)] });
    });
    deps.models = { ...deps.models, nvidia: model.port };
    deps.codeMode = codeMode.runner;
    deps.now = () => new Date();
  });

  // Leave nothing pending for other lanes' tests, which share this database.
  afterEach(async () => {
    const keys = [...mine.reports].flatMap((id) => [`weekly-sms:${id}`, `weekly-email:${id}`, `weekly-print:${id}`])
      .concat([...briefs].flatMap((id) => [`brief-sms:${id}`, `brief-print:${id}`]), [...mine.tasks].map((id) => `reply:${id}`), [...digests].map((k) => `digest-sms:${k}`));
    await pool.query(
      `update public.outbox set status = 'skipped', last_error = 'reset by weekly test', body = regexp_replace(body, '\\m[0-9]{6}\\M', '••••••', 'g') where status = 'pending' and dedupe_key = any($1)`, [keys]);
    // The weekly digests this test queued: run by hand above, never by a claim loop.
    await pool.query(`update public.tasks set status = 'cancelled' where status in ('queued', 'waiting') and idempotency_key = any($1)`, [[...digests]]);
    await pool.query(`update public.approvals set status = 'expired' where status = 'pending' and message_id in (select id from public.assistant_messages where dedupe_key like 'weeklydoc:weekly:%:21__-__-__%' or dedupe_key like 'briefdoc:brief:online:21__-__-__')`);
    // The runs a REPORT text of this test queued (weekly:<division>:<Monday>:<text's task id>), and nothing of another test's.
    await pool.query(`update public.tasks set status = 'cancelled' where status in ('queued', 'waiting') and idempotency_key like 'weekly:%' and split_part(idempotency_key, ':', 4) = any($1)`, [[...mine.tasks]]);
  });

  const taskOf = async (assistant: string, kind: 'scheduled' | 'inbound_text', payload: Record<string, unknown>, key = `weekly-test:${randomUUID()}`): Promise<TaskRow> => {
    const id = (await pool.query(
      `insert into public.tasks (assistant_id, kind, idempotency_key, payload, status) values ($1, $2, $3, $4::jsonb, 'done') returning id`,
      [assistant, kind, key, JSON.stringify(payload)])).rows[0].id as string;
    mine.tasks.add(id);
    return { id, assistant_id: assistant as TaskRow['assistant_id'], kind, status: 'done', payload, attempts: 1, max_attempts: 3 };
  };
  const rows = async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows;
  const message = async (dedupeKey: string) => (await rows('select * from public.assistant_messages where dedupe_key = $1', [dedupeKey]))[0];
  const outbox = async (dedupeKey: string) => (await rows('select * from public.outbox where dedupe_key = $1', [dedupeKey]))[0];
  const stepsOf = (taskId: string) => rows('select step, outcome, assistant_id, model, data_source, detail from public.receipts where task_id = $1 order by id', [taskId]);
  const codeIn = (body: string | undefined) => /APPROVE <1-3> (\d{6})/.exec(body ?? '')?.[1] ?? '';

  const run = async (division: ManagedDivision, monday = freshMonday()) => {
    const task = await taskOf(DIVISION_ASSISTANT[division], 'scheduled', { job: 'weekly_report', division, date: monday }, `weekly:${division}:${monday}`);
    const outcome = await handleTask(task, deps);
    const key = `weekly:${division}:${monday}`;
    const row = (await rows("select *, to_char(week_of, 'YYYY-MM-DD') as week from public.weekly_reports where report_key = $1", [key]))[0];
    if (row) mine.reports.add(row.id);
    return { task, outcome, key, monday, row };
  };
  /** A worker's report stored as if its own task had written it on `day`. */
  const storeWorkerReport = async (report: WorkerReport) =>
    deps.store.saveWorkerReport({ key: `worker:${report.workerId}:${report.day}`, report, taskId: null });
  const googleReport = (day: string, headline: string): WorkerReport => ({
    workerId: 'finance.google_ads', day, period: '2026-09', status: 'watch', writtenBy: 'model', headline,
    findings: [{ text: 'Google ads return 2.4x on $1,800 of spend.', cites: ['m:online.ads.google.roas', 'm:online.ads.google.spend'] }],
    metrics: ['m:online.ads.google.spend', 'm:online.ads.google.roas', 'm:online.budget.google.room'].map((id) => metricOf(id)),
    attention: [{ metricId: 'm:online.budget.google.room', level: 'watch', rule: 'Little of the Google budget is left.' }],
    rows: [{ read: 'budget_room.google', totals: { roomUsd: 700 } }], dataSource: `${VIEW.finance}#ffffffffffff`,
  });
  const approve = async (person: string, body: string) => {
    const task = await taskOf(DIVISION_ASSISTANT[Object.entries(HEAD).find(([, id]) => id === person)![0] as ManagedDivision], 'inbound_text', { from: phone[person], body, personId: person });
    const outcome = await handleTask(task, deps);
    return { task, outcome, reply: sent.get(`reply:${task.id}`) };
  };

  it("Finance (George): this week's worker reports, workers run now, Cindy's client segments, a checked goal and three paths, delivered to Alan", async () => {
    const monday = freshMonday();
    const google = await storeWorkerReport(googleReport(addDays(monday, -2), 'Google ads return 2.4x; little budget room is left.'));
    await storeWorkerReport(googleReport(addDays(monday, -8), 'An older report, outside the week.'));
    model.script('finance.weekly_needs', JSON.stringify({ requests: [{ division: 'salon', question: 'What are your client segments this week?' }] }));
    model.script('finance.weekly', JSON.stringify(financeWords(monday)));
    model.script('finance.plans', JSON.stringify(financePaths));
    const { task, outcome, key, row } = await run('finance', monday);
    expect(outcome).toEqual({ status: 'done' });

    // Stored once, with the program's status (the Google report's watch), the model's words, the goal and the three checked paths.
    expect(row).toMatchObject({ division: 'finance', week: monday, period: '2026-09', status: 'watch', written_by: 'model', ceo_line: financeWords(monday).ceoLine, task_id: task.id, data_source: `${VIEW.finance}#ffffffffffff` });
    const report = row.report;
    expect(report).toMatchObject({ division: 'finance', weekOf: monday, manager: 'George', head: 'Alan', status: 'watch', writtenBy: 'model', summary: financeWords(monday).summary, goal: financeWords(monday).goal, actions: [] });
    expect(report.paths.plans.map((p: { title: string }) => p.title)).toEqual(financePaths.plans.map((p) => p.title));
    expect(report.sections.map((s: { workerId: string; status: string }) => [s.workerId, s.status])).toEqual([
      ['finance.email', 'normal'], ['finance.google_ads', 'watch'], ['finance.online_money', 'normal'], ['finance.salon_money', 'normal'],
    ]);
    // The week's Google report (not the older one) and the three run now, each under today's key.
    const workerIds = (await rows('select id, worker_id, report_key from public.worker_reports where id = any($1) order by worker_id', [report.workerReportIds])).map((r) => [r.worker_id, r.report_key]);
    expect(workerIds).toEqual([
      ['finance.email', `worker:finance.email:${monday}`], ['finance.google_ads', `worker:finance.google_ads:${addDays(monday, -2)}`],
      ['finance.online_money', `worker:finance.online_money:${monday}`], ['finance.salon_money', `worker:finance.salon_money:${monday}`],
    ]);
    expect(report.workerReportIds).toContain(google.id);
    expect(report.asked).toEqual([{ division: 'salon', question: 'What are your client segments this week?', answer: 'm:salon.clients.frequent.count = 42', ok: true }]);
    // Cindy's number keeps the salon mart it was read from; George's own keep the finance mart.
    expect(report.metrics.find((m: Metric) => m.id === 'm:salon.clients.frequent.count')).toMatchObject({ value: 42, unit: 'count', business: 'salon', source: { view: VIEW.salon, queryHash: HASH.salon } });
    expect(report.metrics.find((m: Metric) => m.id === 'm:online.revenue.total').source).toMatchObject({ view: VIEW.finance, queryHash: HASH.finance });
    expect(await message(`datareply:${(await message(`datareq:${key}:salon`)).id}`)).toMatchObject({ body: { sources: { 'm:salon.clients.frequent.count': { view: VIEW.salon, queryHash: HASH.salon } } } });

    // The models: the workers that had no report, the needs call with the standing asks, the writer, the plan writer.
    expect(model.calls.map((c) => c.purpose)).toEqual(['finance.email.report', 'finance.online_money.report', 'finance.salon_money.report', 'finance.weekly_needs', 'finance.weekly', 'finance.plans']);
    const needs = model.of('finance.weekly_needs')[0]!;
    expect(needs).toMatchObject({ model: 'MOCK/finance/code', system: `SKILL(finance)\n\n${NEEDS_RULES}\n${STANDING_ASKS.finance}`, thinking: true, json: true });
    const writer = model.of('finance.weekly')[0]!;
    expect(writer).toMatchObject({ model: 'MOCK/plans', thinking: true, json: true, system: `SKILL(finance)\n\n${WEEKLY_RULES}\n${WEEKLY_ENDING.finance}` });
    const given = JSON.parse(writer.user);
    expect(given).toMatchObject({ division: 'finance', manager: 'George', head: 'Alan', weekOf: monday, status: 'watch', goalBy: { after: monday, latest: addDays(monday, 7) } });
    expect(given.workers.map((w: { workerId: string }) => w.workerId)).toEqual(['finance.email', 'finance.google_ads', 'finance.online_money', 'finance.salon_money']);
    expect(given.missingWorkers.map((w: { workerId: string }) => w.workerId)).toEqual(['finance.meta', 'finance.amazon', 'finance.walmart']);
    expect(given.replies).toEqual([{ from: 'salon', question: 'What are your client segments this week?', facts: clientSegments }]);
    const plansInput = JSON.parse(model.of('finance.plans')[0]!.user);
    expect(plansInput.request).toContain('Lift online revenue from $48,200 to $50,000');
    expect(plansInput.metrics.map((m: { id: string }) => m.id)).toContain('m:salon.clients.frequent.count');
    expect(model.calls.map((c) => `${c.system}\n${c.user}`).join('\n')).not.toMatch(/\+1\d{10}|(?<!\d)\d{6}(?!\d)|@/);
    // Cindy's division answered with its own profile.
    expect(codeMode.calls).toMatchObject([{ purpose: 'salon.lookup', skill: 'SKILL(salon)', model: 'MOCK/salon/code' }]);

    // Delivery: the report's own row (the code hangs from it), the CEO's weekly line, the email and the printout, and Alan's text.
    const doc = await message(`weeklydoc:${key}`);
    expect(doc).toMatchObject({ from_assistant: 'finance', to_assistant: 'finance', kind: 'report', body: { type: 'weekly_report', weeklyReportId: row.id, division: 'finance', status: 'watch', weekOf: monday } });
    expect((await rows('select message_id from public.weekly_reports where id = $1', [row.id]))[0].message_id).toBe(doc.id);
    expect(await message(`weeklystatus:${key}`)).toMatchObject({ to_assistant: 'owner', body: { type: 'weekly_status', division: 'finance', status: 'watch', ceoLine: financeWords(monday).ceoLine, weeklyReportId: row.id } });
    expect(await outbox(`weekly-email:${row.id}`)).toMatchObject({ channel: 'email', to_person_id: HEAD.finance, from_assistant: 'finance', attachment_ref: `weekly_report:${row.id}`, body: `For Alan: George's weekly report, week of ${monday}` });
    expect(await outbox(`weekly-print:${row.id}`)).toMatchObject({ channel: 'print', to_person_id: HEAD.finance, attachment_ref: `weekly_report:${row.id}` });
    const sms = sent.get(`weekly-sms:${row.id}`)!;
    const code = codeIn(sms);
    expect(code).toMatch(/^\d{6}$/);
    expect(sms.split('\n')[0]).toBe(`George, Finance: your weekly report is in (week of ${monday}, status WATCH).`);
    expect(sms).toContain(`Goal of the week: Lift online revenue from $48,200 to $50,000 (by ${addDays(monday, 4)})`);
    expect(sms).toContain('Path 2: Email buyers a restock note');
    expect(sms.endsWith(`Reply APPROVE <1-3> ${code} to approve a path (APPROVE 1 2 ${code} for more). The code expires in 24 hours.`)).toBe(true);
    const approvals = await rows(`select action, status, approver_person_id, extract(epoch from (expires_at - created_at))::int as ttl from public.approvals where message_id = $1`, [doc.id]);
    expect(approvals).toEqual([{ action: 'approve_action', status: 'pending', approver_person_id: HEAD.finance, ttl: 24 * 3600 }]);

    expect((await stepsOf(task.id)).filter((s) => s.step.startsWith('weekly.') || s.step.endsWith('.lookup')).map((s) => [s.step, s.outcome])).toEqual([
      ['weekly.data', 'ok'], ['weekly.workers', 'ok'], ['weekly.needs', 'ok'], ['salon.lookup', 'ok'], ['weekly.write', 'ok'], ['weekly.paths', 'ok'], ['weekly.save', 'ok'], ['weekly.deliver', 'ok'],
    ]);
    expect((await stepsOf(task.id)).find((s) => s.step === 'weekly.workers')!.detail).toBe(
      '4 of 7 worker reports; run now: finance.email, finance.online_money, finance.salon_money; no report: finance.meta (the finance data has no metrics for the finance.meta worker yet); finance.amazon (the finance data has no metrics for the finance.amazon worker yet); finance.walmart (the finance data has no metrics for the finance.walmart worker yet)');

    // Alan approves path 2: recorded as his decision, nothing carried out.
    const approved = await approve(HEAD.finance, `APPROVE 2 ${code}`);
    expect(approved.outcome).toEqual({ status: 'done' });
    expect(approved.reply).toBe("Recorded: you approved path 2 (Email buyers a restock note). It's yours to carry out.");
    expect(await message(`action-decision:${doc.id}:2`)).toMatchObject({
      from_assistant: 'finance', to_assistant: 'manager', kind: 'decision',
      body: { type: 'action_decision', weeklyReportId: row.id, kind: 'path', division: 'finance', rank: 2, title: 'Email buyers a restock note', verdict: 'approved', by: HEAD.finance },
    });
    expect(recorded.filter((r) => r.kind === 'proposal').map((r) => r.input)).toMatchObject([{ proposalId: `${doc.id}:2`, titles: ['Email buyers a restock note'], citedMetricIds: ['m:online.email.revenue'], by: 'finance' }]);
    expect(recorded.filter((r) => r.kind === 'decision').map((r) => r.input)).toMatchObject([{ proposalId: `${doc.id}:2`, personId: HEAD.finance, verdict: 'signed', planRank: 2 }]);
  });

  it("Online (Georgette): asks George for marketplace stock and Cindy for turnaround, writes actions, and Emma approves one (a rank it lacks keeps the code)", async () => {
    attention.online = [{ metricId: 'm:online.service.missed_sale_intent.count', level: 'act', rule: 'Buyers who asked to buy got no answer.' }];
    model.script('online.weekly_needs', JSON.stringify({ requests: [
      { division: 'finance', question: 'How many Amazon and Walmart products are out of stock or low?' },
      { division: 'salon', question: 'How long do repairs and personalization take at the salon?' },
    ] }));
    const summary = `${onlineWords.summary} Repairs take 9.5 days at the salon.`;
    model.script('online.weekly', JSON.stringify({ ...onlineWords, summary }));
    const { outcome, key, row, monday } = await run('online');
    expect(outcome).toEqual({ status: 'done' });
    expect(row).toMatchObject({ division: 'online', status: 'act', written_by: 'model', data_source: `${VIEW.online}#bbbbbbbbbbbb` });
    expect(row.report).toMatchObject({ manager: 'Georgette', head: 'Emma', goal: null, paths: null, actions: onlineWords.actions, summary });
    expect(row.report.sections).toEqual([{ ...onlineWords.sections[0], status: 'act' }]);
    expect(row.report.asked).toEqual([
      { division: 'finance', question: 'How many Amazon and Walmart products are out of stock or low?', answer: 'm:online.amazon.stock.out.count = 2', ok: true },
      { division: 'salon', question: 'How long do repairs and personalization take at the salon?', answer: 'm:salon.repairs.open_over_14d.count = 6; m:salon.repairs.avg_days = 9.5', ok: true },
    ]);
    // Every number Emma can read is stored with the mart of the division that read it, in its own unit: George's stock from
    // the finance mart, Cindy's days from the salon mart.
    expect(row.report.metrics.find((m: Metric) => m.id === 'm:online.amazon.stock.out.count')).toMatchObject({ value: 2, unit: 'count', business: 'online', source: { view: VIEW.finance, queryHash: HASH.finance } });
    expect(row.report.metrics.find((m: Metric) => m.id === 'm:salon.repairs.avg_days')).toMatchObject({ value: 9.5, unit: 'days', business: 'salon', source: { view: VIEW.salon, queryHash: HASH.salon } });
    expect(row.report.metrics.find((m: Metric) => m.id === 'm:online.service.waiting_now.count').source).toMatchObject({ view: VIEW.online, queryHash: HASH.online });
    expect(model.of('online.weekly_needs')[0]!.system).toBe(`SKILL(online)\n\n${NEEDS_RULES}\n${STANDING_ASKS.online}`);
    expect(model.of('online.weekly')[0]!.system).toBe(`SKILL(online)\n\n${WEEKLY_RULES}\n${WEEKLY_ENDING.other}`);
    expect(codeMode.calls.map((c) => c.purpose).sort()).toEqual(['finance.lookup', 'salon.lookup']);
    expect(await outbox(`weekly-email:${row.id}`)).toMatchObject({ channel: 'email', to_person_id: HEAD.online, body: `For Emma: Georgette's weekly report, week of ${monday}` });

    const sms = sent.get(`weekly-sms:${row.id}`)!;
    expect(sms.split('\n')[0]).toBe(`Georgette, Online: your weekly report is in (week of ${monday}, status ACT).`);
    expect(sms).toContain('Action 1: Answer the waiting buyers first');
    const code = codeIn(sms);
    expect(sms.endsWith(`Reply APPROVE <1-3> ${code} to approve an action. The code expires in 24 hours.`)).toBe(true);

    const wrong = await approve(HEAD.online, `APPROVE 3 ${code}`);
    expect(wrong.reply).toBe('This weekly report has no action 3. Nothing was recorded, and your code still works.');
    const right = await approve(HEAD.online, `APPROVE 1 ${code}`);
    expect(right.reply).toBe("Recorded: you approved action 1 (Answer the waiting buyers first). It's yours to carry out.");
    const doc = await message(`weeklydoc:${key}`);
    expect(await message(`action-decision:${doc.id}:1`)).toMatchObject({ body: { type: 'action_decision', weeklyReportId: row.id, kind: 'action', division: 'online', rank: 1 } });
    const again = await approve(HEAD.online, `APPROVE 1 ${code}`);
    expect(again.reply).toBe("That code didn't work or has expired. Nothing was recorded.");
  });

  it('Salon (Cindy): a writer that fails leaves a rule-written report; with no live number Esther gets no text, but the email and printout are queued', async () => {
    attention.salon = [{ metricId: 'm:salon.repairs.open_over_14d.count', level: 'act', rule: 'Repairs are open too long.' }];
    model.script('salon.weekly_needs', JSON.stringify({ requests: [] }));
    model.script('salon.weekly', new Error('the provider is down'));
    const { task, outcome, row } = await run('salon');
    expect(outcome).toEqual({ status: 'done' });
    expect(row).toMatchObject({ division: 'salon', status: 'act', written_by: 'rule', ceo_line: 'Salon needs a decision from its head.' });
    expect(row.report.sections).toEqual([
      { workerId: 'salon.turnaround', status: 'act', summary: '6 repairs are open past their time.', cites: ['m:salon.repairs.open_over_14d.count'] },
      { workerId: 'salon.appointments', status: 'normal', summary: 'The salon booked 310 appointments.', cites: ['m:salon.appointments.count'] },
    ]);
    expect(row.report.summary).toContain('No report this week from salon.clients.');
    expect(row.report.actions.map((a: { title: string }) => a.title)).toEqual(['Look at Repairs open over two weeks']);
    expect(row.report).toMatchObject({ goal: null, paths: null, asked: [] });
    expect(sent.has(`weekly-sms:${row.id}`)).toBe(false);
    expect(await outbox(`weekly-email:${row.id}`)).toMatchObject({ channel: 'email', to_person_id: HEAD.salon, body: expect.stringMatching(/^For Esther: Cindy's weekly report, week of /) });
    expect(await outbox(`weekly-print:${row.id}`)).toMatchObject({ channel: 'print', to_person_id: HEAD.salon });
    const steps = await stepsOf(task.id);
    expect(steps.find((s) => s.step === 'weekly.write')).toMatchObject({ outcome: 'failed', detail: 'attempts 1; rule-written report used; the provider is down' });
    expect(steps.find((s) => s.step === 'weekly.sms')).toMatchObject({ outcome: 'refused', detail: 'no text sent: the Salon assistant has no live number; the report is stored, and its email and printout are queued' });
  });

  it("Finance: a goal that does not start at its metric's value is corrected once; paths that never pass leave a rule-written report with no goal and nothing to approve", async () => {
    const monday = freshMonday();
    const words = financeWords(monday);
    model.script('finance.weekly_needs', JSON.stringify({ requests: [] }));
    model.script('finance.weekly', JSON.stringify({ ...words, summary: 'Google ads return 2.4x on $1,800 of spend.', goal: { ...words.goal, from: 48000, title: 'Lift online revenue to $50,000' } }),
      JSON.stringify({ ...words, summary: 'Google ads return 2.4x on $1,800 of spend.' }));
    model.script('finance.plans', JSON.stringify({ plans: [] }));
    const { task, row } = await run('finance', monday);
    expect(JSON.parse(model.of('finance.weekly')[1]!.user).previousAttemptRejectedBecause).toEqual(['goal: "from" must be the metric\'s value exactly (48200)']);
    expect(model.of('finance.plans')).toHaveLength(2);
    expect(row).toMatchObject({ written_by: 'rule' });
    expect(row.report).toMatchObject({ writtenBy: 'rule', goal: null, paths: null, actions: [] });
    const steps = await stepsOf(task.id);
    expect(steps.find((s) => s.step === 'weekly.write')!.detail).toContain('attempts 2');
    expect(steps.find((s) => s.step === 'weekly.paths')).toMatchObject({ outcome: 'refused' });
    expect(steps.find((s) => s.step === 'weekly.paths')!.detail).toMatch(/^no paths passed their check, so the report is written from the rules \(no goal, no paths\); plans: /);
    const sms = sent.get(`weekly-sms:${row.id}`)!;
    expect(sms).toContain('written by rules');
    expect(sms.endsWith('Nothing needs your approval this week.')).toBe(true);
    expect(await rows('select id from public.approvals where message_id = (select id from public.assistant_messages where dedupe_key = $1)', [`weeklydoc:weekly:finance:${monday}`])).toEqual([]);
  });

  it('runs again after the report was stored: nothing is read or asked twice, one report is kept and no second code is sent', async () => {
    model.script('online.weekly_needs', JSON.stringify({ requests: [] }));
    model.script('online.weekly', JSON.stringify({ ...onlineWords, summary: '14 messages are waiting and 3 buyers went unanswered.' }));
    const first = await run('online');
    const calls = model.calls.length;
    expect(await handleTask(first.task, deps)).toEqual({ status: 'done' });
    expect(model.calls).toHaveLength(calls);
    expect(await rows('select id from public.weekly_reports where report_key = $1', [first.key])).toHaveLength(1);
    expect(issued.filter((i) => i.key === `weekly-sms:${first.row.id}`).map((i) => i.created)).toEqual([true, false]);
    expect(await rows('select id from public.assistant_messages where dedupe_key = $1', [`weeklystatus:${first.key}`])).toHaveLength(1);
  });

  it('a step that fails after the writers answered: the task runs again on the words and paths it kept, and no model is asked twice', async () => {
    const monday = freshMonday();
    await storeWorkerReport(googleReport(addDays(monday, -2), 'Google ads return 2.4x; little budget room is left.'));
    model.script('finance.weekly_needs', JSON.stringify({ requests: [] }));
    model.script('finance.weekly', JSON.stringify({ ...financeWords(monday), summary: 'Google ads return 2.4x on $1,800 of spend.' }));
    model.script('finance.plans', JSON.stringify(financePaths));
    const key = `weekly:finance:${monday}`;
    const task = await taskOf('finance', 'scheduled', { job: 'weekly_report', division: 'finance', date: monday }, key);
    const real = deps.store;
    deps.store = { ...real, saveWeeklyReport: async () => { throw new Error('the database went away'); } };
    try {
      await expect(handleTask(task, deps)).rejects.toThrow('the database went away');
    } finally {
      deps.store = real;
    }
    const asked = model.calls.map((c) => c.purpose);
    expect(asked.filter((p) => p === 'finance.weekly' || p === 'finance.plans')).toEqual(['finance.weekly', 'finance.plans']);

    expect(await handleTask(task, deps)).toEqual({ status: 'done' });
    expect(model.calls.map((c) => c.purpose)).toEqual(asked);
    const row = (await rows('select * from public.weekly_reports where report_key = $1', [key]))[0];
    mine.reports.add(row.id);
    expect(row).toMatchObject({ written_by: 'model' });
    expect(row.report.goal).toEqual(financeWords(monday).goal);
    expect(row.report.paths.plans.map((p: { title: string }) => p.title)).toEqual(financePaths.plans.map((p) => p.title));
    const steps = await stepsOf(task.id);
    expect(steps.filter((s) => s.step === 'weekly.write').map((s) => s.detail)).toEqual([
      'attempts 1, 4 sections, 0 actions, a goal of the week, 0 replies used', 'the words an earlier run of this report wrote and checked are used; no model was asked again',
    ]);
    const paths = steps.filter((s) => s.step === 'weekly.paths');
    expect(paths.map((s) => s.outcome)).toEqual(['ok', 'ok']);
    expect(paths[0]!.detail).toMatch(/^attempts 1, cited \d+ metrics$/);
    expect(paths[1]!.detail).toBe('the paths an earlier run of this report wrote and checked are used; no model was asked again');
  });

  it("a worker whose own run for the day is still open is not run a second time: the report names it as still running", async () => {
    const monday = freshMonday();
    await storeWorkerReport(googleReport(addDays(monday, -1), 'Google ads return 2.4x; little budget room is left.'));
    const open = (await pool.query(
      `insert into public.tasks (assistant_id, kind, idempotency_key, payload, status, run_after) values ('finance', 'scheduled', $1, $2::jsonb, 'queued', '2199-12-31T00:00:00Z') returning id`,
      [`worker:finance.email:${monday}`, JSON.stringify({ job: 'division_worker', worker: 'finance.email', date: monday })])).rows[0].id as string;
    try {
      model.script('finance.weekly_needs', JSON.stringify({ requests: [] }));
      model.script('finance.weekly', new Error('the provider is down'));
      const { task, row } = await run('finance', monday);
      expect(model.of('finance.email.report')).toEqual([]);
      expect(model.calls.map((c) => c.purpose)).toEqual(['finance.online_money.report', 'finance.salon_money.report', 'finance.weekly_needs', 'finance.weekly']);
      expect(row.report.sections.map((s: { workerId: string }) => s.workerId)).toEqual(['finance.google_ads', 'finance.online_money', 'finance.salon_money']);
      expect((await stepsOf(task.id)).find((s) => s.step === 'weekly.workers')!.detail).toContain(
        `no report: finance.email (its run for ${monday} is still queued or running, so it is not run a second time);`);
    } finally {
      await pool.query(`update public.tasks set status = 'cancelled' where id = $1`, [open]);
    }
  });

  it("the third weekly report of the day queues the weekly CEO digest: one line per division from the managers' CEO lines, texted to the owner once", async () => {
    const monday = freshMonday();
    deps.now = () => new Date('2199-12-31T00:00:00Z'); // the digest is queued for later than any test runs, so no claim loop picks it up
    const key = `digest:${monday}:weekly`;
    digests.add(key);
    await storeWorkerReport(googleReport(addDays(monday, -2), 'Google ads return 2.4x; little budget room is left.'));
    attention.online = [{ metricId: 'm:online.service.missed_sale_intent.count', level: 'act', rule: 'Buyers who asked to buy got no answer.' }];
    for (const d of ['finance', 'online', 'salon']) model.script(`${d}.weekly_needs`, JSON.stringify({ requests: [] }));
    model.script('finance.weekly', JSON.stringify(financeWords(monday)));
    model.script('finance.plans', JSON.stringify(financePaths));
    model.script('online.weekly', JSON.stringify(onlineWords));
    model.script('salon.weekly', new Error('the provider is down'));
    const digestTask = async () => (await rows('select id, status, payload from public.tasks where idempotency_key = $1', [key]))[0];
    const deliverOf = async (taskId: string) => (await stepsOf(taskId)).find((s) => s.step === 'weekly.deliver')!.detail as string;

    const finance = await run('finance', monday);
    const online = await run('online', monday);
    expect(await digestTask()).toBeUndefined(); // two of three: nothing yet
    // The day's brief line for Finance is not a weekly line: the weekly digest never reads it.
    await deps.store.postMessage({
      from: 'finance', to: 'owner', kind: 'report', replyTo: null, dedupeKey: `status:brief:finance:${monday}`,
      body: { type: 'division_status', division: 'finance', date: monday, status: 'act', ceoLine: 'A brief line, not the week.' },
    });
    const salon = await run('salon', monday);
    expect([finance.row.status, online.row.status, salon.row.status]).toEqual(['watch', 'act', 'normal']);
    expect(await deliverOf(finance.task.id)).not.toMatch(/digest/);
    expect(await deliverOf(online.task.id)).not.toMatch(/digest/);
    expect(await deliverOf(salon.task.id)).toMatch(/; all three weekly reports are in, weekly CEO digest queued$/);
    const queued = await digestTask();
    expect(queued).toMatchObject({ status: 'queued', payload: { job: 'ceo_digest', date: monday, weekOf: monday } });

    // Owner HQ writes it once and texts it once, however often its task runs.
    numbers.owner = '+12125550125';
    const task: TaskRow = { id: queued.id, assistant_id: 'owner', kind: 'scheduled', status: 'running', payload: queued.payload, attempts: 1, max_attempts: 3 };
    expect(await handleTask(task, deps)).toEqual({ status: 'done' });
    const words = [
      `Joey: weekly reports, week of ${monday}:`,
      'Salon: running normally.',
      `Finance: needs a look — ${financeWords(monday).ceoLine}`,
      `Online: needs a decision — ${onlineWords.ceoLine}`,
    ].join('\n');
    expect(sent.get(`digest-sms:${key}`)).toBe(words);
    expect(await message(`digestdoc:${key}`)).toMatchObject({ from_assistant: 'owner', to_assistant: 'owner', body: { type: 'ceo_digest', date: monday, weekOf: monday, text: words } });
    expect((await stepsOf(queued.id)).find((s) => s.step === 'digest.send')).toMatchObject({
      outcome: 'ok', detail: `text queued for the owner; weekly reports of the week of ${monday}; reports in: salon normal, finance watch, online act`,
    });
    expect(await handleTask(task, deps)).toEqual({ status: 'done' });
    expect(await rows('select id from public.outbox where dedupe_key = $1', [`digest-sms:${key}`])).toHaveLength(1);
    expect(model.calls.filter((c) => c.purpose.includes('digest'))).toEqual([]); // a program writes the digest, never a model
  });

  it('REPORT by text: the owner asks for one division or all three, a head for her own only; each run is keyed by the text', async () => {
    const arrived = `${freshMonday()}T14:00:00Z`; // a Monday in the 2100s; Wednesday's text below asks for the same week
    deps.now = () => new Date('2199-12-31T00:00:00Z'); // queued for later than any test runs, so no claim loop picks them up
    const text = async (person: string, assistant: string, body: string, at = arrived) => {
      const task = await taskOf(assistant, 'inbound_text', { from: phone[person], body, personId: person, receivedAt: at });
      const outcome = await handleTask(task, deps);
      const queued = await rows(`select idempotency_key as key, assistant_id, payload from public.tasks where idempotency_key like $1 order by idempotency_key`, [`weekly:%:${task.id}`]);
      return { task, outcome, queued, reply: sent.get(`reply:${task.id}`) };
    };
    const monday = arrived.slice(0, 10);

    const all = await text('demo-p-owner', 'owner', 'REPORT');
    expect(all.queued.map((t) => t.key)).toEqual(['finance', 'online', 'salon'].map((d) => `weekly:${d}:${monday}:${all.task.id}`));
    expect(all.queued.map((t) => t.assistant_id)).toEqual(['finance', 'online', 'salon']);
    expect(all.queued[0].payload).toEqual({ job: 'weekly_report', division: 'finance', date: monday, request: all.task.id });
    expect(all.reply).toBe('Asking George (Finance), Georgette (Online) and Cindy (Salon) for the weekly report now. Each head sees hers in her view, and you see them all on the console; their emails come to you until real data is connected.');

    const salon = await text('demo-p-owner', 'owner', 'report salon', `${addDays(monday, 2)}T15:00:00Z`);
    expect(salon.queued.map((t) => t.key)).toEqual([`weekly:salon:${monday}:${salon.task.id}`]);
    expect(salon.queued[0].payload.date).toBe(addDays(monday, 2));

    const emma = await text(HEAD.online, 'online', 'REPORT');
    expect(emma.queued.map((t) => t.key)).toEqual([`weekly:online:${monday}:${emma.task.id}`]);
    // Emma's assistant has a live number and no printer: she is told of the text, and of no printout and no email.
    expect(emma.reply).toBe('Georgette is writing your Online weekly report now. It will reach you in your view on the console and by text when it is ready.');
    numbers.online = null;
    deps.printers = { online: 'printer-1' };
    const noText = await text(HEAD.online, 'online', 'REPORT');
    deps.printers = {};
    expect(noText.reply).toBe('Georgette is writing your Online weekly report now. It will reach you in your view on the console and on your printer when it is ready.');

    const notHers = await text(HEAD.online, 'online', 'REPORT FINANCE');
    expect(notHers.queued).toEqual([]);
    expect(notHers.reply).toBe("You can ask for your own division's report: text REPORT. Nothing was started.");
    expect((await stepsOf(notHers.task.id))).toMatchObject([{ step: 'weekly.request', outcome: 'refused' }]);
    expect(model.calls).toHaveLength(0);
  });

  it("a division brief's code still approves the brief's actions, as before weekly reports shared the APPROVE route", async () => {
    const date = freshMonday();
    model.script('online.needs', JSON.stringify({ requests: [] }));
    model.script('online.brief', JSON.stringify({
      headline: '14 messages are waiting.', findings: [{ text: '14 messages are waiting.', cites: ['m:online.service.waiting_now.count'] }],
      actions: [{ rank: 1, title: 'Answer the waiting buyers', why: '3 buyers went unanswered.', steps: 'Answer them today.', cites: ['m:online.service.missed_sale_intent.count'] }],
      ceoLine: 'Online is running normally.',
    }));
    const task = await taskOf('online', 'scheduled', { job: 'division_brief', division: 'online', date }, `brief:online:${date}`);
    expect(await handleTask(task, deps)).toEqual({ status: 'done' });
    const brief = (await rows('select id from public.division_briefs where brief_key = $1', [`brief:online:${date}`]))[0];
    briefs.add(brief.id);
    const code = codeIn(sent.get(`brief-sms:${brief.id}`));
    expect((await approve(HEAD.online, `APPROVE 2 ${code}`)).reply).toBe('This brief has no action 2. Nothing was recorded, and your code still works.');
    expect((await approve(HEAD.online, `APPROVE 1 ${code}`)).reply).toBe("Recorded: you approved action 1 (Answer the waiting buyers). It's yours to carry out.");
    const doc = await message(`briefdoc:brief:online:${date}`);
    expect((await message(`action-decision:${doc.id}:1`)).body).toEqual({
      type: 'action_decision', briefId: brief.id, division: 'online', rank: 1, title: 'Answer the waiting buyers', verdict: 'approved', by: HEAD.online,
    });
  });

  it('refuses a weekly job for the wrong assistant, an unknown division or a bad date', async () => {
    const wrong = await taskOf('online', 'scheduled', { job: 'weekly_report', division: 'finance', date: freshMonday() });
    expect(await handleTask(wrong, deps)).toEqual({ status: 'failed', error: 'the finance weekly report belongs to the finance assistant, not the online assistant' });
    for (const payload of [{ division: 'hq', date: '2100-01-04' }, { division: 'finance', date: 'monday' }, { division: 'finance' }]) {
      const task = await taskOf('finance', 'scheduled', { job: 'weekly_report', ...payload });
      expect(await handleTask(task, deps)).toEqual({ status: 'failed', error: 'the weekly report job needs a division (finance, online or salon) and a date (YYYY-MM-DD)' });
    }
    expect(model.calls).toHaveLength(0);
    // The database keeps a weekly report's key to its division and a Monday.
    await expect(pool.query(`insert into public.weekly_reports (division, report_key, week_of, period, status, written_by, report, ceo_line)
      values ('finance', 'weekly:online:2100-01-04', '2100-01-04', 'p', 'normal', 'model', '{}'::jsonb, 'c')`)).rejects.toThrow(/weekly_reports_check/);
  });
});
