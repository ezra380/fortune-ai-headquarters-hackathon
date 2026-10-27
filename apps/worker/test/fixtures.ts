import type { CodeModeResult, CodeModeRunner, DataPort, Metric, ModelPort } from '@fahq/contracts';

// MOCKS for worker tests only: they stand in for lane B's Zetaris adapter and for NVIDIA.

const source = { system: 'zetaris' as const, view: 'fortune_demo_finance_mart', queryHash: 'c'.repeat(64), asOf: '2026-10-26T12:00:00Z' };

export const mockMetrics: Metric[] = [
  { id: 'm:online.revenue.mazali', label: 'Online Mazali revenue', value: 12400, unit: 'usd', business: 'online', period: '2026-09', source },
  { id: 'm:online.ads.google.spend', label: 'Google ad spend', value: 1800, unit: 'usd', business: 'online', period: '2026-09', source },
  { id: 'm:online.ads.google.roas', label: 'Google ad return', value: 2.4, unit: 'ratio', business: 'online', period: '2026-09', source },
  { id: 'm:salon.revenue.wash_set', label: 'Salon wash and set revenue', value: 6200, unit: 'usd', business: 'salon', period: '2026-09', source },
  { id: 'm:salon.appointments.count', label: 'Salon appointments', value: 310, unit: 'count', business: 'salon', period: '2026-09', source },
];

export const dataMock: DataPort = {
  health: async () => ({ ok: true, detail: 'MOCK data' }),
  getFinanceMetrics: async () => ({ metrics: mockMetrics, queryHash: source.queryHash, view: source.view }),
};

export const validPlans = {
  plans: [
    {
      rank: 1,
      title: 'Push Google ads on Mazali',
      summary: 'Mazali brought in $12,400 last month; raise Google spend 20% while ads return 2.4x.',
      actions: ['Raise the Mazali Google budget by 20%'],
      evidence: [{ metricId: 'm:online.revenue.mazali', value: 12400 }, { metricId: 'm:online.ads.google.roas', value: 2.4 }],
      projections: [{ label: 'Google spend after the raise', baseMetricId: 'm:online.ads.google.spend', factor: 1.2, result: 2160, assumption: 'Budget raised 20%' }],
      test: 'Run 14 days on Mazali only.',
      stopLoss: 'Stop if spend passes $2,160 without new orders.',
      businesses: ['online'],
      risks: ['Ad costs rise'],
    },
    {
      rank: 2,
      title: 'Evening wash and set slots',
      summary: 'Wash and set brought $6,200; add evening slots to grow it 15%.',
      actions: ['Open two evening slots a week'],
      evidence: [{ metricId: 'm:salon.revenue.wash_set', value: 6200 }],
      projections: [{ label: 'Wash and set revenue', baseMetricId: 'm:salon.revenue.wash_set', factor: 1.15, result: 7130, assumption: 'Evening demand' }],
      test: 'Try evenings for 4 weeks.',
      stopLoss: 'Stop if fewer than 6 evening bookings a week.',
      businesses: ['salon'],
      risks: ['Staff hours'],
    },
    {
      rank: 3,
      title: 'Mazali buyers get a wash and set',
      summary: 'Offer each Mazali buyer a wash and set booking.',
      actions: ['Add a booking link to Mazali order emails'],
      evidence: [{ metricId: 'm:online.revenue.mazali', value: 12400 }, { metricId: 'm:salon.revenue.wash_set', value: 6200 }],
      projections: [{ label: 'Mazali revenue', baseMetricId: 'm:online.revenue.mazali', factor: 1.05, result: 13020, assumption: 'Small lift from the offer' }],
      test: 'Offer it for 30 days.',
      stopLoss: 'Stop if no buyer books within 30 days.',
      businesses: ['online', 'salon'],
      risks: ['Salon capacity'],
    },
  ],
  memoryConflicts: [],
};

export function modelMock(planReplies: string[] = [JSON.stringify(validPlans)]): ModelPort & { calls: string[]; inputs: { purpose: string; system: string; user: string }[] } {
  const calls: string[] = [];
  const inputs: { purpose: string; system: string; user: string }[] = [];
  let planIndex = 0;
  return {
    calls,
    inputs,
    async chat(input) {
      calls.push(input.purpose);
      inputs.push({ purpose: input.purpose, system: input.system, user: input.user });
      const text = input.purpose === 'front-door'
        ? JSON.stringify({ intent: 'plans', risks: ['money', 'ads'], targetAssistant: 'finance', confidence: 0.92, reason: 'profit plans' })
        : planReplies[Math.min(planIndex++, planReplies.length - 1)] ?? '';
      return { text, model: `MOCK/${input.model}`, inputTokens: 100, outputTokens: 200, costUsd: 0 };
    },
  };
}

// ---- Per-department plans: each cites only its own business's metrics (they pass checkPlans on that slice) ----

const planOf = (rank: number, over: Record<string, any>): Record<string, any> => ({ rank, actions: ['Do it for a short trial'], risks: ['It may not work'], ...over });

