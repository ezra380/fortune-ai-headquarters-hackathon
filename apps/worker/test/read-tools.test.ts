import { describe, expect, it } from 'vitest';
import type { AssistantId } from '@fahq/contracts';
import { createReadTools, pick, type ReadToolContext } from '../src/read-tools.ts';
import type { Explained } from '../src/explain.ts';
import type { ApprovalSummary, MessageRow, SessionReportRow, WorkReportRow } from '../src/store.ts';
import { dataMock, mockMetrics } from './fixtures.ts';

// FAKES: an in-memory store, brain and data port, to pin down what each read tool returns and refuses.

const NOW = new Date('2026-10-26T12:00:00.000Z');
const NAMES = [
  'get_finance_metrics', 'get_online_metrics', 'get_salon_metrics', 'recall_my_decisions', 'recall_decisions', 'my_lessons', 'list_lessons',
  'get_timeline', 'list_work_reports', 'list_session_reports', 'usage_summary', 'open_items', 'latest_proposal', 'explain_proposal',
];

const FINAL_ID = 'abcdef12-3456-4789-8abc-def012345678';
const finalRow: MessageRow = {
  id: FINAL_ID, from_assistant: 'owner', to_assistant: 'owner', kind: 'proposal', status: 'open', reply_to: null, created_at: '2026-10-26T11:30:00.000Z',
  body: {
    plans: { plans: [
      { rank: 1, title: 'Push Google ads on Mazali', evidence: [{ metricId: 'm:online.revenue.mazali' }, { metricId: 'm:online.ads.google.roas' }], projections: [{ baseMetricId: 'm:online.ads.google.spend' }] },
      { rank: 2, title: 'Evening wash and set slots', evidence: [{ metricId: 'm:salon.revenue.wash_set' }], projections: [{ baseMetricId: 'm:salon.revenue.wash_set' }] },
      { rank: 3, title: 'Keep the budget steady', evidence: [{ metricId: 'm:online.ads.google.spend' }], projections: [] },
    ], memoryConflicts: [] },
    metrics: mockMetrics.filter((m) => m.id !== 'm:salon.appointments.count'),
    origins: [
      { rank: 1, department: 'online', originalRank: 1, proposalId: 'p-online' },
      { rank: 2, department: 'salon', originalRank: 1, proposalId: 'p-salon' },
      { rank: 3, department: 'finance', originalRank: 3, proposalId: 'p-finance' },
    ],
    why: [{ rank: 1, text: 'Ads return 2.4x.' }, { rank: 2, text: 'Evenings are untouched.' }],
    pickedBy: 'model', view: 'fortune_demo_finance_mart', queryHash: 'c'.repeat(64), requestText: 'Three plans to grow profit', failedDepartments: [],
  },
};
const trail = {
  proposal: { id: FINAL_ID, titles: ['Push Google ads on Mazali'], dataSource: 'zetaris:ccc' },
  request: { text: 'Three plans to grow profit', from: 'owner', askedBy: 'Demo Owner', at: '2026-10-26T11:00:00Z' },
  cites: ['m:online.ads.google.roas', 'm:online.ads.google.spend', 'm:online.revenue.mazali', 'm:salon.revenue.wash_set'],
  decisions: [{ by: 'Demo Owner', action: 'forwarded' as const, planRank: 2, at: '2026-10-26T11:40:00Z' }],
};

function reportRow(over: Partial<WorkReportRow> = {}): WorkReportRow {
  return {
    id: 'r1', task_id: '12345678-1234-4234-8234-123456789abc', run_id: 'run', assistant_id: 'finance', task_kind: 'mailbox', outcome: 'done',
    summary: 'mailbox task done in 9 s; finance.plans ok (attempt 1 of 2)', steps: [], usage: { modelCalls: 1, inputTokens: 100, outputTokens: 200 },
    suggestions: [{ kind: 'speed', about: 'finance', text: 'finance.plans took 75 s' }],
    input_tokens: 100, output_tokens: 200, model_calls: 1,
    started_at: '2026-10-26T11:00:00.000Z', ended_at: '2026-10-26T11:00:09.500Z', ...over,
  };
}

function sessionRow(over: Partial<SessionReportRow> = {}): SessionReportRow {
  return {
    id: '9d3b1c52-6f0e-4a8a-9b7c-2f1d5e8a4b10', assistant_id: 'finance', tool: 'claude-code', summary: 'Checked the finance numbers for September.',
    steps: [{ step: 'Read the metrics' }], suggestions: [{ text: 'Name the period in every answer' }], lessons: [{ text: 'Ask which month first' }],
    created_at: '2026-10-26T10:00:00.000Z', reviewed_at: null, ...over,
  };
}

