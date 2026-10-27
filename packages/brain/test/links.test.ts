import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMeterless, SharedRecord } from '../src/index.ts';

// The shared record on the REAL Meterless World Model: every link a source makes to many targets stays
// open (the World Model closes an edge whose source, type and context repeat), and explainProposal
// reads the trail back from the graph.

const meterlessDir = path.resolve(process.env.METERLESS_DIR ?? '.local/meterless');
const haveMeterless = fs.existsSync(path.join(meterlessDir, 'engines/world-model/reference/src/index.ts'));
if (!haveMeterless) console.warn(`SKIPPED link tests: Meterless engines not found at ${meterlessDir} (run scripts/setup-meterless.sh)`);

const clock = () => new Date('2026-10-26T12:00:00Z');
const stamp = (n: number) => ({ at: `2026-10-26T12:00:0${n}Z`, runId: '00000000-0000-4000-8000-00000000000' + n });

const P1 = '77777777-7777-4777-8777-777777777777';
const P2 = '88888888-8888-4888-8888-888888888888';
const R1 = '99999999-9999-4999-8999-999999999999';
const R2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const owner = { personId: 'demo-p-owner', personName: 'Demo Owner' };
const financeOwner = { personId: 'demo-p-finance-owner', personName: 'Demo Finance Owner' };
const METRICS = ['m:online.revenue.mazali', 'm:online.ads.google.spend', 'm:online.ads.google.roas'];

const person = (id: string) => `person:fahq:${id}`;
const assistant = (id: string) => `assistant:fahq:assistant:${id}`;
const proposalEntity = (id: string) => `proposal:fahq:${id}`;

async function freshRecord() {
  const engines = await loadMeterless(meterlessDir);
  const wm = new engines.WorldModel({ namespace: 'links-test', storage: 'memory', clock });
  return { wm, record: new SharedRecord(wm, 'test-worker') };
}

describe.skipIf(!haveMeterless)('shared record keeps every link', () => {
  it('keeps one open cites edge for each metric a proposal cites', async () => {
    const { wm, record } = await freshRecord();
    await record.proposal({ proposalId: P1, requestTaskId: R1, by: 'finance', forPersonId: owner.personId, titles: ['A', 'B', 'C'], citedMetricIds: METRICS, dataSource: 'zetaris:abc', ...stamp(1) });
    const cited = wm.view('graph').neighborsOf(proposalEntity(P1), { via: 'cites' });
    expect(cited.map((m) => m.name).sort()).toEqual([...METRICS].sort());
  });

  it("keeps both of a person's requests, and both proposals one person forwarded and approved", async () => {
    const { wm, record } = await freshRecord();
    await record.request({ taskId: R1, ...owner, from: 'owner', to: 'finance', text: 'First ask', ...stamp(1) });
    await record.request({ taskId: R2, ...owner, from: 'owner', to: 'finance', text: 'Second ask', ...stamp(2) });
    for (const [proposalId, taskId] of [[P1, R1], [P2, R2]] as const) {
      await record.proposal({ proposalId, requestTaskId: taskId, by: 'finance', forPersonId: owner.personId, titles: ['A'], citedMetricIds: [METRICS[0]!], dataSource: 'zetaris:abc', ...stamp(3) });
      await record.decision({ proposalId, ...owner, verdict: 'signed', planRank: 1, action: 'forward_plan', ...stamp(4) });
      await record.decision({ proposalId, ...financeOwner, verdict: 'signed', planRank: 1, action: 'decide_plan', ...stamp(5) });
    }
    const graph = wm.view('graph');
    expect(graph.neighborsOf(person(owner.personId), { via: 'asked' })).toHaveLength(2);
    expect(graph.neighborsOf(person(owner.personId), { via: 'forwarded' })).toHaveLength(2);
    expect(graph.neighborsOf(person(financeOwner.personId), { via: 'approved' })).toHaveLength(2);
    expect(graph.neighborsOf(assistant('finance'), { via: 'proposed' })).toHaveLength(2);
  });

  it("keeps a round's request assigned to every department that was asked", async () => {
    const { wm, record } = await freshRecord();
    for (const to of ['finance', 'salon', 'online'] as const) {
      await record.request({ taskId: R1, ...owner, from: 'owner', to, text: 'Three plans please', ...stamp(1) });
    }
    const assigned = wm.view('graph').neighborsOf(`request:fahq:${R1}`, { via: 'assigned_to' });
    expect(assigned.map((a) => a.name).sort()).toEqual(['finance', 'online', 'salon']);
  });

  it('keeps every report, review, reviewed assistant and adoption', async () => {
    const { wm, record } = await freshRecord();
    for (const [n, taskId] of [[1, R1], [2, R2]] as const) await record.report({ taskId, assistant: 'finance', outcome: 'done', summary: 'ok', ...stamp(n) });
    await record.review({ reviewId: P1, recommendationCount: 2, reviewed: ['finance', 'owner'], ...stamp(3) });
    await record.review({ reviewId: P2, recommendationCount: 0, reviewed: ['salon'], ...stamp(4) });
    for (const [n, recommendationId] of [[5, R1], [6, R2]] as const) {
      await record.adoption({ recommendationId, reviewId: P1, ...owner, assistant: 'finance', ...stamp(n) });
    }
    const graph = wm.view('graph');
    expect(graph.neighborsOf(assistant('finance'), { via: 'reported' })).toHaveLength(2);
    expect(graph.neighborsOf(assistant('manager'), { via: 'wrote' })).toHaveLength(2);
    expect(graph.neighborsOf(assistant('manager'), { via: 'reviewed' })).toHaveLength(3);
    expect(graph.neighborsOf(`review:fahq:review:${P1}`, { via: 'recommended' })).toHaveLength(2);
    expect(graph.neighborsOf(person(owner.personId), { via: 'adopted' })).toHaveLength(2);
  });
});

