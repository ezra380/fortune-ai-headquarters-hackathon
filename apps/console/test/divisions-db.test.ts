import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDivisionsLoader } from '../src/loader.ts';
import { shapeDivisions } from '../src/shape.ts';
import { dbUrl, localApi } from '../../worker/test/localdb.ts';

// The Divisions loader against the real local database, through the real query builder: this is what proves the filters, the
// key patterns and the JSON-path columns are accepted (the recording fake in divisions.test.ts cannot). The rows are written
// with SQL, shaped like the ones the worker writes, and removed afterwards. They sit in the year 8000s (briefs) and the year
// 9000 (everything with a creation time), so they are the newest in every list and no other test's rows are read or changed.

// The wave-2 reads (reports-db.test.ts) are given a clock on this test's own day, so the report rows other tests leave in the shared database are not read here.
const api = localApi();
if (!api) console.warn('SKIPPED console divisions database test: needs local Supabase (npm run db:start)');

const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
afterAll(async () => pool.end());

const DAY = new Date(Date.UTC(8000, 0, 1) + randomInt(0, 365_000) * 86_400_000).toISOString().slice(0, 10);
const LATER = '9000-01-01T00:00:00Z';
const FACT_MARKER = `FACT-${randomBytes(4).toString('hex')}`;

const briefOf = (division: string) => ({
  headline: `${division} headline`,
  findings: [{ text: `${division} finding`, cites: [`m:${division}.metric`] }],
  actions: [1, 2, 3].map((rank) => ({ rank, title: `${division} action ${rank}`, why: 'because', steps: 'do it', cites: [] })),
  ceoLine: `${division} line`,
});

