import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Real-Postgres tests for the queue, approvals and caps (local Supabase: npm run db:start).
// Each test uses fresh ids so tests never depend on each other or on wall-clock time.

const url = process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
let reachable = false;
const pool = new pg.Pool({ connectionString: url, max: 6 });

beforeAll(async () => {
  try {
    await pool.query('select 1');
    reachable = true;
  } catch {
    console.warn(`SKIPPED database tests: no Postgres at ${url.replace(/:[^:@/]+@/, ':***@')} (run npm run db:start)`);
  }
});
afterAll(async () => pool.end());

const sid = () => 'SM' + randomBytes(16).toString('hex');
const T0 = '2026-10-26T12:00:00Z';
const OWNER = '+15550111001';
const FINANCE = '+15550111002';

async function enqueue(messageSid: string, from: string, body = 'Three plans please') {
  const { rows } = await pool.query(
    'select * from public.enqueue_inbound_text($1, $2, $3, $4, $5)',
    [messageSid, from, '+15550100001', body, T0],
  );
  return rows[0] as { task_id: string | null; outcome: string; duplicate: boolean };
}

describe('inbound texts', () => {
  it('queues one task per message, even when Twilio retries', async ({ skip }) => {
    if (!reachable) skip();
    const id = sid();
    const first = await enqueue(id, OWNER);
    const second = await enqueue(id, OWNER);
    expect(first).toMatchObject({ outcome: 'queued', duplicate: false });
    expect(second).toMatchObject({ task_id: first.task_id, duplicate: true });
    const { rows } = await pool.query('select count(*)::int as n from public.tasks where idempotency_key = $1', ['sms:' + id]);
    expect(rows[0].n).toBe(1);
  });

  it('refuses an unknown sender without keeping their words', async ({ skip }) => {
    if (!reachable) skip();
    const id = sid();
    const result = await enqueue(id, '+15559999999', 'private words');
    expect(result).toMatchObject({ task_id: null, outcome: 'refused_unknown_sender' });
    const { rows } = await pool.query('select body from public.inbound_texts where message_sid = $1', [id]);
    expect(rows[0].body).toBeNull();
  });
});

describe('task claims', () => {
  it('gives a task to exactly one of two workers claiming at the same moment', async ({ skip }) => {
    if (!reachable) skip();
    await enqueue(sid(), OWNER);
    // Claim everything that is queued so only our task remains, then race two workers.
    const now = '2026-10-26T12:00:01Z';
    while ((await pool.query('select * from public.claim_task($1, 300, $2)', ['drain', now])).rowCount) { /* drain */ }
    const fresh = await enqueue(sid(), OWNER);
    const [a, b] = await Promise.all([
      pool.query('select * from public.claim_task($1, 300, $2)', ['worker-a', now]),
      pool.query('select * from public.claim_task($1, 300, $2)', ['worker-b', now]),
    ]);
    const winners = [...a.rows, ...b.rows].filter((r: { id: string }) => r.id === fresh.task_id);
    expect(winners).toHaveLength(1);
  });

  it('retries after a lease expires, then fails after the last attempt', async ({ skip }) => {
    if (!reachable) skip();
    const { rows } = await pool.query(
      `insert into public.tasks (assistant_id, kind, idempotency_key, payload, max_attempts, created_at, run_after)
       values ('owner', 'scheduled', $1, '{}'::jsonb, 2, '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z') returning id`,
      ['test:' + randomUUID()],
    );
    const id = rows[0].id as string;
    const claimAt = async (t: string) =>
      (await pool.query('select * from public.claim_task($1, 60, $2)', ['w', t])).rows.find((r: { id: string }) => r.id === id);
    expect((await claimAt('2000-01-01T00:00:00Z'))?.attempts).toBe(1);
    expect(await claimAt('2000-01-01T00:00:30Z')).toBeUndefined(); // lease still held
    expect((await claimAt('2000-01-01T00:01:01Z'))?.attempts).toBe(2); // lease expired: retried
    await claimAt('2000-01-01T00:02:02Z');
    const final = await pool.query('select status, last_error from public.tasks where id = $1', [id]);
    expect(final.rows[0].status).toBe('failed');
  });

  it('lets only the lease holder finish a task', async ({ skip }) => {
    if (!reachable) skip();
    const { rows } = await pool.query(
      `insert into public.tasks (assistant_id, kind, idempotency_key, payload, created_at, run_after)
       values ('owner', 'scheduled', $1, '{}'::jsonb, '2001-01-01T00:00:00Z', '2001-01-01T00:00:00Z') returning id`,
      ['test:' + randomUUID()],
    );
    const id = rows[0].id as string;
    await pool.query('select * from public.claim_task($1, 300, $2)', ['owner-worker', '2001-01-01T00:00:00Z']);
    const intruder = await pool.query('select public.finish_task($1, $2, $3) as ok', [id, 'someone-else', 'done']);
    const holder = await pool.query('select public.finish_task($1, $2, $3) as ok', [id, 'owner-worker', 'done']);
    expect(intruder.rows[0].ok).toBe(false);
    expect(holder.rows[0].ok).toBe(true);
  });
});