describe.skipIf(!haveMeterless)('explainProposal', () => {
  it('gives the request and who asked it, every cited metric, and each decision with its plan rank', async () => {
    const { record } = await freshRecord();
    await record.request({ taskId: R1, ...owner, from: 'owner', to: 'online', text: 'Plans to grow online profit', ...stamp(1) });
    await record.proposal({ proposalId: P1, requestTaskId: R1, by: 'online', forPersonId: owner.personId, titles: ['Plan A', 'Plan B', 'Plan C'], citedMetricIds: METRICS, dataSource: 'zetaris:abc123', ...stamp(2) });
    await record.decision({ proposalId: P1, ...owner, verdict: 'signed', planRank: 2, action: 'forward_plan', ...stamp(3) });
    await record.decision({ proposalId: P1, ...financeOwner, verdict: 'declined', planRank: 2, action: 'decide_plan', ...stamp(4) });

    expect(record.explainProposal(P1)).toEqual({
      proposal: { id: P1, titles: ['Plan A', 'Plan B', 'Plan C'], dataSource: 'zetaris:abc123' },
      request: { text: 'Plans to grow online profit', from: 'owner', askedBy: 'Demo Owner', at: stamp(1).at },
      cites: [...METRICS].sort(),
      decisions: [
        { by: 'Demo Owner', action: 'forwarded', planRank: 2, at: stamp(3).at },
        { by: 'Demo Finance Owner', action: 'declined', planRank: 2, at: stamp(4).at },
      ],
    });
  });

  it('says nothing for a proposal nobody recorded, and invents no request or decision for a thin record', async () => {
    const { record } = await freshRecord();
    expect(record.explainProposal(P2)).toEqual({ proposal: null, request: null, cites: [], decisions: [] });
    await record.proposal({ proposalId: P1, requestTaskId: R1, by: 'finance', forPersonId: owner.personId, titles: ['A'], citedMetricIds: [], dataSource: 'zetaris:abc', ...stamp(1) });
    const explained = record.explainProposal(P1);
    expect(explained.decisions).toEqual([]);
    expect(explained.cites).toEqual([]);
    // Only the proposal's own call recorded the request, so it has no text and nobody who asked.
    expect(explained.request).toMatchObject({ text: '', askedBy: null });
  });

  it('returns only the edges still open when an older record had closed some of them', async () => {
    const { wm, record } = await freshRecord();
    await record.proposal({ proposalId: P1, requestTaskId: R1, by: 'finance', forPersonId: owner.personId, titles: ['A'], citedMetricIds: [], dataSource: 'zetaris:abc', ...stamp(1) });
    // What the record wrote before relations carried a context: the second cites edge closed the first.
    for (const metricId of METRICS.slice(0, 2)) {
      const source = { kind: 'agent', by: 'old-worker', at: stamp(2).at };
      const metric = await wm.upsertEntity({ type: 'metric', externalKey: { system: 'zetaris', id: metricId }, name: metricId, attrs: {}, source });
      await wm.relate({ from: proposalEntity(P1), type: 'cites', to: metric.id, source });
    }
    expect(record.explainProposal(P1).cites).toEqual([METRICS[1]]);
  });
});
