import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssistantId, type ManagerReview } from '@fahq/contracts';
import { ProfileRow, READ_TOOL_NAMES, seedProfiles } from '@fahq/profiles';
import { createStore } from '../src/store.ts';
import { dbUrl, localApi } from './localdb.ts';

// The store's calls for what the HQ Manager changes, on the real local database through the real Data API (no mocks).
// A profile version can never be taken back from the real table, so nothing here writes one: the profile reads
// are checked on the seeded rows, and the guarded write is called from a version the profile is not at, which must
// write nothing. What a write does is tested on a throwaway database (supabase/tests) and through the manager (manager.test.ts).

const api = localApi();
if (!api) console.warn('SKIPPED store tests for the manager\'s changes: needs local Supabase (npm run db:start)');
const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
const KEY = 'store-manager-test:';
let tokenId = '';
let migrated = false;

beforeAll(async () => {
  try {
    migrated = (await pool.query(`select count(*)::int as n from information_schema.columns where table_name = 'recommendations' and column_name = 'kind'`)).rows[0].n === 1;
    if (!migrated) return console.warn('SKIPPED store tests for the manager\'s changes: apply supabase/migrations/20261027100100_manager_decides.sql');
    await seedProfiles(pool, {}); // an assistant with no row gets one; the others are left alone
    tokenId = (await pool.query(`insert into public.door_tokens (assistant_id, token_hash, label) values ('finance', $1, 'store manager test') returning id`, [randomBytes(32).toString('hex')])).rows[0].id;
  } catch {
    migrated = false;
  }
});

afterAll(async () => {
  try {
    if (tokenId) {
      await pool.query('delete from public.session_reports where token_id = $1', [tokenId]);
      await pool.query('delete from public.door_tokens where id = $1', [tokenId]);
    }
    await pool.query(`delete from public.recommendations where review_id in (select id from public.manager_reviews where review_key like '${KEY}%')`);
    await pool.query(`delete from public.manager_reviews where review_key like '${KEY}%'`);
    await pool.query(`delete from public.tasks where idempotency_key like '${KEY}%'`);
  } finally {
    await pool.end();
  }
});

const review: ManagerReview = { summary: 'One thing to do.', findings: [], recommendations: [{ rank: 1, assistant: 'finance', change: 'Name the month.', why: 'It was missing.' }] };
const T0 = new Date('2026-10-27T12:00:00Z');

