import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openBrain } from '../src/index.ts';

const meterlessDir = path.resolve(process.env.METERLESS_DIR ?? '.local/meterless');
const haveMeterless = fs.existsSync(path.join(meterlessDir, 'engines/world-model/reference/src/index.ts'));
if (!haveMeterless) console.warn(`SKIPPED brain tests: Meterless engines not found at ${meterlessDir} (run scripts/setup-meterless.sh)`);

const fixedClock = () => new Date('2026-10-26T12:00:00Z');
const stamp = (n: number) => ({ at: `2026-10-26T12:00:0${n}Z`, runId: '00000000-0000-4000-8000-00000000000' + n });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fahq-brain-'));

describe.skipIf(!haveMeterless)('shared record (Meterless World Model)', () => {
  it('records request → proposal → decision, persists, and replays without duplicates', async () => {
    const dataDir = tmp();
    const brain = await openBrain({ meterlessDir, dataDir, actor: 'test-worker', clock: fixedClock });
    const taskId = '11111111-1111-4111-8111-111111111111';
    const proposalId = '22222222-2222-4222-8222-222222222222';
    await brain.record.request({ taskId, personId: 'demo-p-owner', personName: 'Demo Owner', from: 'owner', to: 'finance', text: 'Three plans please', ...stamp(1) });
    await brain.record.proposal({ proposalId, requestTaskId: taskId, by: 'finance', forPersonId: 'demo-p-owner', titles: ['A', 'B', 'C'], citedMetricIds: ['m:online.revenue.mazali'], dataSource: 'zetaris:abc', ...stamp(2) });
    await brain.record.decision({ proposalId, personId: 'demo-p-finance-owner', personName: 'Demo Finance Owner', verdict: 'signed', planRank: 2, action: 'decide_plan', ...stamp(3) });
    const count = brain.record.timeline(1000).length;
    expect(count).toBeGreaterThan(5);
    expect(brain.record.audit(1000).length).toBeGreaterThan(0);

    // A second process opening the same namespace sees the same history (append-only file replay).
    const reader = await openBrain({ meterlessDir, dataDir, actor: 'reader', clock: fixedClock });
    expect(reader.record.timeline(1000).length).toBe(count);

    // Re-recording the same proposal at the same time is a no-op for the relationships it already has.
    await reader.record.proposal({ proposalId, requestTaskId: taskId, by: 'finance', forPersonId: 'demo-p-owner', titles: ['A', 'B', 'C'], citedMetricIds: ['m:online.revenue.mazali'], dataSource: 'zetaris:abc', ...stamp(2) });
    const relates = (b: typeof reader) => b.record.timeline(1000).filter((e) => e.type === 'relate').length;
    expect(relates(brain)).toBeGreaterThan(0); // the event kind is really read (it was undefined before)
    expect(relates(reader)).toBe(relates(brain));
    for (const e of brain.record.timeline(1000)) {
      expect(['upsertEntity', 'upsertContext', 'relate', 'assertFact', 'snapshot', 'tombstone', 'alias', 'view-rebuild']).toContain(e.type);
      expect(Number.isNaN(Date.parse(e.at))).toBe(false);
    }
  });
});

describe.skipIf(!haveMeterless)('assistant memory (Meterless H-MEM)', () => {
  it('never recalls an unapproved proposal as a decision, and recalls a decision once made', async () => {
    const brain = await openBrain({ meterlessDir, dataDir: tmp(), actor: 'test-worker', clock: fixedClock });
    const finance = brain.memory('finance');
    finance.rememberProposal({ proposalId: 'p1', summary: 'Cut wash and set prices by ten percent to fill weekday slots', runId: 'r1' });
    expect(finance.recallDecisions('wash and set prices weekday')).toHaveLength(0);

    finance.rememberDecision({ proposalId: 'p1', personId: 'demo-p-finance-owner', verdict: 'declined', planRank: 1, planTitle: 'Cut wash and set prices by ten percent to fill weekday slots', runId: 'r2' });
    const decisions = finance.recallDecisions('wash and set prices weekday');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.memory.content).toContain('declined');
    expect(decisions[0]?.relevance).toBeGreaterThan(0); // H-MEM's field is `relevance`, not `score`
  });

  it('flags a new plan that repeats a declined idea, and keeps assistants apart', async () => {
    const brain = await openBrain({ meterlessDir, dataDir: tmp(), actor: 'test-worker', clock: fixedClock });
    const finance = brain.memory('finance');
    finance.rememberDecision({ proposalId: 'p9', personId: 'demo-p-finance-owner', verdict: 'declined', planRank: 2, planTitle: 'Discount Mazali wigs twenty percent for October', runId: 'r9' });
    expect(finance.declinedSimilarTo('Discount Mazali wigs twenty percent this weekend')).toHaveLength(1);
    expect(finance.declinedSimilarTo('Add a premium Fortune appointment slot on Sundays')).toHaveLength(0);
    expect(brain.memory('salon').declinedSimilarTo('Discount Mazali wigs twenty percent this weekend')).toHaveLength(0);
  });

  it('flags a realistic new plan title that repeats a declined one', async () => {
    const brain = await openBrain({ meterlessDir, dataDir: tmp(), actor: 'test-worker', clock: fixedClock });
    const finance = brain.memory('finance');
    finance.rememberDecision({ proposalId: 'p7', personId: 'demo-p-finance-owner', verdict: 'declined', planRank: 1, planTitle: 'Aggressive ad scale and email push to double profit', runId: 'r7' });
    expect(finance.declinedSimilarTo('Double profit through aggressive ad scaling and an email push')).toHaveLength(1);
    expect(finance.declinedSimilarTo('Evening wash and set slots')).toHaveLength(0);
    expect(finance.declinedSimilarTo('Balanced growth via price optimization')).toHaveLength(0);
  });
});

