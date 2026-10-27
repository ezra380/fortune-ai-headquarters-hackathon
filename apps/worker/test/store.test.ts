import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import type { ManagerReview, WorkReport } from '@fahq/contracts';
import { createStore } from '../src/store.ts';
import { dbUrl, localApi } from './localdb.ts';

// The store's manager tables on the real local database (no mocks). Skipped when the stack is down.

const api = localApi();
if (!api) console.warn('SKIPPED store tests: needs local Supabase (npm run db:start)');
const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });

// What these tests write is removed again: reports in a far-future year, and reviews with their
// recommendations, would otherwise show up in every later test that reads "the last 24 hours" or the
// adopted lessons.
const madeTasks: string[] = [];
afterAll(async () => {
  try {
    if (madeTasks.length > 0) await pool.query('delete from public.work_reports where task_id = any($1)', [madeTasks]);
    await pool.query(`delete from public.recommendations where review_id in (select id from public.manager_reviews where review_key like 'store-test-review:%')`);
    await pool.query(`delete from public.manager_reviews where review_key like 'store-test-review:%'`);
  } finally {
    await pool.end();
  }
});

const T0 = '2026-10-26T12:00:00Z';
const T1 = '2026-10-26T12:00:09Z';

async function newTask(assistant = 'finance', status = 'done'): Promise<string> {
  const { rows } = await pool.query(
    `insert into public.tasks (assistant_id, kind, idempotency_key, payload, status) values ($1, 'mailbox', $2, '{}'::jsonb, $3) returning id`,
    [assistant, 'store-test:' + randomUUID(), status],
  );
  madeTasks.push(rows[0].id as string);
  return rows[0].id as string;
}

function report(taskId: string, patch: Partial<WorkReport> = {}): WorkReport {
  return {
    taskId, runId: randomUUID(), assistant: 'finance', taskKind: 'mailbox', outcome: 'done',
    summary: 'mailbox task done in 9 s; finance.plans ok (attempt 1 of 2)',
    steps: [{ step: 'finance.plans', outcome: 'ok', model: 'nvidia/ultra', ms: 9000, inputTokens: 100, outputTokens: 200, detail: null }],
    usage: { modelCalls: 1, inputTokens: 100, outputTokens: 200 },
    suggestions: [], startedAt: T0, endedAt: T1, ...patch,
  };
}

const review: ManagerReview = {
  summary: 'Two tasks in the last 24 hours.',
  findings: [{ assistant: 'finance', text: 'One plan needed a second round.' }],
  recommendations: [
    { rank: 1, assistant: 'finance', change: 'Keep each stop-loss as a lever.', why: 'The first attempt was rejected.' },
    { rank: 2, assistant: 'owner', change: 'Say which business a question is about.', why: 'One question was ambiguous.' },
  ],
};