describe.skipIf(!api)('store: what the HQ Manager changes (real local database and Data API)', () => {
  const store = createStore(api!.url, api!.key);
  const reviewWith = async () => {
    const saved = await store.saveManagerReview({ key: KEY + randomUUID(), taskId: null, coversFrom: new Date('2026-10-26T12:00:00Z'), coversTo: T0, reportCount: 1, review, digest: {}, model: 'm' });
    return saved.id;
  };

  it('saves a recommendation with its kind and typed detail once per rank, and an older caller\'s is a lesson', async ({ skip }) => {
    if (!migrated) skip();
    const id = await reviewWith();
    const typed = [
      { rank: 1, assistant: 'finance' as const, kind: 'reads' as const, change: 'Read tools: add usage_summary', why: 'x', detail: { reads: { add: ['usage_summary'], remove: [] } } },
      { rank: 2, assistant: 'online' as const, kind: 'model' as const, change: 'Model for answer: m', why: 'y', detail: { model: { job: 'answer' as const, model: 'm' } } },
      { rank: 3, assistant: 'owner' as const, change: 'An older caller sends no kind.', why: 'z' },
    ];
    const first = await store.saveRecommendations(id, typed);
    expect(first.map((r) => [r.rank, r.kind, r.detail, r.status, r.applied_by, r.applied_version, r.decided_by])).toEqual([
      [1, 'reads', { reads: { add: ['usage_summary'], remove: [] } }, 'proposed', null, null, null],
      [2, 'model', { model: { job: 'answer', model: 'm' } }, 'proposed', null, null, null],
      [3, 'lesson', {}, 'proposed', null, null, null],
    ]);
    const again = await store.saveRecommendations(id, [{ ...typed[0]!, kind: 'lesson', change: 'Changed later.' }]);
    expect(again[0]).toMatchObject({ id: first[0]!.id, kind: 'reads', change: 'Read tools: add usage_summary' }); // a retry keeps what was saved
    expect((await store.recommendationsOf(id, [3, 1])).map((r) => r.rank)).toEqual([1, 3]); // in rank order, only the ranks asked for
    expect((await store.recommendationsOf(id)).map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(await store.recommendationsOf(id, [])).toEqual([]);
  });

  it('puts a proposed recommendation in force for the first caller only, and records who and which version', async ({ skip }) => {
    if (!migrated) skip();
    const id = await reviewWith();
    const [a, b] = await store.saveRecommendations(id, [{ ...review.recommendations[0]!, rank: 1 }, { ...review.recommendations[0]!, rank: 2, assistant: 'online' }]);
    const now = new Date(); // the standing lessons are the newest adopted ones, so these must be newer than any other test's
    expect(await store.putInForce(a!.id, { by: 'manager', personId: null, version: 7, now })).toBe(true);
    expect(await store.putInForce(a!.id, { by: 'owner', personId: 'demo-p-owner', version: 8, now })).toBe(false); // already in force: the first caller's record stands
    expect(await store.putInForce(b!.id, { by: 'owner', personId: 'demo-p-owner', version: null, now })).toBe(true);
    const [one, two] = await store.recommendationsOf(id);
    expect(one).toMatchObject({ status: 'adopted', applied_by: 'manager', applied_version: 7, decided_by: null });
    expect(two).toMatchObject({ status: 'adopted', applied_by: 'owner', applied_version: null, decided_by: 'demo-p-owner' });
    expect(new Date(one!.decided_at!).toISOString()).toBe(now.toISOString());
    const lessons = await store.adoptedLessons(undefined, 200); // the standing lessons see both
    expect(lessons.map((l) => l.id)).toEqual(expect.arrayContaining([a!.id, b!.id]));
  });

  it('closes a recommendation the program would not apply, with the reason, and never reopens or adopts it', async ({ skip }) => {
    if (!migrated) skip();
    const id = await reviewWith();
    const [rec] = await store.saveRecommendations(id, [{ ...review.recommendations[0]!, rank: 1 }]);
    expect(await store.refuseRecommendation(rec!.id, { refused: 'the lesson was not accepted: it is not one line' })).toBe(true);
    expect(await store.refuseRecommendation(rec!.id, { refused: 'again' })).toBe(false);
    expect(await store.putInForce(rec!.id, { by: 'manager', personId: null, version: 1, now: T0 })).toBe(false);
    expect((await store.recommendationsOf(id))[0]).toMatchObject({ status: 'expired', detail: { refused: 'the lesson was not accepted: it is not one line' }, applied_by: null });
    expect((await store.adoptRecommendations(id, [1], 'demo-p-owner', T0))).toEqual([]);
  });

  it('refuses a recommendation kind or applier the table does not know', async ({ skip }) => {
    if (!migrated) skip();
    const id = await reviewWith();
    await expect(pool.query(`insert into public.recommendations (review_id, rank, assistant_id, change, why, kind) values ($1, 1, 'owner', 'x', 'y', 'delete_profile')`, [id])).rejects.toThrow(/recommendations_kind_check/);
    await pool.query(`insert into public.recommendations (review_id, rank, assistant_id, change, why) values ($1, 1, 'owner', 'x', 'y')`, [id]);
    await expect(pool.query(`update public.recommendations set applied_by = 'anyone' where review_id = $1`, [id])).rejects.toThrow(/recommendations_applied_by_check/);
    await expect(pool.query(`update public.recommendations set detail = '[]'::jsonb where review_id = $1`, [id])).rejects.toThrow(/recommendations_detail_check/);
    expect((await pool.query('select kind, detail from public.recommendations where review_id = $1', [id])).rows).toEqual([{ kind: 'lesson', detail: {} }]); // a row from before kinds is a lesson
  });

  it('reads every stored profile row, and each one parses and passes the profile rules', async ({ skip }) => {
    if (!migrated) skip();
    for (const id of AssistantId.options) {
      const raw = await store.profileRow(id);
      const parsed = ProfileRow.safeParse(raw);
      expect(parsed.success, id).toBe(true);
      if (parsed.success) expect(parsed.data.reads.every((name) => READ_TOOL_NAMES.includes(name as never)), id).toBe(true);
    }
  });

  it('writes nothing when the profile is not at the version the writer saw, and finds no version made by a recommendation that made none', async ({ skip }) => {
    if (!migrated) skip();
    const versions = async () => (await pool.query('select count(*)::int as n from public.assistant_profile_versions')).rows[0].n as number;
    const before = await versions();
    const row = ProfileRow.parse(await store.profileRow('manager'));
    const wrote = await store.saveProfile({
      assistant: 'manager', expectedVersion: row.version + 1000, title: row.title, skill: row.skill, reads: row.reads, models: row.models, lessons: row.lessons,
      by: 'manager', reason: 'a stale write that must be refused', change: { kind: 'test' }, now: T0,
    });
    expect(wrote).toBeNull();
    expect(await versions()).toBe(before);
    expect(ProfileRow.parse(await store.profileRow('manager')).version).toBe(row.version);
    expect(await store.profileVersionFor(randomUUID())).toBeNull();
  });

  it('lists what outside tools filed newest first, by window, assistant and whether a review read it, and marks each report read once', async ({ skip }) => {
    if (!migrated) skip();
    const add = async (assistant: string, at: string, summary: string) =>
      (await pool.query(`insert into public.session_reports (token_id, assistant_id, tool, summary, suggestions, lessons, created_at) values ($1, $2, 'claude-code', $3, '[{"text":"s"}]', '[{"text":"l"}]', $4) returning id`, [tokenId, assistant, summary, at])).rows[0].id as string;
    const year = 3000 + Math.floor(Math.random() * 6000);
    const [a, b, c] = [await add('finance', `${year}-01-01T10:00:00Z`, 'first'), await add('online', `${year}-01-01T11:00:00Z`, 'second'), await add('finance', `${year}-01-01T12:00:00Z`, 'third')];
    const since = new Date(`${year}-01-01T00:00:00Z`);
    const all = await store.sessionReports({ since });
    expect(all.map((r) => r.id)).toEqual([c, b, a]); // newest first
    expect(all[0]).toEqual({ id: c, assistant_id: 'finance', tool: 'claude-code', summary: 'third', steps: [], suggestions: [{ text: 's' }], lessons: [{ text: 'l' }], created_at: expect.any(String), reviewed_at: null });
    expect(Object.keys(all[0]!)).not.toContain('token_id'); // nothing that identifies the door's token
    expect((await store.sessionReports({ since, assistant: 'finance' })).map((r) => r.id)).toEqual([c, a]);
    expect((await store.sessionReports({ since, before: new Date(`${year}-01-01T11:00:00Z`) })).map((r) => r.id)).toEqual([b, a]);
    expect((await store.sessionReports({ since, limit: 1 })).map((r) => r.id)).toEqual([c]);

    const reviewId = await reviewWith();
    expect(await store.markSessionReportsReviewed([a, b], reviewId, T0)).toBe(2);
    expect(await store.markSessionReportsReviewed([a, b, c], await reviewWith(), new Date(T0.getTime() + 1000))).toBe(1); // only c is new
    expect(await store.markSessionReportsReviewed([], reviewId, T0)).toBe(0);
    expect((await store.sessionReports({ since, unreviewedOnly: true })).map((r) => r.id)).toEqual([]);
    const rows = (await pool.query('select id, reviewed_at, review_id from public.session_reports where id = any($1)', [[a, b, c]])).rows;
    expect(rows.find((r) => r.id === a)).toMatchObject({ review_id: reviewId }); // the first review keeps its report
    expect(new Date(rows.find((r) => r.id === a).reviewed_at).toISOString()).toBe(T0.toISOString());
    expect(rows.find((r) => r.id === c).review_id).not.toBe(reviewId);
  });

  it('closes the unread reports filed before a time, without a review, and only those', async ({ skip }) => {
    if (!migrated) skip();
    // Years long before any real report, so closing "everything before 11:30" cannot touch anything another test or lane filed.
    const year = 1900 + Math.floor(Math.random() * 50);
    const add = async (at: string, reviewedAt: string | null) =>
      (await pool.query(`insert into public.session_reports (token_id, assistant_id, tool, summary, created_at, reviewed_at) values ($1, 'finance', 'claude-code', 'old', $2, $3) returning id`, [tokenId, at, reviewedAt])).rows[0].id as string;
    const [a, b, read, c] = [await add(`${year}-01-01T10:00:00Z`, null), await add(`${year}-01-01T11:00:00Z`, null), await add(`${year}-01-01T10:30:00Z`, `${year}-01-02T00:00:00Z`), await add(`${year}-01-01T12:00:00Z`, null)];
    const since = new Date(`${year}-01-01T00:00:00Z`);
    expect(await store.expireSessionReports(new Date(`${year}-01-01T11:30:00Z`), T0)).toBe(2);
    const rows = (await pool.query('select id, reviewed_at, review_id from public.session_reports where id = any($1)', [[a, b, read, c]])).rows;
    for (const id of [a, b]) {
      const row = rows.find((r) => r.id === id);
      expect(new Date(row.reviewed_at).toISOString()).toBe(T0.toISOString());
      expect(row.review_id).toBeNull(); // closed, and no review read it
    }
    expect(new Date(rows.find((r) => r.id === read).reviewed_at).toISOString()).toBe(`${year}-01-02T00:00:00.000Z`); // one already read keeps its time
    expect(rows.find((r) => r.id === c).reviewed_at).toBeNull(); // filed after the time: still waiting
    expect((await store.sessionReports({ since, unreviewedOnly: true })).map((r) => r.id)).toEqual([c]);
    expect(await store.expireSessionReports(new Date(`${year}-01-01T11:30:00Z`), T0)).toBe(0); // nothing left to close
  });

  it('says what became of the task with a key, or null when there is none', async ({ skip }) => {
    if (!migrated) skip();
    const key = KEY + randomUUID();
    expect(await store.taskStatusByKey(key)).toBeNull();
    await store.enqueueTask({ assistant: 'manager', kind: 'scheduled', key, payload: { job: 'manager_review' }, now: T0 });
    expect(await store.taskStatusByKey(key)).toBe('queued');
    await pool.query(`update public.tasks set status = 'cancelled' where idempotency_key = $1`, [key]);
    expect(await store.taskStatusByKey(key)).toBe('cancelled');
  });
});
