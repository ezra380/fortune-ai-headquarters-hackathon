import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { weeklyReportRef, type WorkerId } from '@fahq/contracts';
import { createDeliveryPort } from '@fahq/delivery';
import { createReportLoader } from '../../console/src/loader.ts';
import { startConsoleServer, type RunningConsole } from '../../console/src/server.ts';
import { pdfPages } from '../../../packages/delivery/test/pdf-text.ts';
import { weeklyReport, workerReport } from '../../../packages/delivery/test/report-fixtures.ts';
import type { WorkerDeps } from '../src/flows.ts';
import { flushOutbox } from '../src/outbox.ts';
import { createStore, type OutboxRow, type Store } from '../src/store.ts';
import { dbUrl, localApi } from './localdb.ts';

// The report emails on the REAL local database (no mocks of the database): two senders racing for one email row, and the emailed
// packet against the packet the console's PDF link opens. Postmark itself is a counting fake. Skipped when the stack is down.
// Run it under the shared lock: flock ~/.fahq-db-test.lock npx vitest run apps/worker/test/outbox-reports-db.test.ts

const api = localApi();
if (!api) console.warn('SKIPPED outbox-reports-db tests: needs local Supabase (npm run db:start)');
const pool = new pg.Pool({ connectionString: dbUrl, max: 3 });

// A Monday far in the future, so these rows never mix with the dates other tests use. Everything is removed again.
const MONDAY = '2099-12-21';
const OWNER = 'owner@example.com';
const env = { POSTMARK_HQ_SERVER_TOKEN: 'pm-test-only-token', POSTMARK_HQ_FROM: 'reports@example.com' } as NodeJS.ProcessEnv;
const workerIds: string[] = [];
const weeklyIds: string[] = [];
const outboxIds: string[] = [];
const running: RunningConsole[] = [];

afterEach(async () => {
  while (running.length) await running.pop()!.close();
});
afterAll(async () => {
  try {
    if (outboxIds.length) await pool.query('delete from public.outbox where id = any($1)', [outboxIds]);
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

async function addWeeklyReport(workerReportIds: string[]): Promise<string> {
  const report = weeklyReport('finance', { weekOf: MONDAY, workerReportIds });
  const { rows } = await pool.query(
    `insert into public.weekly_reports (division, report_key, week_of, period, status, written_by, report, ceo_line)
     values ('finance', $1, $2, '2026-10-mtd', 'watch', 'model', $3::jsonb, 'Finance is healthy.') returning id`,
    [`weekly:finance:${MONDAY}:${randomUUID()}`, MONDAY, JSON.stringify(report)],
  );
  weeklyIds.push(rows[0].id as string);
  return rows[0].id as string;
}

async function addEmailRow(store: Store, weeklyId: string): Promise<string> {
  const dedupeKey = `test:outbox-reports-db:${randomUUID()}`;
  await store.addOutbox({ channel: 'email', toPersonId: 'demo-p-finance-owner', from: 'finance', body: 'Weekly report', attachmentRef: weeklyReportRef(weeklyId), dedupeKey });
  const { rows } = await pool.query('select id from public.outbox where dedupe_key = $1', [dedupeKey]);
  outboxIds.push(rows[0].id as string);
  return rows[0].id as string;
}

/** A Postmark that counts what it is sent. It answers slowly, so two senders really are inside the send at the same moment. */
function postmark() {
  const sends: { Attachments: { Content: string }[]; To: string }[] = [];
  const fetchFake = (async (_url: string, init: RequestInit) => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    sends.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ To: OWNER, MessageID: `pm-message-${sends.length}`, ErrorCode: 0 }), { status: 200 });
  }) as unknown as typeof fetch;
  return { sends, fetchFake };
}

/** One sender: its own store connection and its own delivery port (so its own once-ledger), looking at this one row only. */
function sender(rowId: string, fetchFake: typeof fetch): WorkerDeps {
  const store = createStore(api!.url, api!.key);
  const port = createDeliveryPort(env, { fetch: fetchFake, now: () => new Date('2026-10-26T12:00:00Z'), sentLedger: new Set<string>() });
  return {
    store: {
      ...store,
      // Other tests' rows are not this test's to send or to close.
      pendingOutbox: async () => (await store.pendingOutbox(200)).filter((r: OutboxRow) => r.id === rowId),
      strandedOutbox: async () => [] as OutboxRow[],
    },
    delivery: port, smsLive: false, printers: {}, printDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fahq-outbox-db-')), now: () => new Date('2026-10-26T12:00:00Z'), reportTo: OWNER,
  } as unknown as WorkerDeps;
}

describe.skipIf(!api)('report emails on the real local database', () => {
  const store = () => createStore(api!.url, api!.key);

  it('sends one email when two senders race for the same row (Law 3: the database decides who sends)', async () => {
    const weeklyId = await addWeeklyReport([await addWorkerReport('finance.email')]);
    const rowId = await addEmailRow(store(), weeklyId);
    const fake = postmark();
    await Promise.all([flushOutbox(sender(rowId, fake.fetchFake)), flushOutbox(sender(rowId, fake.fetchFake))]);
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]!.To).toBe(OWNER);
    const { rows } = await pool.query('select status, provider_ref, attempts from public.outbox where id = $1', [rowId]);
    expect(rows[0]).toMatchObject({ status: 'sent', provider_ref: 'pm-message-1', attempts: 0 });
    // and flushing again later sends nothing more
    await flushOutbox(sender(rowId, fake.fetchFake));
    expect(fake.sends).toHaveLength(1);
  });

  it("emails the very packet the console's PDF link opens, from the same rows: only its own division, a bad row left out", async () => {
    const email = await addWorkerReport('finance.email');
    const meta = await addWorkerReport('finance.meta');
    const clients = await addWorkerReport('salon.clients'); // another division's report, listed by mistake
    const malformed = await addWorkerReport('finance.google_ads', { workerId: 'finance.google_ads', headline: 'secret words' });
    const swapped = await addWorkerReport('finance.amazon', workerReport('finance.walmart')); // a row that holds another worker's report
    const weeklyId = await addWeeklyReport([meta, clients, malformed, email, swapped, randomUUID()]);

    const rowId = await addEmailRow(store(), weeklyId);
    const fake = postmark();
    await flushOutbox(sender(rowId, fake.fetchFake));
    expect(fake.sends).toHaveLength(1);
    const emailed = Buffer.from(fake.sends[0]!.Attachments[0]!.Content, 'base64');

    const site = await startConsoleServer({
      load: async () => { throw new Error('not used'); },
      loadDivisions: async () => { throw new Error('not used'); },
      loadReport: createReportLoader({ db: createClient(api!.url, api!.key, { auth: { persistSession: false, autoRefreshToken: false } }) }),
      now: () => new Date('2026-10-26T12:00:00Z'),
      log: () => {},
    }, 0);
    running.push(site);
    const res = await fetch(`${site.url}/report/weekly/${weeklyId}.pdf`);
    expect(res.status).toBe(200);
    const opened = Buffer.from(await res.arrayBuffer());
    expect(Buffer.compare(emailed, opened)).toBe(0);

    // What is in it: the manager's pages, then Email and Meta only; the cover says four of the six could not be loaded.
    const pages = await pdfPages(new Uint8Array(emailed));
    expect(pages[0]).toMatch(/4 of 6 worker reports could not be loaded/);
    expect(pages.filter((p) => p.includes('Daily report for'))).toHaveLength(2);
    expect(pages.join(' ')).not.toContain('Clients');
    expect(pages.join(' ')).not.toContain('secret words');
  });
});
