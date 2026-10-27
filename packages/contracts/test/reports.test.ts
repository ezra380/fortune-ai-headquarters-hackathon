import { describe, expect, it } from 'vitest';
import { MANAGERS, WORKER_IDS, WeeklyReport, WorkerReport, workerDivision, type Plan } from '../src/index.ts';

const metric = {
  id: 'm:online.revenue',
  label: 'Online revenue',
  value: 12400,
  unit: 'usd',
  business: 'online',
  period: '2026-10-mtd',
  source: { system: 'zetaris', view: 'fortune_demo_v2_finance_mart.period_metrics', queryHash: 'a'.repeat(64), asOf: '2026-10-26T23:59:00-04:00' },
} as const;

const worker = {
  workerId: 'finance.email',
  day: '2026-10-27',
  period: '2026-10-mtd',
  status: 'watch',
  writtenBy: 'model',
  headline: 'Email is steady.',
  findings: [{ text: 'Online revenue is $12,400 so far this month.', cites: ['m:online.revenue'] }],
  metrics: [metric],
  attention: [{ metricId: 'm:online.revenue', level: 'watch', rule: 'A rule fired.' }],
  rows: [{ read: 'products', totals: { count: 3 } }],
  dataSource: 'fortune_demo_v2_finance_mart#aaaaaaaaaaaa',
};

const plan = (rank: number): Plan => ({
  rank,
  title: `Path number ${rank}`,
  summary: 'A path.',
  actions: ['Do one thing.'],
  evidence: [{ metricId: 'm:online.revenue', value: 12400 }],
  projections: [],
  levers: [],
  test: 'One week.',
  stopLoss: 'Stop if revenue falls.',
  businesses: ['online'],
  risks: [],
});

const weekly = (division: 'finance' | 'online' | 'salon', extra: Partial<Record<string, unknown>> = {}) => ({
  division,
  weekOf: '2026-10-26',
  manager: MANAGERS[division].manager,
  head: MANAGERS[division].head,
  period: '2026-10-mtd',
  status: 'normal',
  writtenBy: 'model',
  summary: 'Running normally.',
  sections: [{ workerId: `${division === 'salon' ? 'salon.clients' : division === 'online' ? 'online.messages' : 'finance.email'}`, status: 'normal', summary: 'Fine.', cites: [] }],
  asked: [],
  goal: null,
  paths: null,
  actions: [],
  ceoLine: 'Running normally.',
  metrics: [metric],
  workerReportIds: [],
  dataSource: 'fortune_demo_v2_finance_mart#aaaaaaaaaaaa',
  ...extra,
});

const goal = { title: 'Lift online revenue', metricId: 'm:online.revenue', from: 12400, to: 13000, by: '2026-11-02', why: 'Because.' };
const paths = { plans: [plan(1), plan(2), plan(3)], memoryConflicts: [] };

describe('wave 2 report contracts', () => {
  it('names a manager and a head for each managed division', () => {
    expect(MANAGERS.finance).toMatchObject({ manager: 'George', head: 'Alan' });
    expect(MANAGERS.online).toMatchObject({ manager: 'Georgette', head: 'Emma' });
    expect(MANAGERS.salon).toMatchObject({ manager: 'Cindy', head: 'Esther' });
  });

  it('reads each worker\'s division from its id, and every worker belongs to a managed division', () => {
    expect(WORKER_IDS).toHaveLength(15);
    expect(workerDivision('finance.walmart')).toBe('finance');
    expect(workerDivision('online.site_content')).toBe('online');
    expect(workerDivision('salon.turnaround')).toBe('salon');
    for (const id of WORKER_IDS) expect(Object.keys(MANAGERS)).toContain(workerDivision(id));
  });

  it('accepts a worker report and refuses one with an unknown worker or no numbers', () => {
    expect(WorkerReport.safeParse(worker).success).toBe(true);
    expect(WorkerReport.safeParse({ ...worker, workerId: 'finance.tiktok' }).success).toBe(false);
    expect(WorkerReport.safeParse({ ...worker, metrics: [] }).success).toBe(false);
  });

  it('holds George to a goal of the week and three paths when a model wrote his report', () => {
    expect(WeeklyReport.safeParse(weekly('finance', { goal, paths })).success).toBe(true);
    expect(WeeklyReport.safeParse(weekly('finance')).success).toBe(false);
    expect(WeeklyReport.safeParse(weekly('finance', { goal })).success).toBe(false);
    // A report the program wrote from the rules has neither.
    expect(WeeklyReport.safeParse(weekly('finance', { writtenBy: 'rule' })).success).toBe(true);
  });

  it('gives a goal and paths to the finance report only', () => {
    expect(WeeklyReport.safeParse(weekly('online')).success).toBe(true);
    expect(WeeklyReport.safeParse(weekly('online', { goal, paths })).success).toBe(false);
    expect(WeeklyReport.safeParse(weekly('salon', { goal: null, paths })).success).toBe(false);
  });

  it('accepts the new time and score units on a metric', () => {
    for (const unit of ['minutes', 'days', 'seconds', 'score']) {
      expect(WorkerReport.safeParse({ ...worker, metrics: [{ ...metric, unit }] }).success).toBe(true);
    }
  });
});