describe.skipIf(!haveMeterless)('lessons and review notes (Meterless H-MEM)', () => {
  const lesson = (n: number) => ({
    recommendationId: `00000000-0000-4000-8000-00000000000${n}`,
    text: `Ask for a lever on every stop-loss threshold number ${n}`,
    adoptedBy: 'demo-p-owner',
    reviewId: '33333333-3333-4333-8333-333333333333',
    runId: `r${n}`,
  });

  it('keeps an adopted lesson as long-term memory, once per recommendation, newest first', async () => {
    const brain = await openBrain({ meterlessDir, dataDir: tmp(), actor: 'test-worker', clock: fixedClock });
    const finance = brain.memory('finance');
    const first = finance.rememberLesson(lesson(1));
    expect(first).toMatchObject({ layer: 'long_term', confidence: 0.9 });
    expect(first.tags).toEqual(expect.arrayContaining(['lesson', 'adopted', `recommendation:${lesson(1).recommendationId}`]));
    expect(finance.rememberLesson(lesson(1)).id).toBe(first.id); // a retried task finds the same memory

    const second = finance.rememberLesson({ ...lesson(2), text: 'Never mix salon and online numbers in one sentence about reach' });
    expect(finance.lessons().map((m) => m.id)).toEqual([second.id, first.id]);
    expect(finance.lessons(1).map((m) => m.id)).toEqual([second.id]);
    expect(brain.memory('salon').lessons()).toEqual([]); // each assistant keeps its own
    expect(brain.memory('manager').lessons()).toEqual([]);
  });

  it('never returns a lesson from recallDecisions, and still returns a decision', async () => {
    const brain = await openBrain({ meterlessDir, dataDir: tmp(), actor: 'test-worker', clock: fixedClock });
    const finance = brain.memory('finance');
    finance.rememberLesson({ ...lesson(1), text: 'Wash and set prices should wait for a decision from the owner' });
    expect(finance.recallDecisions('wash and set prices owner decision')).toEqual([]);

    finance.rememberDecision({ proposalId: 'p5', personId: 'demo-p-finance-owner', verdict: 'signed', planRank: 2, planTitle: 'Evening wash and set slots', runId: 'r5' });
    const decisions = finance.recallDecisions('wash and set prices owner decision evening slots', 10);
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.every((d) => d.memory.tags.includes('decision') && !d.memory.tags.includes('lesson'))).toBe(true);
    expect(finance.lessons()).toHaveLength(1); // and the decision is not a lesson
  });

  it('keeps a review note short-term and unapproved, once per review, out of decisions and lessons', async () => {
    const brain = await openBrain({ meterlessDir, dataDir: tmp(), actor: 'test-worker', clock: fixedClock });
    const manager = brain.memory('manager');
    const note = manager.rememberReviewNote({ reviewId: 'rev1', summary: 'Two tasks, one needed a second round.', runId: 'r1' });
    expect(note).toMatchObject({ layer: 'short_term', confidence: 0.4 });
    expect(note.tags).toEqual(expect.arrayContaining(['review', 'unapproved', 'review:rev1']));
    expect(manager.rememberReviewNote({ reviewId: 'rev1', summary: 'changed words', runId: 'r2' }).id).toBe(note.id);
    expect(manager.recallDecisions('two tasks second round')).toEqual([]);
    expect(manager.lessons()).toEqual([]);
  });
});

describe.skipIf(!haveMeterless)('shared record: reports, reviews, adoptions', () => {
  it('records a report, a review and an adoption, persists them, and replays without duplicates', async () => {
    const dataDir = tmp();
    const brain = await openBrain({ meterlessDir, dataDir, actor: 'test-worker', clock: fixedClock });
    const taskId = '44444444-4444-4444-8444-444444444444';
    const reviewId = '55555555-5555-4555-8555-555555555555';
    const recommendationId = '66666666-6666-4666-8666-666666666666';
    const calls = async (b: typeof brain) => {
      await b.record.report({ taskId, assistant: 'finance', outcome: 'done', summary: 'mailbox task done in 9 s', ...stamp(1) });
      await b.record.review({ reviewId, recommendationCount: 2, reviewed: ['finance', 'owner'], ...stamp(2) });
      await b.record.adoption({ recommendationId, reviewId, personId: 'demo-p-owner', personName: 'Demo Owner', assistant: 'finance', ...stamp(3) });
    };
    await calls(brain);
    const events = brain.record.timeline(1000);
    const relates = events.filter((e) => e.type === 'relate').length;
    expect(relates).toBeGreaterThanOrEqual(7); // reported, wrote, 2x reviewed, recommended, adopted, guides
    const summaries = brain.record.audit(1000).map((a) => a.summary).join('\n');
    for (const verb of ['reported', 'wrote', 'reviewed', 'recommended', 'adopted', 'guides']) expect(summaries).toContain(`-[${verb}]->`);

    await calls(brain); // the same events again: nothing new in the relationships
    expect(brain.record.timeline(1000).filter((e) => e.type === 'relate').length).toBe(relates);

    const reader = await openBrain({ meterlessDir, dataDir, actor: 'reader', clock: fixedClock });
    expect(reader.record.timeline(1000).filter((e) => e.type === 'relate').length).toBe(relates);
  });
});