export const onlinePlans = {
  plans: [
    planOf(1, {
      title: 'Raise Google ad spend 20%',
      summary: 'Google ads return 2.4x on $1,800 of spend; a 20% raise makes it $2,160.',
      evidence: [{ metricId: 'm:online.ads.google.spend', value: 1800 }, { metricId: 'm:online.ads.google.roas', value: 2.4 }],
      projections: [{ label: 'Google spend after the raise', baseMetricId: 'm:online.ads.google.spend', factor: 1.2, result: 2160, assumption: 'Budget raised 20%' }],
      test: 'Run 14 days.', stopLoss: 'Stop if spend passes $2,160 without new orders.', businesses: ['online'],
    }),
    planOf(2, {
      title: 'Email Mazali buyers a restock note',
      summary: 'Mazali brought in $12,400; a 5% lift would make it $13,020.',
      evidence: [{ metricId: 'm:online.revenue.mazali', value: 12400 }],
      projections: [{ label: 'Mazali revenue with the email', baseMetricId: 'm:online.revenue.mazali', factor: 1.05, result: 13020, assumption: 'A small lift from one email' }],
      test: 'Send once and compare orders for 7 days.', stopLoss: 'Stop if orders do not rise within 7 days.', businesses: ['online'],
    }),
    planOf(3, {
      title: 'Hold Google spend and test new ads',
      summary: 'Keep spend at $1,800 and test new ads to lift the 2.4x return by 10%.',
      evidence: [{ metricId: 'm:online.ads.google.spend', value: 1800 }, { metricId: 'm:online.ads.google.roas', value: 2.4 }],
      projections: [{ label: 'Google return with new ads', baseMetricId: 'm:online.ads.google.roas', factor: 1.1, result: 2.64, assumption: 'New creative lifts the return 10%' }],
      test: 'Test two new ads for 14 days.', stopLoss: 'Stop if the return falls below the current level.', businesses: ['online'],
    }),
  ],
  memoryConflicts: [],
};

export const salonPlans = {
  plans: [
    planOf(1, {
      title: 'Open evening wash and set slots',
      summary: 'Wash and set brought $6,200; a 15% lift from evening slots makes it $7,130.',
      evidence: [{ metricId: 'm:salon.revenue.wash_set', value: 6200 }],
      projections: [{ label: 'Wash and set revenue with evenings', baseMetricId: 'm:salon.revenue.wash_set', factor: 1.15, result: 7130, assumption: 'Evening demand' }],
      test: 'Try evenings for 4 weeks.', stopLoss: 'Stop if fewer than 6 evening bookings a week.', businesses: ['salon'],
    }),
    planOf(2, {
      title: 'Fill the quiet weekday gaps',
      summary: 'The salon booked 310 appointments; a 10% rise would be 341.',
      evidence: [{ metricId: 'm:salon.appointments.count', value: 310 }],
      projections: [{ label: 'Appointments with weekday offers', baseMetricId: 'm:salon.appointments.count', factor: 1.1, result: 341, assumption: 'Weekday offers fill gaps' }],
      test: 'Offer it for 4 weeks.', stopLoss: 'Stop if weekday bookings do not rise.', businesses: ['salon'],
    }),
    planOf(3, {
      title: 'Text appointment reminders',
      summary: 'Texting reminders could lift the 310 appointments, a 20% rise that makes it 372.',
      evidence: [{ metricId: 'm:salon.appointments.count', value: 310 }],
      projections: [{ label: 'Appointments with reminders', baseMetricId: 'm:salon.appointments.count', factor: 1.2, result: 372, assumption: 'Fewer no-shows' }],
      test: 'Send reminders for 4 weeks.', stopLoss: 'Stop if no-shows do not fall.', businesses: ['salon'],
    }),
  ],
  memoryConflicts: [],
};

// ---- Code Mode, faked: what the runner would return for a script (the sandbox itself has its own tests) ----

export const okResult = (result: unknown, over: Partial<CodeModeResult> = {}): CodeModeResult => ({
  ok: true, result, error: null, script: 'return 1;', attempts: 1, toolCalls: 3, resultChars: JSON.stringify(result).length,
  inputTokens: 700, outputTokens: 150, model: 'MOCK/code', toolOutputs: [{ tool: 'usage_summary', output: result }], ...over,
});

export function fakeCodeMode() {
  const calls: Parameters<CodeModeRunner>[0][] = [];
  let respond: (input: Parameters<CodeModeRunner>[0]) => CodeModeResult = () => { throw new Error('no scripted Code Mode result'); };
  const runner: CodeModeRunner = async (input) => { calls.push(input); return respond(input); };
  return { runner, calls, respond: (fn: typeof respond) => { respond = fn; } };
}

// ---- A model scripted per purpose (the last reply repeats; an Error is thrown) ----------------------------

export const SAFE = 'User Safety: safe';
export const UNSAFE = '{"User Safety": "unsafe", "Safety Categories": "Criminal Planning/Confessions, Fraud/Deception"}';

export const routerReply = (target: string, intent = 'question', risks: string[] = []) =>
  JSON.stringify({ intent, risks, targetAssistant: target, confidence: 0.9, reason: 'scripted' });

export function scriptedModel(initial: Record<string, string | Error> = {}) {
  const replies = new Map<string, (string | Error)[]>(Object.entries(initial).map(([k, v]) => [k, [v]]));
  const calls: Parameters<ModelPort['chat']>[0][] = [];
  const port: ModelPort = {
    async chat(input) {
      calls.push(input);
      const list = replies.get(input.purpose);
      const next = list && list.length > 1 ? list.shift() : list?.[0];
      if (next === undefined) throw new Error(`no scripted reply for ${input.purpose}`);
      if (next instanceof Error) throw next;
      return { text: next, model: `MOCK/${input.model}`, inputTokens: 100, outputTokens: 200, costUsd: 0 };
    },
  };
  return {
    port, calls,
    script: (purpose: string, ...texts: (string | Error)[]) => { replies.set(purpose, texts); },
    of: (purpose: string) => calls.filter((c) => c.purpose === purpose),
  };
}
