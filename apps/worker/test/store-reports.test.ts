import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import type { WorkerId } from '@fahq/contracts';
import { createStore } from '../src/store.ts';
import { weeklyReport, workerReport } from '../../../packages/delivery/test/report-fixtures.ts';
import { dbUrl, localApi } from './localdb.ts';

// The store's delivery reads on the real local database (no mocks). Skipped when the stack is down.
// Run it under the shared lock: flock ~/.fahq-db-test.lock npx vitest run apps/worker/test/store-reports.test.ts

const api = localApi();
if (!api) console.warn('SKIPPED store-reports tests: needs local Supabase (npm run db:start)');
const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });

// A Monday far in the future, so these rows never mix with the dates other tests use. They are removed again.
const MONDAY = '2099-12-28';
const workerIds: string[] = [];
const weeklyIds: string[] = [];
afterAll(async () => {
  try {
    if (workerIds.length) await pool.query('delete from public.worker_reports where id = any($1)', [workerIds]);
    if (weeklyIds.length) await pool.query('delete from public.weekly_reports where id = any($1)', [weeklyIds]);
  } finally {
    await pool.end();
  }
});

async function addWorkerReport(id: WorkerId, report: unknown = workerReport(id)): Promise<string> {
  const { rows } = await pool.query(
    `insert into public.worker_reports (worker_id, division, report_key, report_date, period, status, written_by, report)
     values ($1, split_part($1, '.', 1), $2, $3, '2026-10-mtd', 'normal', 'model', $4::jsonb) returning id`,
    [id, `worker:${id}:${MONDAY}:${randomUUID()}`, MONDAY, JSON.stringify(report)],
  );
  workerIds.push(rows[0].id as string);
  return rows[0].id as string;
}

async function addWeeklyReport(report: unknown, division = 'finance'): Promise<string> {
  const { rows } = await pool.query(
    `insert into public.weekly_reports (division, report_key, week_of, period, status, written_by, report, ceo_line)
     values ($4, $1, $2, '2026-10-mtd', 'watch', 'model', $3::jsonb, 'Finance is healthy.') returning id`,
    [`weekly:${division}:${MONDAY}:${randomUUID()}`, MONDAY, JSON.stringify(report), division],
  );
  weeklyIds.push(rows[0].id as string);
  return rows[0].id as string;
}

describe.skipIf(!api)('store: the reads delivery needs (real local database)', () => {
  const store = createStore(api!.url, api!.key);

  it('reads a weekly report back exactly as it was stored', async () => {
    const weekly = weeklyReport('finance');
    const id = await addWeeklyReport(weekly);
    expect(await store.weeklyReportById(id)).toEqual({ id, report: weekly });
  });

  it('reads one worker report, and returns null for an id with no row', async () => {
    const id = await addWorkerReport('finance.meta');
    expect(await store.workerReportById(id)).toEqual(workerReport('finance.meta'));
    expect(await store.workerReportById(randomUUID())).toBeNull();
    expect(await store.weeklyReportById(randomUUID())).toBeNull();
  });

  it('reads the worker reports of a packet in the order of the registry, and leaves out an id with no row', async () => {
    const walmart = await addWorkerReport('finance.walmart');
    const email = await addWorkerReport('finance.email');
    const meta = await addWorkerReport('finance.meta');
    const reports = await store.workerReportsByIds('finance', [walmart, randomUUID(), email, meta]);
    expect(reports.map((r) => r.workerId)).toEqual(['finance.email', 'finance.meta', 'finance.walmart']);
    expect(await store.workerReportsByIds('finance', [])).toEqual([]);
  });

  it("never reads another division's report into a packet, even when its id is listed", async () => {
    const email = await addWorkerReport('finance.email');
    const clients = await addWorkerReport('salon.clients');
    expect((await store.workerReportsByIds('finance', [email, clients])).map((r) => r.workerId)).toEqual(['finance.email']);
    expect((await store.workerReportsByIds('salon', [email, clients])).map((r) => r.workerId)).toEqual(['salon.clients']);
  });

  it("leaves out a worker report that is malformed or is another worker's, so the packet can say it could not be loaded", async () => {
    const email = await addWorkerReport('finance.email');
    const malformed = await addWorkerReport('finance.meta', { workerId: 'finance.meta', headline: 'secret words' });
    const swapped = await addWorkerReport('finance.amazon', workerReport('finance.walmart'));
    const reports = await store.workerReportsByIds('finance', [email, malformed, swapped]);
    expect(reports.map((r) => r.workerId)).toEqual(['finance.email']);
  });

  it('refuses a stored report that no longer matches its contract, with a fixed sentence and none of its words', async () => {
    const id = await addWeeklyReport({ ...weeklyReport('finance'), summary: 'secret words that must not reach a log', status: 'on fire' });
    const error = (await store.weeklyReportById(id).then(() => null, (e: unknown) => e)) as Error;
    expect(error.message).toBe('the stored weekly report does not match its contract');
    const worker = await addWorkerReport('finance.email', { workerId: 'finance.email', headline: 'secret words' });
    expect(((await store.workerReportById(worker).then(() => null, (e: unknown) => e)) as Error).message).toBe('the stored worker report does not match its contract');
  });

  it("refuses a report that is not the one its row says it is (the row's division, the row's worker)", async () => {
    const wrongDivision = await addWeeklyReport(weeklyReport('finance'), 'online');
    expect(((await store.weeklyReportById(wrongDivision).then(() => null, (e: unknown) => e)) as Error).message).toBe('the stored weekly report does not match its contract');
    const wrongWorker = await addWorkerReport('finance.meta', workerReport('finance.email'));
    expect(((await store.workerReportById(wrongWorker).then(() => null, (e: unknown) => e)) as Error).message).toBe('the stored worker report does not match its contract');
  });
});
