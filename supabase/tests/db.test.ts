import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

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

describe('task lease renewal', () => {
  // claim_task hands out the oldest runnable task, so each test cancels its own when it is done: a task left
  // running with an old lease would be claimed in place of the next test's.
  const ids: string[] = [];
  afterEach(async () => {
    for (const id of ids.splice(0)) await pool.query('select public.cancel_task($1)', [id]);
  });
  const newTask = async (createdAt: string) => {
    const { rows } = await pool.query(
      `insert into public.tasks (assistant_id, kind, idempotency_key, payload, created_at, run_after)
       values ('owner', 'scheduled', $1, '{}'::jsonb, $2, $2) returning id`,
      ['test:' + randomUUID(), createdAt],
    );
    ids.push(rows[0].id as string);
    return rows[0].id as string;
  };
  const claimAt = async (id: string, worker: string, t: string, lease = 60) =>
    (await pool.query('select * from public.claim_task($1, $2, $3)', [worker, lease, t])).rows.find((r: { id: string }) => r.id === id);
  const extend = async (id: string, worker: string, t: string, lease = 60) =>
    (await pool.query('select public.extend_lease($1, $2, $3, $4) as ok', [id, worker, lease, t])).rows[0].ok as boolean;
  const leaseUntil = async (id: string) => new Date((await pool.query('select lease_until from public.tasks where id = $1', [id])).rows[0].lease_until).toISOString();

  it('lets the holder push its lease on, so a task still being worked on is not claimed', async ({ skip }) => {
    if (!reachable) skip();
    const id = await newTask('2002-01-01T00:00:00Z');
    expect((await claimAt(id, 'w1', '2002-01-01T00:00:00Z'))?.attempts).toBe(1);
    expect(await extend(id, 'w1', '2002-01-01T00:00:50Z')).toBe(true);
    expect(await leaseUntil(id)).toBe('2002-01-01T00:01:50.000Z'); // 50 s + a fresh 60 s
    expect(await claimAt(id, 'w2', '2002-01-01T00:01:20Z')).toBeUndefined(); // the first lease would have ended at 00:01:00
    expect((await claimAt(id, 'w2', '2002-01-01T00:01:51Z'))?.attempts).toBe(2); // and it does end when renewals stop
  });

  it('never shortens a lease', async ({ skip }) => {
    if (!reachable) skip();
    const id = await newTask('2002-02-01T00:00:00Z');
    await claimAt(id, 'w1', '2002-02-01T00:00:00Z', 600);
    expect(await extend(id, 'w1', '2002-02-01T00:00:10Z', 60)).toBe(true);
    expect(await leaseUntil(id)).toBe('2002-02-01T00:10:00.000Z');
  });

  it('refuses anyone but the holder, and a holder that lost the task to a retry', async ({ skip }) => {
    if (!reachable) skip();
    const id = await newTask('2002-03-01T00:00:00Z');
    await claimAt(id, 'w1', '2002-03-01T00:00:00Z');
    expect(await extend(id, 'someone-else', '2002-03-01T00:00:10Z')).toBe(false);
    expect((await claimAt(id, 'w2', '2002-03-01T00:01:30Z'))?.attempts).toBe(2); // w1's lease ran out, w2 took it
    expect(await extend(id, 'w1', '2002-03-01T00:01:40Z')).toBe(false);
    expect(await extend(id, 'w2', '2002-03-01T00:01:40Z')).toBe(true);
    expect((await pool.query('select public.finish_task($1, $2, $3) as ok', [id, 'w2', 'done'])).rows[0].ok).toBe(true);
    expect(await extend(id, 'w2', '2002-03-01T00:01:50Z')).toBe(false); // a finished task has no lease to renew
  });

  it('lets the public (anon) role call nothing here either', async ({ skip }) => {
    if (!reachable) skip();
    const id = await newTask('2002-04-01T00:00:00Z');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role anon');
      await expect(client.query('select public.extend_lease($1, $2, 60)', [id, 'anon'])).rejects.toThrow(/permission denied/);
    } finally {
      await client.query('rollback');
      client.release();
    }
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
    const smsKey = 'test-sms:' + randomUUID();
    const approval = await issue(messageId, code, smsKey, ttl);
    return { messageId, smsKey, approvalId: approval.approval_id as string };
  }
  const issue = (messageId: string, code: string, smsKey: string, ttl = 15) =>
    pool.query('select * from public.issue_approval($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
      messageId, 'demo-p-owner', 'forward_plan', code, 'finance', `Reply SEND <1-3> ${code}`, smsKey, ttl, T0,
    ]).then((r) => r.rows[0] as { approval_id: string | null; created: boolean });
  const use = (phone: string, code: string, at = '2026-10-26T12:05:00Z', action = 'forward_plan', taskId: string | null = null) =>
    pool.query('select * from public.use_approval_code($1, $2, $3, $4, $5, $6, $7)', [phone, code, 'signed', action, taskId, '{}', at]).then((r) => r.rows[0]);
  const newTask = async () => (await enqueue(sid(), OWNER)).task_id as string;

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

  it('refuses a code under the wrong command word without spending it', async ({ skip }) => {
    if (!reachable) skip();
    const code = String(100000 + Math.floor(Math.random() * 899999));
    const { approvalId } = await proposalWithApproval(code);
    expect((await use(OWNER, code, undefined, 'decide_plan')).outcome).toBe('wrong_action');
    expect((await use(OWNER, code)).approval_id).toBe(approvalId); // still usable for SEND
  });

  it('lets a retried task resume with the code it already spent, and nobody else', async ({ skip }) => {
    if (!reachable) skip();
    const code = String(100000 + Math.floor(Math.random() * 899999));
    const { approvalId, messageId } = await proposalWithApproval(code);
    const task = await newTask();
    const first = await use(OWNER, code, undefined, 'forward_plan', task);
    expect(first).toMatchObject({ approval_id: approvalId, outcome: 'signed', replay: false });
    const retry = await use(OWNER, code, '2026-10-26T12:30:00Z', 'forward_plan', task); // after expiry, too
    expect(retry).toMatchObject({ approval_id: approvalId, message_id: messageId, outcome: 'signed', replay: true });
    expect((await use(OWNER, code, undefined, 'forward_plan', await newTask())).outcome).toBe('refused'); // another task
  });

  it('issues a code once per text: a re-run keeps the code already sent', async ({ skip }) => {
    if (!reachable) skip();
    const code = String(100000 + Math.floor(Math.random() * 899999));
    const { messageId, smsKey, approvalId } = await proposalWithApproval(code);
    const rerun = await issue(messageId, '111111', smsKey);
    expect(rerun.created).toBe(false);
    expect((await use(OWNER, '111111')).outcome).toBe('refused'); // the re-run minted nothing
    expect((await use(OWNER, code)).approval_id).toBe(approvalId); // the code on the phone still works
    const { rows } = await pool.query('select count(*)::int as n from public.outbox where dedupe_key = $1', [smsKey]);
    expect(rows[0].n).toBe(1);
    await expect(issue(messageId, '222222', 'test-sms:' + randomUUID()).then(() => null, (e: Error) => e.message)).resolves.toBeNull();
    await expect(pool.query('select * from public.issue_approval($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
      messageId, 'demo-p-owner', 'forward_plan', '333333', 'finance', 'no code here', 'test-sms:' + randomUUID(), 15, T0,
    ])).rejects.toThrow(/must carry the code/);
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

describe('one phone for two people (demo)', () => {
  it('routes a text to the person whose assistant was texted, and a code to the person it was issued to', async ({ skip }) => {
    if (!reachable) skip();
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`update public.people set phone = $1 where id = 'demo-p-finance-owner'`, [OWNER]);
      const enqueueTo = async (to: string) => {
        const { rows } = await client.query('select * from public.enqueue_inbound_text($1, $2, $3, $4, $5)', [sid(), OWNER, to, 'Plans please', T0]);
        const task = await client.query('select assistant_id, payload->>$2 as person from public.tasks where id = $1', [rows[0].task_id, 'personId']);
        return task.rows[0] as { assistant_id: string; person: string };
      };
      expect(await enqueueTo('+15550100001')).toEqual({ assistant_id: 'owner', person: 'demo-p-owner' });
      expect(await enqueueTo('+15550100002')).toEqual({ assistant_id: 'finance', person: 'demo-p-finance-owner' });
      expect((await enqueueTo('+15550100004')).person).toBe('demo-p-owner'); // another number: the owner

      await client.query(`update public.approvals set status = 'expired' where status = 'pending'`);
      const message = async () => (await client.query(
        `insert into public.assistant_messages (from_assistant, to_assistant, kind, body, dedupe_key) values ('finance', 'owner', 'proposal', '{}'::jsonb, $1) returning id`,
        ['test:' + randomUUID()],
      )).rows[0].id as string;
      const issue = (messageId: string, person: string, action: string, code: string) => client.query(
        'select * from public.issue_approval($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [messageId, person, action, code, 'finance', `code ${code}`, 'test-sms:' + randomUUID(), 15, T0],
      );
      await issue(await message(), 'demo-p-owner', 'forward_plan', '135791');
      await issue(await message(), 'demo-p-finance-owner', 'decide_plan', '246802');
      const use = async (code: string, action: string) => (await client.query(
        'select * from public.use_approval_code($1, $2, $3, $4, $5, $6, $7)', [OWNER, code, 'signed', action, null, '{}', '2026-10-26T12:05:00Z'],
      )).rows[0];
      expect(await use('135791', 'forward_plan')).toMatchObject({ outcome: 'signed', approver_person_id: 'demo-p-owner' });
      expect(await use('246802', 'decide_plan')).toMatchObject({ outcome: 'signed', approver_person_id: 'demo-p-finance-owner' });
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});

describe('spending cap', () => {
  it('never lets concurrent reservations pass the daily cap', async ({ skip }) => {
    if (!reachable) skip();
    const day = `20${String(30 + Math.floor(Math.random() * 60))}-01-01`;
    // The test leaves its row behind, so an earlier run may already have spent this random day (about one run in ten, and growing).
    await pool.query('delete from public.model_spend where day = $1', [day]);
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

describe('the HQ Manager tables', () => {
  const newTask = async () => (await enqueue(sid(), OWNER)).task_id as string;
  const insertReport = (taskId: string, summary: string, outcome = 'done') =>
    pool.query(
      `insert into public.work_reports (task_id, run_id, assistant_id, task_kind, outcome, summary, steps, usage, suggestions, input_tokens, output_tokens, model_calls, started_at, ended_at)
       values ($1, $2, 'finance', 'mailbox', $3, $4, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, 10, 20, 1, $5, $6)
       on conflict (task_id) do update set outcome = excluded.outcome, summary = excluded.summary, updated_at = now()
       returning id`,
      [taskId, randomUUID(), outcome, summary, T0, '2026-10-26T12:00:05Z'],
    );
  async function reviewWithRecommendations() {
    const review = await pool.query(
      `insert into public.manager_reviews (review_key, covers_from, covers_to, report_count, review, digest)
       values ($1, $2, $3, 2, '{}'::jsonb, '{}'::jsonb) returning id`,
      ['test-review:' + randomUUID(), '2026-10-25T12:00:00Z', T0],
    );
    const reviewId = review.rows[0].id as string;
    for (const [rank, assistant] of [[1, 'finance'], [2, 'owner'], [3, 'online']] as const) {
      await pool.query(
        'insert into public.recommendations (review_id, rank, assistant_id, change, why) values ($1, $2, $3, $4, $5)',
        [reviewId, rank, assistant, `Change ${rank}`, `Because ${rank}`],
      );
    }
    return reviewId;
  }
  const adopt = (reviewId: string, ranks: number[]) =>
    pool.query('select * from public.adopt_recommendations($1, $2, $3, $4)', [reviewId, ranks, 'demo-p-owner', T0]).then((r) => r.rows as
      { recommendation_id: string; rank: number; assistant_id: string; change: string; newly_adopted: boolean }[]);

  it('seeds the manager as an assistant with no phone number and no person', async ({ skip }) => {
    if (!reachable) skip();
    const assistant = await pool.query(`select display_name, sms_from from public.assistants where id = 'manager'`);
    expect(assistant.rows[0]).toEqual({ display_name: 'HQ Manager', sms_from: null });
    const people = await pool.query(`select count(*)::int as n from public.people where assistant_id = 'manager'`);
    expect(people.rows[0].n).toBe(0);
  });

  // A division brief for a day in the year 9500 or 9501 (no other test uses them), one row a test; removed after each test, by its key only.
  const briefRow = `insert into public.division_briefs (division, brief_key, brief_date, period, status, written_by, brief, ceo_line)
    values ('salon', $1::text, to_date(substring($1::text from '[0-9]{4}-[0-9]{2}-[0-9]{2}'), 'YYYY-MM-DD'), 'p', 'normal', 'model', '{}'::jsonb, 'x') on conflict (brief_key) do nothing`;
  const briefKeyOf = (n: number) => `brief:salon:${9500 + n}-01-01`;
  afterEach(async () => {
    await pool.query('delete from public.division_briefs where brief_key = any($1)', [[briefKeyOf(0), briefKeyOf(1)]]);
  });

  it('shows the public (anon) role nothing in the new tables', async ({ skip }) => {
    if (!reachable) skip();
    await insertReport(await newTask(), 'A finished task');
    const reviewId = await reviewWithRecommendations();
    await pool.query(briefRow, [briefKeyOf(0)]); // a brief the public role must not see
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role anon');
      for (const table of ['work_reports', 'manager_reviews', 'recommendations', 'division_briefs']) {
        const visible = await client.query(`select count(*)::int as n from public.${table}`);
        expect(visible.rows[0].n, table).toBe(0);
      }
      await expect(client.query(`select * from public.adopt_recommendations($1, '{1}', 'demo-p-owner')`, [reviewId])).rejects.toThrow(/permission denied/);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  it('shows the public (anon) role no division brief and no way to look at a code: no rows or no access at all, never a brief', async ({ skip }) => {
    if (!reachable) skip();
    await pool.query(briefRow, [briefKeyOf(1)]);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role anon');
      // On a database with Supabase's default grants the public role gets zero rows; on one without grants it is refused. Either way it sees nothing.
      const seen = await client.query('select count(*)::int as n from public.division_briefs').then((r) => r.rows[0].n as number, (e: Error) => e.message);
      expect(seen === 0 || /permission denied/.test(String(seen)), String(seen)).toBe(true);
      await client.query('rollback');
      await client.query('begin');
      await client.query('set local role anon');
      await expect(client.query(`select * from public.peek_approval_code('+15550111001', '123456', 'approve_action')`)).rejects.toThrow(/permission denied/);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  describe('peek_approval_code', () => {
    async function briefCode(code: string, ttlMinutes = 720) {
      const msg = await pool.query(
        `insert into public.assistant_messages (from_assistant, to_assistant, kind, body, dedupe_key) values ('finance', 'finance', 'report', '{}'::jsonb, $1) returning id`,
        ['test:' + randomUUID()],
      );
      await pool.query(
        'select * from public.issue_approval($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [msg.rows[0].id, 'demo-p-owner', 'approve_action', code, 'owner', `Reply APPROVE 1 ${code}`, 'test-sms:' + randomUUID(), ttlMinutes, T0],
      );
      return msg.rows[0].id as string;
    }
    const peek = (code: string, over: { phone?: string; action?: string; at?: string } = {}) =>
      pool.query('select * from public.peek_approval_code($1, $2, $3, $4)', [over.phone ?? OWNER, code, over.action ?? 'approve_action', over.at ?? '2026-10-26T12:05:00Z']).then((r) => r.rows);
    const use = (code: string, action = 'approve_action') =>
      pool.query('select * from public.use_approval_code($1, $2, $3, $4, $5, $6, $7)', [OWNER, code, 'signed', action, null, '{}', '2026-10-26T12:06:00Z']).then((r) => r.rows[0]);
    const freshCode = () => String(100000 + Math.floor(Math.random() * 899999));

    it('finds a pending code for its person and action without changing anything', async ({ skip }) => {
      if (!reachable) skip();
      const code = freshCode();
      const messageId = await briefCode(code);
      expect(await peek(code)).toEqual([{ message_id: messageId, approver_person_id: 'demo-p-owner' }]);
      expect(await peek(code)).toHaveLength(1); // looking again changes nothing
      expect(await use(code)).toMatchObject({ outcome: 'signed', message_id: messageId }); // and the code is still there to spend
      expect(await peek(code)).toEqual([]); // spent
    });

    it('finds nothing for a wrong code, another person, another kind of code, a bad code or an expired one, and counts nothing', async ({ skip }) => {
      if (!reachable) skip();
      const code = freshCode();
      const messageId = await briefCode(code, 10);
      const other = code === '100000' ? '100001' : String(Number(code) - 1);
      expect(await peek(other)).toEqual([]);
      expect(await peek(code, { phone: FINANCE })).toEqual([]);
      expect(await peek(code, { action: 'adopt_change' })).toEqual([]);
      expect(await peek('12345a')).toEqual([]);
      expect(await peek(code, { at: '2026-10-26T12:11:00Z' })).toEqual([]); // 10 minutes after it was issued
      const { rows } = await pool.query('select status, failed_attempts from public.approvals where message_id = $1', [messageId]);
      expect(rows).toEqual([{ status: 'pending', failed_attempts: 0 }]);
      await use(code); // leave nothing pending
    });
  });

  it('keeps one work report per task: the latest attempt wins', async ({ skip }) => {
    if (!reachable) skip();
    const task = await newTask();
    const first = await insertReport(task, 'first attempt', 'retrying');
    const second = await insertReport(task, 'second attempt', 'done');
    expect(second.rows[0].id).toBe(first.rows[0].id);
    const { rows } = await pool.query('select outcome, summary from public.work_reports where task_id = $1', [task]);
    expect(rows).toEqual([{ outcome: 'done', summary: 'second attempt' }]);
    // A plain second insert is refused by the unique key, not by a check in code.
    await expect(pool.query(
      `insert into public.work_reports (task_id, run_id, assistant_id, task_kind, outcome, summary, steps, usage, suggestions, started_at, ended_at)
       values ($1, $2, 'finance', 'mailbox', 'done', 'x', '[]', '{}', '[]', $3, $3)`, [task, randomUUID(), T0],
    )).rejects.toThrow(/duplicate key/);
  });

  describe('an adopt_change code', () => {
    async function adoptCode(code: string) {
      const msg = await pool.query(
        `insert into public.assistant_messages (from_assistant, to_assistant, kind, body, dedupe_key)
         values ('manager', 'owner', 'report', '{}'::jsonb, $1) returning id`,
        ['test:' + randomUUID()],
      );
      const issued = await pool.query(
        'select * from public.issue_approval($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [msg.rows[0].id, 'demo-p-owner', 'adopt_change', code, 'owner', `Reply ADOPT 1 ${code}`, 'test-sms:' + randomUUID(), 720, T0],
      );
      return { messageId: msg.rows[0].id as string, approvalId: issued.rows[0].approval_id as string };
    }
    const use = (code: string, action: string, at = '2026-10-26T12:05:00Z') =>
      pool.query('select * from public.use_approval_code($1, $2, $3, $4, $5, $6, $7)', [OWNER, code, 'signed', action, null, '{}', at]).then((r) => r.rows[0]);
    const freshCode = () => String(100000 + Math.floor(Math.random() * 899999));

    it('works only for ADOPT, and a SEND or CONFIRM code is refused for ADOPT', async ({ skip }) => {
      if (!reachable) skip();
      const code = freshCode();
      const { approvalId, messageId } = await adoptCode(code);
      expect((await use(code, 'forward_plan')).outcome).toBe('wrong_action');
      expect((await use(code, 'decide_plan')).outcome).toBe('wrong_action');
      expect(await use(code, 'adopt_change')).toMatchObject({ approval_id: approvalId, message_id: messageId, outcome: 'signed', action: 'adopt_change' });
      expect((await use(code, 'adopt_change')).outcome).toBe('refused'); // single use

      const other = freshCode();
      const msg = await pool.query(
        `insert into public.assistant_messages (from_assistant, to_assistant, kind, body, dedupe_key) values ('finance', 'owner', 'proposal', '{}'::jsonb, $1) returning id`,
        ['test:' + randomUUID()],
      );
      await pool.query('select * from public.issue_approval($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [msg.rows[0].id, 'demo-p-owner', 'forward_plan', other, 'finance', `Reply SEND <1-3> ${other}`, 'test-sms:' + randomUUID(), 15, T0]);
      expect((await use(other, 'adopt_change')).outcome).toBe('wrong_action'); // the reverse
      expect((await use(other, 'forward_plan')).outcome).toBe('signed'); // and the code was not spent
    });

    it('lives for 12 hours when issued with that lifetime', async ({ skip }) => {
      if (!reachable) skip();
      const late = freshCode();
      await adoptCode(late);
      expect((await use(late, 'adopt_change', '2026-10-27T00:30:00Z')).outcome).toBe('refused'); // past 12 hours
      const inTime = freshCode();
      await adoptCode(inTime);
      expect((await use(inTime, 'adopt_change', '2026-10-26T23:30:00Z')).outcome).toBe('signed');
    });

    it('is not accepted by the database for an unknown action', async ({ skip }) => {
      if (!reachable) skip();
      await expect(pool.query('select * from public.use_approval_code($1, $2, $3, $4, $5, $6, $7)', [OWNER, '123456', 'signed', 'transfer_money', null, '{}', T0])).rejects.toThrow(/bad action/);
    });
  });

  describe('adopt_recommendations', () => {
    it('adopts the listed ranks once, returns the same rows on a retry, and never adopts an expired row', async ({ skip }) => {
      if (!reachable) skip();
      const reviewId = await reviewWithRecommendations();
      await pool.query(`update public.recommendations set status = 'expired' where review_id = $1 and rank = 3`, [reviewId]);

      const first = await adopt(reviewId, [1, 3]);
      expect(first).toMatchObject([{ rank: 1, assistant_id: 'finance', change: 'Change 1', newly_adopted: true }]);

      const retry = await adopt(reviewId, [1, 3]);
      expect(retry).toMatchObject([{ rank: 1, recommendation_id: first[0]!.recommendation_id, newly_adopted: false }]);

      const both = await adopt(reviewId, [1, 2]);
      expect(both.map((r) => [r.rank, r.newly_adopted])).toEqual([[1, false], [2, true]]);

      const rows = await pool.query('select rank, status, decided_by from public.recommendations where review_id = $1 order by rank', [reviewId]);
      expect(rows.rows).toEqual([
        { rank: 1, status: 'adopted', decided_by: 'demo-p-owner' },
        { rank: 2, status: 'adopted', decided_by: 'demo-p-owner' },
        { rank: 3, status: 'expired', decided_by: null },
      ]);
      expect(await adopt(reviewId, [])).toEqual([]);
    });

    it('adopts a rank once even when two callers race', async ({ skip }) => {
      if (!reachable) skip();
      const reviewId = await reviewWithRecommendations();
      const [a, b] = await Promise.all([adopt(reviewId, [2]), adopt(reviewId, [2])]);
      expect([...a, ...b].filter((r) => r.newly_adopted)).toHaveLength(1);
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1); // the loser still gets the row back, as already adopted
    });

    it('allows one recommendation per rank in a review', async ({ skip }) => {
      if (!reachable) skip();
      const reviewId = await reviewWithRecommendations();
      await expect(pool.query(
        `insert into public.recommendations (review_id, rank, assistant_id, change, why) values ($1, 1, 'owner', 'x', 'y')`, [reviewId],
      )).rejects.toThrow(/duplicate key/);
    });
  });
});
