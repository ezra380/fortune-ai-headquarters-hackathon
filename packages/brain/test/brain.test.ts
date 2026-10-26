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
    expect(relates(reader)).toBe(relates(brain));
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
  });

  it('flags a new plan that repeats a declined idea, and keeps assistants apart', async () => {
    const brain = await openBrain({ meterlessDir, dataDir: tmp(), actor: 'test-worker', clock: fixedClock });
    const finance = brain.memory('finance');
    finance.rememberDecision({ proposalId: 'p9', personId: 'demo-p-finance-owner', verdict: 'declined', planRank: 2, planTitle: 'Discount Mazali wigs twenty percent for October', runId: 'r9' });
    expect(finance.declinedSimilarTo('Discount Mazali wigs twenty percent this weekend')).toHaveLength(1);
    expect(finance.declinedSimilarTo('Add a premium Fortune appointment slot on Sundays')).toHaveLength(0);
    expect(brain.memory('salon').declinedSimilarTo('Discount Mazali wigs twenty percent this weekend')).toHaveLength(0);
  });
});
