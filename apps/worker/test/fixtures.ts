import type { DataPort, Metric, ModelPort } from '@fahq/contracts';

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