type SetupOptions = {
  sessions?: SessionReportRow[];
  reports?: WorkReportRow[];
  data?: ReadToolContext['data'];
  final?: MessageRow | null;
  byPrefix?: (prefix: string) => { proposal: MessageRow | null; ambiguous: boolean };
  approvals?: ApprovalSummary[];
  trail?: typeof trail | null;
};

function setup(over: SetupOptions = {}) {
  const calls = {
    sessions: [] as { since?: Date; assistant?: AssistantId; unreviewedOnly?: boolean; limit?: number }[],
    reports: [] as { since: Date; assistant?: AssistantId; limit?: number }[],
    lessons: [] as { assistant?: AssistantId; limit?: number }[],
    recall: [] as { assistant: AssistantId; query: string; topN: number }[],
    timeline: [] as number[],
    memoryOf: [] as AssistantId[],
  };
  const ctx: ReadToolContext = {
    store: {
      workReports: async (q) => { calls.reports.push(q); return over.reports ?? [reportRow()]; },
      sessionReports: async (q = {}) => { calls.sessions.push(q); return over.sessions ?? [sessionRow()]; },
      adoptedLessons: async (assistant, limit) => {
        calls.lessons.push({ assistant, limit });
        return [{ id: 'l1', review_id: 'rv', assistant_id: 'finance', change: 'Give each stop-loss a lever.', decided_at: '2026-10-26T10:00:00Z' }];
      },
      openItems: async () => [{ assistant: 'owner', openTasks: 2, pendingApprovals: 1 }, { assistant: 'manager', openTasks: 0, pendingApprovals: 0 }],
      latestProposal: async () => null,
      latestFinalProposal: async () => ('final' in over ? over.final! : finalRow),
      proposalByPrefix: async (prefix: string) => (over.byPrefix ? over.byPrefix(prefix) : { proposal: finalRow.id.startsWith(prefix) ? finalRow : null, ambiguous: false }),
      approvalsOf: async () => over.approvals ?? [],
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
      record: {
        timeline: (limit: number) => { calls.timeline.push(limit); return [{ id: 'e1', type: 'relate', at: '2026-10-26T11:00:00Z' }]; },
        explainProposal: () => (over.trail === undefined ? trail : over.trail ?? { proposal: null, request: null, cites: [], decisions: [] }),
      },
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

  type Keyed = { view: string; queryHash: string; metrics: Record<string, { label: string; value: number; unit: string; business: string }> };

  it('returns metrics keyed by id with their business label, and only online ones from get_online_metrics', async () => {
    const tools = createReadTools(setup().ctx, 'finance');
    const all = (await tools.get_finance_metrics!.run({ period: '2026-09' })) as Keyed;
    expect(all.view).toBe('fortune_demo_finance_mart');
    expect(all.queryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(all.metrics)).toEqual(mockMetrics.map((m) => m.id));
    expect(all.metrics['m:online.ads.google.spend']).toEqual({ label: 'Google ad spend', value: 1800, unit: 'usd', business: 'online' });
    expect(new Set(Object.values(all.metrics).map((m) => m.business))).toEqual(new Set(['online', 'salon']));
    const online = (await tools.get_online_metrics!.run({ period: '2026-09' })) as Keyed;
    expect(Object.keys(online.metrics).length).toBeGreaterThan(0);
    expect(Object.values(online.metrics).every((m) => m.business === 'online')).toBe(true);
  });

  it('gives the salon its own metrics only: no online and no combined metric', async () => {
    const tools = createReadTools(setup().ctx, 'salon');
    const salon = (await tools.get_salon_metrics!.run({ period: '2026-09' })) as Keyed;
    expect(salon.view).toBe('fortune_demo_finance_mart');
    expect(Object.keys(salon.metrics)).toEqual(['m:salon.revenue.wash_set', 'm:salon.appointments.count']);
    expect(Object.values(salon.metrics).every((m) => m.business === 'salon')).toBe(true);
    await expect(tools.get_salon_metrics!.run({ period: '2026-08' })).rejects.toThrow(/argument "period"/);
  });

  it('names the exact metric ids in each metric tool, only the ones that tool returns', () => {
    const catalog = mockMetrics.map(({ id, label, unit, business }) => ({ id, label, unit, business }));
    const tools = createReadTools(setup({ data: { ...dataMock, catalog } }).ctx, 'owner');
    expect(tools.get_finance_metrics!.description).toContain('Read one as metrics["<id>"]. Metric ids: m:online.revenue.mazali (Online Mazali revenue, usd); m:online.ads.google.spend (Google ad spend, usd);');
    expect(tools.get_finance_metrics!.description).toContain('m:salon.appointments.count (Salon appointments, count).');
    expect(tools.get_online_metrics!.description).toContain('m:online.ads.google.roas (Google ad return, ratio)');
    expect(tools.get_online_metrics!.description).not.toContain('m:salon.');
    expect(tools.get_salon_metrics!.description).toContain('m:salon.revenue.wash_set (Salon wash and set revenue, usd)');
    expect(tools.get_salon_metrics!.description).not.toContain('m:online.');
    // A port without a catalog keeps the plain description.
    expect(createReadTools(setup().ctx, 'owner').get_finance_metrics!.description).not.toContain('Metric ids');
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

  it('lists what outside tools filed: the report, its lists, and whether a review read it', async () => {
    const { ctx, calls } = setup({ sessions: [sessionRow(), sessionRow({ id: 'second', reviewed_at: '2026-10-26T11:00:00.000Z' })] });
    const out = (await createReadTools(ctx, 'manager').list_session_reports!.run({ sinceHours: 24, assistant: 'finance' })) as { reports: Record<string, unknown>[] };
    expect(out.reports).toEqual([
      {
        id: '9d3b1c52-6f0e-4a8a-9b7c-2f1d5e8a4b10', assistant: 'finance', tool: 'claude-code', at: '2026-10-26T10:00:00.000Z', reviewed: false,
        summary: 'Checked the finance numbers for September.', steps: ['Read the metrics'], suggestions: ['Name the period in every answer'], lessons: ['Ask which month first'],
      },
      expect.objectContaining({ id: 'second', reviewed: true }),
    ]);
    expect(calls.sessions).toHaveLength(1);
    expect(calls.sessions[0]).toMatchObject({ assistant: 'finance', unreviewedOnly: false, limit: 25 });
    expect(NOW.getTime() - calls.sessions[0]!.since!.getTime()).toBe(24 * 3_600_000);
  });

  it('asks only for reports nobody read when told to, however old they are, and clamps the limit and the window', async () => {
    const { ctx, calls } = setup();
    const tool = createReadTools(ctx, 'manager').list_session_reports!;
    await tool.run({ sinceHours: 1, onlyNew: true, limit: 5000 });
    await tool.run({ sinceHours: 24 * 365, onlyNew: false });
    expect(calls.sessions[0]).toMatchObject({ unreviewedOnly: true, limit: 50 });
    expect(NOW.getTime() - calls.sessions[0]!.since!.getTime()).toBe(30 * 24 * 3_600_000);
    expect(calls.sessions[1]).toMatchObject({ unreviewedOnly: false });
    expect(NOW.getTime() - calls.sessions[1]!.since!.getTime()).toBe(30 * 24 * 3_600_000);
  });

  it('cuts a long report down and never returns a phone number or a code from one', async () => {
    const long = sessionRow({ summary: `${'word '.repeat(200)}ends here`, steps: [{ step: 'a'.repeat(80) }], suggestions: [{ text: 'Text +15551234567 and reply SEND 2 482913 to approve' }] });
    const text = JSON.stringify(await createReadTools(setup({ sessions: [long] }).ctx, 'manager').list_session_reports!.run({ sinceHours: 24 }));
    const parsed = JSON.parse(text) as { reports: { summary: string }[] };
    expect(parsed.reports[0]!.summary.length).toBeLessThanOrEqual(600);
    expect(parsed.reports[0]!.summary.endsWith('…')).toBe(true);
    expect(text).not.toMatch(/\+1\d{10}/);
    expect(text).not.toContain('482913');
  });

  it('checks the arguments of the session reader with plain sentences', async () => {
    const tool = createReadTools(setup().ctx, 'manager').list_session_reports!;
    await expect(tool.run({})).rejects.toThrow(/argument "sinceHours"/);
    await expect(tool.run({ sinceHours: 24, onlyNew: 'yes' })).rejects.toThrow(/argument "onlyNew"/);
    await expect(tool.run({ sinceHours: 24, token: 'x' })).rejects.toThrow(/has a name this function does not take \("token"\)/);
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

describe('explain_proposal', () => {
  const explain = async (args: unknown, over: SetupOptions = {}) =>
    (await createReadTools(setup(over).ctx, 'owner').explain_proposal!.run(args)) as Explained;

  it('explains the newest set of plans: where each came from, why, what it cited with values, and who decided', async () => {
    const out = await explain({}, { approvals: [
      { action: 'forward_plan', status: 'signed', planRank: null, expiresAt: '2026-10-26T11:45:00.000Z', decidedAt: '2026-10-26T11:40:00.000Z' },
      { action: 'decide_plan', status: 'pending', planRank: 2, expiresAt: '2026-10-26T11:55:00.000Z', decidedAt: null },
      { action: 'decide_plan', status: 'pending', planRank: 1, expiresAt: '2026-10-26T12:30:00.000Z', decidedAt: null },
    ] });
    expect(out.proposal).toEqual({
      id: 'abcdef12', createdAt: '2026-10-26T11:30:00.000Z', from: 'owner', requestText: 'Three plans to grow profit',
      view: 'fortune_demo_finance_mart', queryHash: 'c'.repeat(64), pickedBy: 'model', failedDepartments: [],
    });
    expect(out.plans).toEqual([
      { rank: 1, title: 'Push Google ads on Mazali', department: 'online', originalRank: 1, why: 'Ads return 2.4x.', cites: ['m:online.revenue.mazali', 'm:online.ads.google.roas', 'm:online.ads.google.spend'] },
      { rank: 2, title: 'Evening wash and set slots', department: 'salon', originalRank: 1, why: 'Evenings are untouched.', cites: ['m:salon.revenue.wash_set'] },
      { rank: 3, title: 'Keep the budget steady', department: 'finance', originalRank: 3, why: null, cites: ['m:online.ads.google.spend'] },
    ]);
    expect(out.cited).toContainEqual({ id: 'm:online.ads.google.roas', label: 'Google ad return', value: 2.4, unit: 'ratio', business: 'online' });
    expect(out.cited.map((m) => m.id)).not.toContain('m:salon.appointments.count');
    // The expired pending approval says so; the open one stays pending; no code or hash is in the answer.
    expect(out.approvals.map((a) => [a.action, a.status, a.planRank])).toEqual([['forward_plan', 'signed', null], ['decide_plan', 'expired', 2], ['decide_plan', 'pending', 1]]);
    expect(out.decisions).toEqual(trail.decisions);
    expect(out.record).toEqual({ askedBy: 'Demo Owner', request: { text: 'Three plans to grow profit', from: 'owner', at: '2026-10-26T11:00:00Z' }, cites: trail.cites });
    expect(out.notes).toEqual([]);
    expect(JSON.stringify(out)).not.toMatch(/code_hash|\b\d{6}\b/);
  });

  it('finds a proposal by its first 8 characters or its whole id, and says when there is none or more than one', async () => {
    expect((await explain({ proposal: 'abcdef12' })).proposal?.id).toBe('abcdef12');
    expect((await explain({ proposal: FINAL_ID.toUpperCase() })).proposal?.id).toBe('abcdef12');
    expect((await explain({ proposal: '00000000' })).notes).toEqual(['No proposal starts with "00000000".']);
    expect((await explain({}, { final: null })).notes).toEqual(['No proposal has been made yet.']);
    const ambiguous = await explain({ proposal: 'abcdef12' }, { byPrefix: () => ({ proposal: null, ambiguous: true }) });
    expect(ambiguous).toMatchObject({ proposal: null, notes: ['More than one proposal starts with "abcdef12"; give more characters.'] });
  });

  it('reports a gap in the shared record as a gap, and never fills it', async () => {
    const out = await explain({}, { trail: null });
    expect(out.record).toBeNull();
    expect(out.decisions).toEqual([]);
    expect(out.notes).toEqual(['The shared record has no entry for this proposal.']);
    const thin = await explain({}, { trail: { ...trail, cites: ['m:online.revenue.mazali'] } });
    expect(thin.notes).toEqual(['The shared record lists fewer cited metrics than the proposal holds (an older record can lose links).']);
  });

  it("explains a department's own proposal, and an older finance-only one, by the department that wrote them", async () => {
    const department: MessageRow = { ...finalRow, from_assistant: 'salon', to_assistant: 'owner', body: { ...finalRow.body, origins: undefined, why: undefined, pickedBy: undefined, department: 'salon' } };
    const out = await explain({ proposal: 'abcdef12' }, { byPrefix: () => ({ proposal: department, ambiguous: false }) });
    expect(out.plans.map((p) => [p.department, p.originalRank, p.why])).toEqual([['salon', 1, null], ['salon', 2, null], ['salon', 3, null]]);
    expect(out.proposal?.pickedBy).toBeNull();
    const older: MessageRow = { ...finalRow, from_assistant: 'finance', body: { ...department.body, department: undefined } };
    expect((await explain({}, { final: older })).plans.map((p) => p.department)).toEqual(['finance', 'finance', 'finance']);
  });

  it('refuses a reference that is not a proposal id, with a plain sentence', async () => {
    const tools = createReadTools(setup().ctx, 'owner');
    await expect(tools.explain_proposal!.run({ proposal: "x'; drop table" })).rejects.toThrow(/^explain_proposal: argument "proposal"/);
    await expect(tools.explain_proposal!.run({ proposal: 'abc' })).rejects.toThrow(/argument "proposal"/);
    await expect(tools.explain_proposal!.run({ proposals: 'abcdef12' })).rejects.toThrow(/does not take/);
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