describe.skipIf(!api)('the Divisions loader on the real local database', () => {
  const messages: string[] = [];
  const briefKeys: string[] = [];
  const docs: Record<string, string> = {};
  const requests: Record<string, string> = {};

  async function message(m: { from: string; to: string; kind: string; body: unknown; dedupe: string; replyTo?: string; at?: string }): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `insert into public.assistant_messages (from_assistant, to_assistant, kind, body, reply_to, dedupe_key, created_at)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7) returning id`,
      [m.from, m.to, m.kind, JSON.stringify(m.body), m.replyTo ?? null, m.dedupe, m.at ?? LATER],
    );
    const id = r.rows[0]!.id;
    messages.push(id);
    return id;
  }
  const approval = (messageId: string, status: string, expires: string, decided: string | null, at: string) =>
    pool.query(
      `insert into public.approvals (message_id, approver_person_id, action, code_hash, status, expires_at, decided_at, created_at)
       values ($1, 'demo-p-finance-owner', 'approve_action', $2, $3, $4, $5, $6)`,
      [messageId, randomBytes(32).toString('hex'), status, expires, decided, at],
    );

  beforeAll(async () => {
    for (const division of ['salon', 'finance', 'online']) {
      const key = `brief:${division}:${DAY}`;
      briefKeys.push(key);
      await pool.query(
        `insert into public.division_briefs (division, brief_key, brief_date, period, status, written_by, brief, ceo_line)
         values ($1, $2, $3, 'demo-period', $4, 'model', $5::jsonb, $6)`,
        [division, key, DAY, division === 'finance' ? 'watch' : 'normal', JSON.stringify(briefOf(division)), `${division} line`],
      );
      docs[division] = await message({
        from: division, to: division, kind: 'report', dedupe: `briefdoc:${key}`,
        body: { type: 'division_brief', briefId: randomUUID(), briefKey: key, division, status: 'normal', date: DAY },
      });
    }
    // Finance: two codes (an old expired one, the newest used), and the head approved action 2 only.
    await approval(docs.finance!, 'expired', '9000-01-01T00:05:00Z', null, '9000-01-01T00:00:00Z');
    await approval(docs.finance!, 'signed', '9000-01-02T00:00:00Z', '9000-01-01T00:20:00Z', '9000-01-01T00:10:00Z');
    await message({
      from: 'finance', to: 'manager', kind: 'decision', replyTo: docs.finance!, dedupe: `action-decision:${docs.finance}:2`,
      body: { type: 'action_decision', briefId: randomUUID(), division: 'finance', rank: 2, title: 'finance action 2', verdict: 'approved', by: 'demo-p-finance-owner' },
    });
    // Online: a code that was locked by wrong tries. (Not a waiting one: every test that tries a wrong code adds a failed
    // attempt to every waiting code of that person, and the database is shared, so a waiting row would not stay waiting.)
    await approval(docs.online!, 'locked', '9000-01-02T00:00:00Z', null, '9000-01-01T00:10:00Z');

    // Finance asked the others two questions: online answered, the salon could not.
    for (const [to, ok] of [['online', true], ['salon', false]] as const) {
      const id = await message({
        from: 'finance', to, kind: 'request', dedupe: `datareq:brief:finance:${DAY}:${to}`,
        body: { type: 'data_request', briefKey: `brief:finance:${DAY}`, question: `What did ${to} do?` },
        at: to === 'online' ? '9000-01-01T00:01:00Z' : '9000-01-01T00:02:00Z',
      });
      requests[to] = id;
      await message({
        from: to, to: 'finance', kind: 'report', replyTo: id, dedupe: `datareply:${id}`, at: `9000-01-01T00:0${to === 'online' ? 3 : 4}:00Z`,
        body: { type: 'data_reply', briefKey: `brief:finance:${DAY}`, question: `What did ${to} do?`, ...(ok ? { ok: true, facts: { marker: FACT_MARKER } } : { ok: false, reason: "Code Mode isn't connected on this machine" }) },
      });
    }

    await message({
      from: 'owner', to: 'owner', kind: 'report', dedupe: `digestdoc:digest:${DAY}`, at: '9000-01-02T00:00:00Z',
      body: {
        type: 'ceo_digest', date: DAY, text: `Company status for ${DAY}:\nSalon: running normally.`,
        reports: [{ division: 'salon', state: 'in', status: 'normal', ceoLine: 'Salon is running normally.' }, { division: 'finance', state: 'missing' }],
      },
    });
  });

  afterAll(async () => {
    if (!api) return;
    await pool.query('delete from public.approvals where message_id = any($1::uuid[])', [messages]);
    await pool.query('delete from public.assistant_messages where id = any($1::uuid[]) and reply_to is not null', [messages]);
    await pool.query('delete from public.assistant_messages where id = any($1::uuid[])', [messages]);
    await pool.query('delete from public.division_briefs where brief_key = any($1::text[])', [briefKeys]);
  });

  const db = () => createClient(api!.url, api!.key, { auth: { persistSession: false, autoRefreshToken: false } });

  it('reads every part without a note, and the newest brief of each division is the one just written', async () => {
    const loaded = await createDivisionsLoader({ db: db(), now: () => new Date(`${DAY}T12:00:00Z`) })();
    expect(loaded.notes).toEqual([]);
    expect(loaded.unread).toEqual([]);
    expect(loaded.divisions.map((d) => [d.division, d.brief?.brief_key, d.unread])).toEqual(briefKeys.map((key) => [key.split(':')[1], key, []]));
  });

  it('shows where each action stands: the used code, the action the head approved, a locked code, and no code', async () => {
    const view = shapeDivisions(await createDivisionsLoader({ db: db(), now: () => new Date(`${DAY}T12:00:00Z`) })(), new Date());
    const by = Object.fromEntries(view.divisions.map((d) => [d.id, d]));
    expect(by.finance!.brief).toMatchObject({ date: DAY, status: 'watch', writtenBy: 'model', headline: 'finance headline', ceoLine: 'finance line' });
    // The newest code was used (the older, expired one does not count), and the head approved action 2 only.
    expect(by.finance!.brief!.actions.map((a) => a.approval.state)).toEqual(['not_approved', 'approved', 'not_approved']);
    expect(by.finance!.brief!.actions[1]!.approval.at).not.toBeNull();
    expect(by.online!.brief!.actions.map((a) => a.approval.state)).toEqual(['code_locked', 'code_locked', 'code_locked']);
    expect(by.salon!.brief!.actions.map((a) => a.approval.state)).toEqual(['no_code', 'no_code', 'no_code']);
    expect(by.salon!.brief!.findings).toEqual([{ text: 'salon finding', cites: ['m:salon.metric'] }]);
  });

  it('pairs each question with its answer, and reads an answer as its outcome and reason only', async () => {
    const loaded = await createDivisionsLoader({ db: db(), now: () => new Date(`${DAY}T12:00:00Z`) })();
    const view = shapeDivisions(loaded, new Date());
    const finance = view.divisions.find((d) => d.id === 'finance')!;
    const mine = finance.asked.filter((q) => ['What did online do?', 'What did salon do?'].includes(q.question));
    expect(mine.map((q) => [q.to, q.state, q.reason])).toEqual([
      ['salon', 'unavailable', "Code Mode isn't connected on this machine"],
      ['online', 'answered', null],
    ]);
    expect(mine.every((q) => q.askedAt !== null && q.answeredAt !== null)).toBe(true);
    expect(view.divisions.find((d) => d.id === 'online')!.received.map((q) => q.question)).toContain('What did online do?');
    // What the answer carried never reaches the console.
    expect(JSON.stringify(loaded)).not.toContain(FACT_MARKER);
    expect(JSON.stringify(view)).not.toContain(FACT_MARKER);
  });

  it('reads the newest CEO digest', async () => {
    const view = shapeDivisions(await createDivisionsLoader({ db: db(), now: () => new Date(`${DAY}T12:00:00Z`) })(), new Date());
    expect(view.digest).toMatchObject({ date: DAY, text: `Company status for ${DAY}:\nSalon: running normally.` });
    expect(view.digest!.reports).toEqual([
      { division: 'salon', state: 'in', status: 'normal' },
      { division: 'finance', state: 'missing', status: null },
    ]);
  });

  it('reads nothing another table holds: the view holds no phone number, code hash or person id', async () => {
    const text = JSON.stringify(shapeDivisions(await createDivisionsLoader({ db: db(), now: () => new Date(`${DAY}T12:00:00Z`) })(), new Date()));
    expect(text).not.toMatch(/demo-p-|code_hash|\+1\d{10}/);
  });
});
