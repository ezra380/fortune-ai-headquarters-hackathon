import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../src/days.ts';
import { createDivisionsLoader, createReportLoader } from '../src/loader.ts';
import { shapeDivisions } from '../src/shape.ts';
import { dbUrl, localApi } from '../../worker/test/localdb.ts';
import { weeklyReport, workerReport } from './reports-fixtures.ts';

// The wave-2 reads against the real local database, through the real query builder: this is what proves the filters, the ordering and
// the `or` for a head's view are accepted (the recording fake in reports-loader.test.ts cannot). The rows are written with SQL, shaped
// like the ones the worker writes, and removed afterwards. They sit in a random week of the years 8000 to 9000 and the loader is
// given a clock in that week, so they are the only rows its seven-day window sees and no other test's rows are read or changed.

const api = localApi();
if (!api) console.warn('SKIPPED console wave-2 reports database test: needs local Supabase (npm run db:start)');

const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
afterAll(async () => pool.end());

// A Monday far in the future, and the Wednesday of that week as "today".
const START = new Date(Date.UTC(8000, 0, 1) + randomInt(0, 365_000) * 86_400_000).toISOString().slice(0, 10);
const MONDAY = (() => {
  let day = START;
  while (new Date(`${day}T12:00:00Z`).getUTCDay() !== 1) day = addDays(day, 1);
  return day;
})();
const TODAY = addDays(MONDAY, 2);
const CLOCK = () => new Date(`${TODAY}T16:00:00Z`);
// Letters only: the console masks any run of six digits as a code (redactCodes), so an all-digit tag (783407) failed the merge run once.
const TAG = randomBytes(3).toString('hex').replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)]!);

