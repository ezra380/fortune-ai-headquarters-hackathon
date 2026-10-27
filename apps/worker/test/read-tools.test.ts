import { describe, expect, it } from 'vitest';
import type { AssistantId } from '@fahq/contracts';
import { createReadTools, pick, type ReadToolContext } from '../src/read-tools.ts';
import type { WorkReportRow } from '../src/store.ts';
import { dataMock } from './fixtures.ts';

// FAKES: an in-memory store, brain and data port, to pin down what each read tool returns and refuses.

const NOW = new Date('2026-10-26T12:00:00.000Z');
const NAMES = [
  'get_finance_metrics', 'get_online_metrics', 'recall_my_decisions', 'recall_decisions', 'my_lessons', 'list_lessons',
  'get_timeline', 'list_work_reports', 'usage_summary', 'open_items', 'latest_proposal',
];

function reportRow(over: Partial<WorkReportRow> = {}): WorkReportRow {
  return {
    id: 'r1', task_id: '12345678-1234-4234-8234-123456789abc', run_id: 'run', assistant_id: 'finance', task_kind: 'mailbox', outcome: 'done',
    summary: 'mailbox task done in 9 s; finance.plans ok (attempt 1 of 2)', steps: [], usage: { modelCalls: 1, inputTokens: 100, outputTokens: 200 },
    suggestions: [{ kind: 'speed', about: 'finance', text: 'finance.plans took 75 s' }],
    input_tokens: 100, output_tokens: 200, model_calls: 1,
    started_at: '2026-10-26T11:00:00.000Z', ended_at: '2026-10-26T11:00:09.500Z', ...over,
  };
}

function setup(over: { reports?: WorkReportRow[]; data?: ReadToolContext['data'] } = {}) {
  const calls = {
    reports: [] as { since: Date; assistant?: AssistantId; limit?: number }[],
    lessons: [] as { assistant?: AssistantId; limit?: number }[],
    recall: [] as { assistant: AssistantId; query: string; topN: number }[],
    timeline: [] as number[],
    memoryOf: [] as AssistantId[],
  };
  const ctx: ReadToolContext = {
    store: {
      workReports: async (q) => { calls.reports.push(q); return over.reports ?? [reportRow()]; },
      adoptedLessons: async (assistant, limit) => {
        calls.lessons.push({ assistant, limit });
        return [{ id: 'l1', review_id: 'rv', assistant_id: 'finance', change: 'Give each stop-loss a lever.', decided_at: '2026-10-26T10:00:00Z' }];
      },
      openItems: async () => [{ assistant: 'owner', openTasks: 2, pendingApprovals: 1 }, { assistant: 'manager', openTasks: 0, pendingApprovals: 0 }],
      latestProposal: async () => null,
    },
    brain: {
      memory: (assistant: AssistantId) => {
        calls.memoryOf.push(assistant);
        return {
          recallDecisions: (query: string, topN: number) => {
            calls.recall.push({ assistant, query, topN });
            return [{ memory: { id: `mem-${assistant}`, content: `Decision by demo-p-owner for ${assistant}`, layer: 'long_term', tags: ['decision'], confidence: 0.9, source: 's' }, relevance: 0.456789 }];
          },
          lessons: () => [{ id: 'm1', content: `Lesson for ${assistant}`, layer: 'long_term', tags: ['lesson'], confidence: 0.9, source: 's' }],
        };
      },
      record: { timeline: (limit: number) => { calls.timeline.push(limit); return [{ id: 'e1', type: 'relate', at: '2026-10-26T11:00:00Z' }]; } },
    } as unknown as ReadToolContext['brain'],
    data: 'data' in over ? over.data! : dataMock,
    now: () => NOW,
  };
  return { ctx, calls };
}