describe.skipIf(!api)('store: reports, reviews, recommendations (real local database)', () => {
  const store = createStore(api!.url, api!.key);

  it('writes tokens on a receipt, and null when the step called no model', async () => {
    const runId = randomUUID();
    const base = { runId, taskId: null, assistantId: 'finance' as const, live: false, model: null, dataSource: null, startedAt: T0, endedAt: T1, costUsd: null, outcome: 'ok' as const, detail: null };
    await store.receipt({ ...base, step: 'tokens.yes', inputTokens: 12, outputTokens: 34 });
    await store.receipt({ ...base, step: 'tokens.no' });
    const { rows } = await pool.query('select step, input_tokens, output_tokens from public.receipts where run_id = $1 order by id', [runId]);
    expect(rows).toEqual([
      { step: 'tokens.yes', input_tokens: 12, output_tokens: 34 },
      { step: 'tokens.no', input_tokens: null, output_tokens: null },
    ]);
  });

  it('keeps one report per task (the latest attempt wins) and reads them newest first', async () => {
    // Reports in a year of their own, so the newest-200 window other tests fill up never hides them.
    const year = 3000 + Math.floor(Math.random() * 6000);
    const at = (hms: string) => `${year}-01-01T${hms}Z`;
    const since = new Date(at('11:00:00'));
    const task = await newTask();
    await store.saveWorkReport(report(task, { outcome: 'retrying', summary: 'first attempt', startedAt: at('12:00:00'), endedAt: at('12:00:09') }));
    await store.saveWorkReport(report(task, { outcome: 'done', summary: 'second attempt', startedAt: at('12:00:00'), endedAt: at('12:00:09'), usage: { modelCalls: 2, inputTokens: 300, outputTokens: 400 } }));
    const mine = (await store.workReports({ since, limit: 200 })).filter((r) => r.task_id === task);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ outcome: 'done', summary: 'second attempt', input_tokens: 300, output_tokens: 400, model_calls: 2, assistant_id: 'finance' });

    const later = await newTask('owner');
    await store.saveWorkReport(report(later, { assistant: 'owner', startedAt: at('12:30:00'), endedAt: at('12:30:09') }));
    const all = await store.workReports({ since });
    expect(all.findIndex((r) => r.task_id === later)).toBeLessThan(all.findIndex((r) => r.task_id === task)); // newest first
    const ownerOnly = await store.workReports({ since, assistant: 'owner' });
    expect(ownerOnly.length).toBeGreaterThan(0);
    expect(ownerOnly.every((r) => r.assistant_id === 'owner')).toBe(true);
    expect(await store.workReports({ since: new Date(at('12:20:00')), limit: 1 })).toHaveLength(1);
    expect(await store.workReports({ since: new Date('9999-12-31T00:00:00Z') })).toEqual([]);
  });

  it('saves a review once per key, its recommendations once per rank, and adopts them idempotently', async () => {
    const key = 'store-test-review:' + randomUUID();
    const input = { key, taskId: null, coversFrom: new Date('2026-10-25T12:00:00Z'), coversTo: new Date(T0), reportCount: 2, review, digest: { tasks: 2 }, model: 'nvidia/ultra' };
    const first = await store.saveManagerReview(input);
    const again = await store.saveManagerReview({ ...input, reportCount: 99 });
    expect(again.id).toBe(first.id);
    expect(again.report_count).toBe(2); // the first write stands
    expect(first.review.recommendations).toHaveLength(2);
    expect((await store.reviewByKey(key))?.id).toBe(first.id);
    expect(await store.reviewByKey(key + ':never-written')).toBeNull();

    const wrapped = await store.saveManagerReview({ ...input, key: key + ':list', digest: [1, 2] });
    expect(wrapped.digest).toEqual({ result: [1, 2] });

    const recs = await store.saveRecommendations(first.id, review.recommendations);
    const recsAgain = await store.saveRecommendations(first.id, review.recommendations);
    expect(recs.map((r) => [r.rank, r.assistant_id, r.status])).toEqual([[1, 'finance', 'proposed'], [2, 'owner', 'proposed']]);
    expect(recsAgain.map((r) => r.id)).toEqual(recs.map((r) => r.id));

    const message = await store.postMessage({ from: 'manager', to: 'owner', kind: 'report', replyTo: null, dedupeKey: 'review:' + first.id, body: { reviewId: first.id } });
    await store.setReviewMessage(first.id, message.id);
    expect((await store.saveManagerReview(input)).message_id).toBe(message.id);

    const adopted = await store.adoptRecommendations(first.id, [2, 3], 'demo-p-owner', new Date(T1));
    expect(adopted).toMatchObject([{ rank: 2, assistant_id: 'owner', change: review.recommendations[1]!.change, newly_adopted: true }]);
    const retried = await store.adoptRecommendations(first.id, [2, 3], 'demo-p-owner', new Date(T1));
    expect(retried).toMatchObject([{ recommendation_id: adopted[0]!.recommendation_id, newly_adopted: false }]);

    const lessons = await store.adoptedLessons('owner', 200);
    expect(lessons.find((l) => l.id === adopted[0]!.recommendation_id)).toMatchObject({ assistant_id: 'owner', review_id: first.id });
    expect((await store.adoptedLessons('finance', 200)).some((l) => l.review_id === first.id)).toBe(false);
  });

  it('counts open tasks and pending approvals per assistant, without codes or hashes', async () => {
    const before = await store.openItems(new Date());
    const task = await newTask('online', 'queued');
    const after = await store.openItems(new Date());
    expect(after.map((r) => r.assistant)).toEqual(['owner', 'finance', 'salon', 'online', 'manager', 'legal']);
    expect(after.find((r) => r.assistant === 'online')!.openTasks).toBe(before.find((r) => r.assistant === 'online')!.openTasks + 1);
    expect(JSON.stringify(after)).not.toMatch(/code|hash|\d{6}/i);
    await pool.query(`update public.tasks set status = 'cancelled' where id = $1`, [task]);
  });

  it('describes the newest proposal by its short id and titles, and notices a decision', async () => {
    const proposal = await store.postMessage({
      from: 'finance', to: 'owner', kind: 'proposal', replyTo: null, dedupeKey: 'store-test-proposal:' + randomUUID(),
      body: { plans: { plans: [{ title: 'Plan A' }, { title: 'Plan B' }] }, metrics: [{ id: 'm:online.revenue.mazali' }] },
    });
    const latest = await store.latestProposal();
    expect(latest).toMatchObject({ id: proposal.id.slice(0, 8), titles: ['Plan A', 'Plan B'], citedMetricIds: ['m:online.revenue.mazali'], decided: false });
    await store.postMessage({ from: 'finance', to: 'owner', kind: 'decision', replyTo: null, dedupeKey: 'store-test-decision:' + randomUUID(), body: { proposalId: proposal.id, verdict: 'signed' } });
    expect((await store.latestProposal())?.decided).toBe(true);
  });

  it("never offers a department's own proposal in a round as the newest set of plans", async () => {
    await store.postMessage({
      from: 'owner', to: 'owner', kind: 'proposal', replyTo: null, dedupeKey: 'store-test-final:' + randomUUID(),
      body: { plans: { plans: [{ title: 'Final A' }] }, origins: [] },
    });
    // Posted AFTER the final one, so by time alone it would be the newest proposal.
    await store.postMessage({
      from: 'salon', to: 'owner', kind: 'proposal', replyTo: null, dedupeKey: 'store-test-dept:' + randomUUID(),
      body: { plans: { plans: [{ title: 'Salon own plan' }] }, department: 'salon', roundId: randomUUID() },
    });
    const newest = await store.latestFinalProposal();
    expect(newest).not.toBeNull();
    expect(newest!.body.department).toBeUndefined();
    expect((await store.latestProposal())?.titles).not.toContain('Salon own plan');
  });

  it('finds a proposal by its whole id or its first characters, and by nothing else', async () => {
    const proposal = await store.postMessage({ from: 'owner', to: 'owner', kind: 'proposal', replyTo: null, dedupeKey: 'store-test-find:' + randomUUID(), body: { plans: { plans: [] } } });
    expect((await store.proposalByPrefix(proposal.id)).proposal?.id).toBe(proposal.id);
    expect((await store.proposalByPrefix(proposal.id.slice(0, 8))).proposal?.id).toBe(proposal.id);
    expect(await store.proposalByPrefix('zzzzzzzz')).toEqual({ proposal: null, ambiguous: false });
    // A decision is not a proposal, even when its id is asked for.
    const decision = await store.postMessage({ from: 'finance', to: 'owner', kind: 'decision', replyTo: null, dedupeKey: 'store-test-find-d:' + randomUUID(), body: {} });
    expect((await store.proposalByPrefix(decision.id)).proposal).toBeNull();
  });

  it('lists the approvals on a proposal and on what was sent from it, with the plan, and never a code', async () => {
    const proposal = await store.postMessage({ from: 'owner', to: 'owner', kind: 'proposal', replyTo: null, dedupeKey: 'store-test-appr:' + randomUUID(), body: { plans: { plans: [] } } });
    const forward = await store.postMessage({ from: 'owner', to: 'finance', kind: 'request', replyTo: proposal.id, dedupeKey: 'store-test-appr-f:' + randomUUID(), body: { proposalId: proposal.id, planRank: 2 } });
    const now = new Date();
    await store.issueApproval({ messageId: proposal.id, personId: 'demo-p-owner', action: 'forward_plan', code: '123456', from: 'owner', now, smsBody: 'store test 123456', smsDedupeKey: 'store-test-appr-s1:' + randomUUID() });
    await store.issueApproval({ messageId: forward.id, personId: 'demo-p-finance-owner', action: 'decide_plan', code: '654321', from: 'finance', now, smsBody: 'store test 654321', smsDedupeKey: 'store-test-appr-s2:' + randomUUID() });
    try {
      const approvals = await store.approvalsOf(proposal.id);
      expect(approvals.map((a) => [a.action, a.status, a.planRank, a.decidedAt])).toEqual([['forward_plan', 'pending', null, null], ['decide_plan', 'pending', 2, null]]);
      expect(Date.parse(approvals[0]!.expiresAt)).toBe(now.getTime() + 15 * 60_000);
      expect(JSON.stringify(approvals)).not.toMatch(/123456|654321|hash/i);
      expect(await store.approvalsOf(randomUUID())).toEqual([]);
    } finally {
      // Leave no pending approval or text behind for the other tests that read the queue.
      await pool.query(`update public.approvals set status = 'expired' where message_id = any($1)`, [[proposal.id, forward.id]]);
      await pool.query(`update public.outbox set status = 'skipped', last_error = 'store test' where dedupe_key like 'store-test-appr-s%' and status = 'pending'`);
    }
  });
});