describe.skipIf(!api)('the wave-2 reads on the real local database', () => {
  const messages: string[] = [];
  const workerKeys: string[] = [];
  const weeklyKeys: string[] = [];
  const ids = {} as Record<string, string>;

  const db = () => createClient(api!.url, api!.key, { auth: { persistSession: false, autoRefreshToken: false } });

  async function worker(id: 'finance.email' | 'finance.meta' | 'finance.google_ads' | 'salon.clients', day: string, headline?: string, createdAt?: string): Promise<string> {
    const division = id.split('.')[0]!;
    const key = `worker:${id}:${day}`;
    workerKeys.push(key);
    const report = workerReport(id, { day, ...(headline ? { headline } : {}) });
    const r = await pool.query<{ id: string }>(
      `insert into public.worker_reports (worker_id, division, report_key, report_date, period, status, written_by, report, data_source, created_at)
       values ($1, $2, $3, $4, $5, $6, 'model', $7::jsonb, $8, coalesce($9::timestamptz, now())) returning id`,
      [id, division, key, day, report.period, report.status, JSON.stringify(report), report.dataSource, createdAt ?? null],
    );
    return r.rows[0]!.id;
  }

  async function note(dedupe: string, body: unknown, replyTo?: string, from = 'finance', to = 'finance', kind = 'report'): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `insert into public.assistant_messages (from_assistant, to_assistant, kind, body, reply_to, dedupe_key, created_at)
       values ($1, $2, $3, $4::jsonb, $5, $6, '9000-01-01T00:00:00Z') returning id`,
      [from, to, kind, JSON.stringify(body), replyTo ?? null, dedupe],
    );
    messages.push(r.rows[0]!.id);
    return r.rows[0]!.id;
  }

  beforeAll(async () => {
    ids.email = await worker('finance.email', TODAY, 'Email today');
    await worker('finance.email', addDays(TODAY, -1), 'Email yesterday');
    await worker('finance.email', addDays(MONDAY, -5), 'Email last week (outside the seven days)');
    ids.google = await worker('finance.google_ads', TODAY);
    // Meta has nothing in the last seven days: its newest report is older and is read on its own.
    ids.meta = await worker('finance.meta', addDays(MONDAY, -5));
    await worker('salon.clients', TODAY, 'Salon clients today');

    // The weekly report of finance, sent with a note, one code used and path 2 approved.
    const noteId = await note(`weeklydoc-${TAG}`, { type: 'weekly_report', division: 'finance' });
    const weekly = weeklyReport('finance', { weekOf: MONDAY, workerReportIds: [ids.email!, ids.google!, ids.meta!] });
    weeklyKeys.push(`weekly:finance:${MONDAY}`);
    const w = await pool.query<{ id: string }>(
      `insert into public.weekly_reports (division, report_key, week_of, period, status, written_by, report, ceo_line, data_source, message_id)
       values ('finance', $1, $2, $3, $4, 'model', $5::jsonb, $6, $7, $8) returning id`,
      [`weekly:finance:${MONDAY}`, MONDAY, weekly.period, weekly.status, JSON.stringify(weekly), weekly.ceoLine, weekly.dataSource, noteId],
    );
    ids.weekly = w.rows[0]!.id;
    await pool.query(
      `insert into public.approvals (message_id, approver_person_id, action, code_hash, status, expires_at, decided_at, created_at)
       values ($1, 'demo-p-finance-owner', 'approve_action', $2, 'signed', '9000-01-02T00:00:00Z', '9000-01-01T00:20:00Z', '9000-01-01T00:10:00Z')`,
      [noteId, randomBytes(32).toString('hex')],
    );
    await note(`action-decision:${noteId}:2`, { type: 'action_decision', division: 'finance', rank: 2, title: 'A path', verdict: 'approved', by: 'demo-p-finance-owner' }, noteId, 'finance', 'manager', 'decision');

    // Two questions: finance asked online; salon asked online. A finance head should see the first only.
    await note(`datareq:weekly:${TAG}:a`, { type: 'data_request', question: `What did online do ${TAG}?` }, undefined, 'finance', 'online', 'request');
    await note(`datareq:weekly:${TAG}:b`, { type: 'data_request', question: `What did salon ask ${TAG}?` }, undefined, 'salon', 'online', 'request');
  });

  afterAll(async () => {
    if (!api) return;
    await pool.query('delete from public.weekly_reports where report_key = any($1::text[])', [weeklyKeys]);
    await pool.query('delete from public.worker_reports where report_key = any($1::text[])', [workerKeys]);
    await pool.query('delete from public.approvals where message_id = any($1::uuid[])', [messages]);
    await pool.query('delete from public.assistant_messages where id = any($1::uuid[]) and reply_to is not null', [messages]);
    await pool.query('delete from public.assistant_messages where id = any($1::uuid[])', [messages]);
  });

  it('reads the seven days of each worker and the newest of a worker with none, without a note', async () => {
    const loaded = await createDivisionsLoader({ db: db(), now: CLOCK })();
    const finance = loaded.divisions.find((d) => d.division === 'finance')!;
    expect(finance.reports!.unread).toEqual([]);
    expect(loaded.notes.filter((n) => /worker reports|weekly report/.test(n))).toEqual([]);

    const view = shapeDivisions(loaded, CLOCK()).divisions;
    const by = Object.fromEntries(view.find((d) => d.id === 'finance')!.reports.workers.map((w) => [w.workerId, w]));
    expect(by['finance.email']!.state).toBe('ok');
    expect(by['finance.email']!.latest!.headline).toBe('Email today');
    // Today and yesterday; the day before the week started is not in the week.
    expect(by['finance.email']!.week.map((d) => d.day)).toEqual([TODAY, addDays(TODAY, -1)]);
    expect(by['finance.email']!.week.map((d) => d.headline)).toEqual(['Email today', 'Email yesterday']);
    expect(by['finance.google_ads']!.stale).toBe(false);
    // Meta's only report is older than the week: still shown, marked old.
    expect(by['finance.meta']).toMatchObject({ state: 'ok', stale: true, week: [] });
    expect(by['finance.meta']!.latest!.day).toBe(addDays(MONDAY, -5));
    // The others have not reported.
    expect(by['finance.amazon']).toMatchObject({ state: 'none', latest: null });
    // Another division's worker is never mixed in.
    expect(JSON.stringify(view.find((d) => d.id === 'finance'))).not.toContain('Salon clients today');
    expect(view.find((d) => d.id === 'salon')!.reports.workers.find((w) => w.workerId === 'salon.clients')!.latest!.headline).toBe('Salon clients today');
  });

  it('reads the weekly report with the code and the decision recorded against its own note', async () => {
    const loaded = await createDivisionsLoader({ db: db(), now: CLOCK })();
    const weekly = shapeDivisions(loaded, CLOCK()).divisions.find((d) => d.id === 'finance')!.reports.weekly!;
    expect(weekly).toMatchObject({ id: ids.weekly, weekOf: MONDAY, sent: true, status: 'act' });
    expect(weekly.goal).not.toBeNull();
    expect(weekly.options.map((o) => o.approval.state)).toEqual(['not_approved', 'approved', 'not_approved']);
    // Nothing of the row's bookkeeping reaches the view.
    const text = JSON.stringify(weekly);
    expect(text).not.toMatch(/demo-p-|code_hash|task_id|message_id/);
  });

  it('reads a head\'s own view with that division\'s questions only and no digest', async () => {
    const loaded = await createDivisionsLoader({ db: db(), now: CLOCK })('finance');
    expect(loaded.divisions.map((d) => d.division)).toEqual(['finance']);
    expect(loaded.digest).toBeNull();
    const questions = shapeDivisions(loaded, CLOCK(), 'finance').divisions[0]!.asked.map((q) => q.question);
    expect(questions).toContain(`What did online do ${TAG}?`);
    expect(questions).not.toContain(`What did salon ask ${TAG}?`);
    expect(loaded.notes.filter((n) => /worker reports|weekly report|data requests/.test(n))).toEqual([]);
  });

  it('reads the reports behind a PDF by id: a weekly report with its workers in order, one worker\'s report, and nothing for an unknown id', async () => {
    const load = createReportLoader({ db: db() });
    const packet = await load('weekly', ids.weekly!);
    if (packet?.kind !== 'weekly') throw new Error('expected a weekly packet');
    expect(packet.division).toBe('finance');
    expect(packet.workers.map((w) => w.workerId)).toEqual(['finance.email', 'finance.google_ads', 'finance.meta']);
    const one = await load('worker', ids.google!);
    expect(one).toMatchObject({ kind: 'worker', division: 'finance' });
    expect(await load('weekly', randomUUID())).toBeNull();
    expect(await load('worker', randomUUID())).toBeNull();
  });
});