describe('read tools', () => {
  it('offers exactly the documented names, each with a description and a typed signature', () => {
    const tools = createReadTools(setup().ctx, 'owner');
    expect(Object.keys(tools).sort()).toEqual([...NAMES].sort());
    for (const [key, t] of Object.entries(tools)) {
      expect(t.name).toBe(key);
      expect(t.name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/); // a JavaScript identifier
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.signature).toMatch(/^\(args: .*\) => Promise<.*>$/);
    }
  });

  it('checks arguments with plain sentences: a wrong period, a stray name, a missing or wrong-typed value', async () => {
    const tools = createReadTools(setup().ctx, 'finance');
    await expect(tools.get_finance_metrics!.run({ period: '2026-08' })).rejects.toThrow(/^get_finance_metrics: argument "period"/);
    await expect(tools.get_finance_metrics!.run({})).rejects.toThrow(/argument "period"/);
    await expect(tools.get_finance_metrics!.run({ period: '2026-09', extra: 1 })).rejects.toThrow(/has a name this function does not take \("extra"\)/);
    await expect(tools.usage_summary!.run({ sinceHours: 'a day' })).rejects.toThrow(/argument "sinceHours"/);
    await expect(tools.usage_summary!.run({ sinceHours: -4 })).rejects.toThrow(/argument "sinceHours"/);
    await expect(tools.recall_decisions!.run({ assistant: 'nobody', query: 'x' })).rejects.toThrow(/argument "assistant"/);
    await expect(tools.recall_my_decisions!.run({ query: '' })).rejects.toThrow(/argument "query"/);
    await expect(tools.my_lessons!.run({ surprise: true })).rejects.toThrow(/does not take/);
    await expect(tools.open_items!.run(null)).resolves.toBeTruthy(); // no arguments is fine for a no-argument tool
  });

  it('returns metrics with their business label, and only online ones from get_online_metrics', async () => {
    const tools = createReadTools(setup().ctx, 'finance');
    const all = (await tools.get_finance_metrics!.run({ period: '2026-09' })) as { view: string; queryHash: string; metrics: { id: string; business: string }[] };
    expect(all.view).toBe('fortune_demo_finance_mart');
    expect(all.queryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(all.metrics.map((m) => m.business))).toEqual(new Set(['online', 'salon']));
    expect(Object.keys(all.metrics[0]!).sort()).toEqual(['business', 'id', 'label', 'unit', 'value']);
    const online = (await tools.get_online_metrics!.run({ period: '2026-09' })) as { metrics: { business: string }[] };
    expect(online.metrics.length).toBeGreaterThan(0);
    expect(online.metrics.every((m) => m.business === 'online')).toBe(true);
  });

  it('says plainly when business data is not connected', async () => {
    const tools = createReadTools(setup({ data: null }).ctx, 'finance');
    await expect(tools.get_finance_metrics!.run({ period: '2026-09' })).rejects.toThrow('Business data is not connected, so there are no metrics to read.');
  });

  it('binds recall_my_decisions to the caller: finance never reads the owner\'s memory', async () => {
    const { ctx, calls } = setup();
    const out = (await createReadTools(ctx, 'finance').recall_my_decisions!.run({ query: 'wash and set', limit: 3 })) as { decisions: { id: string; text: string; relevance: number }[] };
    expect(out.decisions).toEqual([{ id: 'mem-finance', text: 'Decision by demo-p-owner for finance', relevance: 0.46 }]);
    expect(calls.memoryOf).toEqual(['finance']);
    expect(calls.recall).toEqual([{ assistant: 'finance', query: 'wash and set', topN: 3 }]);

    // recall_decisions names the assistant; my_lessons is the caller's again.
    await createReadTools(ctx, 'finance').recall_decisions!.run({ assistant: 'owner', query: 'prices' });
    expect(calls.memoryOf).toEqual(['finance', 'owner']);
    const mine = (await createReadTools(ctx, 'salon').my_lessons!.run({})) as { lessons: { text: string }[] };
    expect(mine.lessons).toEqual([{ text: 'Lesson for salon' }]);
    expect(calls.memoryOf.at(-1)).toBe('salon');
  });

  it('clamps every row limit to 50 and every window to 30 days', async () => {
    const { ctx, calls } = setup();
    const tools = createReadTools(ctx, 'manager');
    await tools.recall_my_decisions!.run({ query: 'x', limit: 5000 });
    await tools.get_timeline!.run({ limit: 5000 });
    await tools.get_timeline!.run({});
    await tools.list_work_reports!.run({ sinceHours: 24, limit: 5000 });
    await tools.list_work_reports!.run({ sinceHours: 24 * 365 });
    await tools.usage_summary!.run({ sinceHours: 24 * 365 });
    expect(calls.recall[0]!.topN).toBe(50);
    expect(calls.timeline).toEqual([50, 20]);
    expect(calls.reports.map((r) => r.limit)).toEqual([50, 25, 200]);
    expect(NOW.getTime() - calls.reports[1]!.since.getTime()).toBe(30 * 24 * 3_600_000);
    expect(NOW.getTime() - calls.reports[0]!.since.getTime()).toBe(24 * 3_600_000);
  });

  it('lists work reports compactly: no step detail, no message text, a short task id', async () => {
    const tools = createReadTools(setup().ctx, 'manager');
    const out = (await tools.list_work_reports!.run({ sinceHours: 24, assistant: 'finance' })) as { reports: Record<string, unknown>[] };
    expect(out.reports).toEqual([{
      task: '12345678', assistant: 'finance', kind: 'mailbox', outcome: 'done',
      summary: 'mailbox task done in 9 s; finance.plans ok (attempt 1 of 2)', modelCalls: 1, inputTokens: 100, outputTokens: 200, seconds: 9.5,
      suggestions: [{ kind: 'speed', about: 'finance', text: 'finance.plans took 75 s' }],
    }]);
  });

  it('never returns a phone number or a code, even inside a summary or a suggestion', async () => {
    const dirty = reportRow({
      summary: 'Texted +15551234567 about SEND 2 482913',
      suggestions: [{ kind: 'reliability', about: 'owner', text: 'The owner replied CONFIRM 654321 from +15559876543; the code was 111222' }],
    });
    const tools = createReadTools(setup({ reports: [dirty] }).ctx, 'manager');
    const text = JSON.stringify(await tools.list_work_reports!.run({ sinceHours: 1 }));
    expect(text).not.toMatch(/\+1\d{10}/);
    expect(text).not.toMatch(/482913|654321|111222/);
    expect(text).toContain('[phone]');
  });

  it('adds up usage over the window and says when the 200-report cap was hit', async () => {
    const rows = [reportRow(), reportRow({ assistant_id: 'owner', outcome: 'failed' })];
    const out = (await createReadTools(setup({ reports: rows }).ctx, 'manager').usage_summary!.run({ sinceHours: 24 })) as {
      since: string; truncated: boolean; byAssistant: { assistant: string; tasks: number }[]; totals: { tasks: number; failed: number; inputTokens: number };
    };
    expect(out.since).toBe('2026-10-25T12:00:00.000Z');
    expect(out.truncated).toBe(false);
    expect(out.byAssistant.map((a) => [a.assistant, a.tasks])).toEqual([['owner', 1], ['finance', 1]]);
    expect(out.totals).toMatchObject({ tasks: 2, failed: 1, inputTokens: 200 });
    const many = Array.from({ length: 200 }, () => reportRow());
    expect(((await createReadTools(setup({ reports: many }).ctx, 'manager').usage_summary!.run({ sinceHours: 24 })) as { truncated: boolean }).truncated).toBe(true);
  });

  it('reads lessons, open items, the proposal and the timeline from their sources', async () => {
    const tools = createReadTools(setup().ctx, 'owner');
    expect(await tools.list_lessons!.run({ assistant: 'finance' })).toEqual({
      lessons: [{ assistant: 'finance', text: 'Give each stop-loss a lever.', adoptedAt: '2026-10-26T10:00:00.000Z' }],
    });
    expect(await tools.open_items!.run({})).toEqual({
      byAssistant: [{ assistant: 'owner', openTasks: 2, pendingApprovals: 1 }, { assistant: 'manager', openTasks: 0, pendingApprovals: 0 }],
    });
    expect(await tools.latest_proposal!.run({})).toEqual({ proposal: null });
    expect(await tools.get_timeline!.run({ limit: 5 })).toEqual({ events: [{ id: 'e1', type: 'relate', at: '2026-10-26T11:00:00Z' }] });
  });
});

describe('pick', () => {
  it('returns the allowed tools in the order asked, and throws on a name that does not exist', () => {
    const tools = createReadTools(setup().ctx, 'owner');
    expect(pick(tools, ['usage_summary', 'open_items']).map((t) => t.name)).toEqual(['usage_summary', 'open_items']);
    expect(pick(tools, [])).toEqual([]);
    expect(() => pick(tools, ['open_items', 'send_everything'])).toThrow(/Unknown read tool "send_everything"/);
  });
});