describe('approval codes', () => {
  async function proposalWithApproval(code: string, ttl = 15) {
    const msg = await pool.query(
      `insert into public.assistant_messages (from_assistant, to_assistant, kind, body, dedupe_key)
       values ('finance', 'owner', 'proposal', '{}'::jsonb, $1) returning id`,
      ['test:' + randomUUID()],
    );
    const messageId = msg.rows[0].id as string;
    const approval = await pool.query('select public.create_approval($1, $2, $3, $4, $5, $6) as id', [
      messageId, 'demo-p-owner', 'forward_plan', code, ttl, T0,
    ]);
    return { messageId, approvalId: approval.rows[0].id as string };
  }
  const use = (phone: string, code: string, at = '2026-10-26T12:05:00Z') =>
    pool.query('select * from public.use_approval_code($1, $2, $3, $4, $5)', [phone, code, 'signed', '{}', at]).then((r) => r.rows[0]);

  it('signs once with the right person and code, and never again', async ({ skip }) => {
    if (!reachable) skip();
    const code = String(100000 + Math.floor(Math.random() * 899999));
    const { approvalId } = await proposalWithApproval(code);
    expect((await use(FINANCE, code)).outcome).toBe('refused'); // someone else's phone
    expect((await use(OWNER, code)).approval_id).toBe(approvalId);
    expect((await use(OWNER, code)).outcome).toBe('refused'); // single use
    const { rows } = await pool.query('select code_hash from public.approvals where id = $1', [approvalId]);
    expect(rows[0].code_hash).not.toContain(code); // only a hash is stored
  });

  it('refuses an expired code and a plain "yes"', async ({ skip }) => {
    if (!reachable) skip();
    const code = String(100000 + Math.floor(Math.random() * 899999));
    await proposalWithApproval(code, 15);
    expect((await use(OWNER, 'yes')).outcome).toBe('refused');
    expect((await use(OWNER, code, '2026-10-26T12:16:00Z')).outcome).toBe('refused');
  });

  it('locks pending approvals after five wrong codes', async ({ skip }) => {
    if (!reachable) skip();
    await pool.query(`update public.approvals set status = 'expired' where approver_person_id = 'demo-p-owner' and status = 'pending'`);
    const { approvalId } = await proposalWithApproval('424242');
    for (let i = 0; i < 5; i++) await use(OWNER, '000000');
    expect((await use(OWNER, '424242')).outcome).toBe('refused');
    const { rows } = await pool.query('select status from public.approvals where id = $1', [approvalId]);
    expect(rows[0].status).toBe('locked');
  });
});

describe('spending cap', () => {
  it('never lets concurrent reservations pass the daily cap', async ({ skip }) => {
    if (!reachable) skip();
    const day = `20${String(30 + Math.floor(Math.random() * 60))}-01-01`;
    const results = await Promise.all(
      Array.from({ length: 6 }, () => pool.query('select public.reserve_model_spend($1, 0.4, 1.0) as ok', [day])),
    );
    expect(results.filter((r) => r.rows[0].ok).length).toBe(2);
    const { rows } = await pool.query('select usd::float as usd from public.model_spend where day = $1', [day]);
    expect(rows[0].usd).toBeCloseTo(0.8);
  });
});

describe('row-level security', () => {
  it('shows the public (anon) role nothing and lets it call nothing', async ({ skip }) => {
    if (!reachable) skip();
    await enqueue(sid(), OWNER);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role anon');
      const visible = await client.query('select count(*)::int as n from public.tasks');
      expect(visible.rows[0].n).toBe(0);
      await expect(client.query(`select * from public.claim_task('anon', 60)`)).rejects.toThrow(/permission denied/);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});
