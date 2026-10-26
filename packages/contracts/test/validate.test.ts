import { describe, expect, it } from 'vitest';
import { checkPlans, numbersIn, type Metric } from '../src/index.ts';

const source = {
  system: 'zetaris' as const,
  view: 'fortune_demo.finance_mart',
  queryHash: 'a'.repeat(64),
  asOf: '2026-10-26T12:00:00Z',
};

const metrics: Metric[] = [
  { id: 'm:online.revenue.mazali', label: 'Online Mazali revenue', value: 12400, unit: 'usd', business: 'online', period: '2026-09', source },
  { id: 'm:online.ads.spend', label: 'Online ad spend', value: 1800, unit: 'usd', business: 'online', period: '2026-09', source },
  { id: 'm:online.ads.roas', label: 'Online ad return', value: 2.4, unit: 'ratio', business: 'online', period: '2026-09', source },
  { id: 'm:salon.revenue.wash_set', label: 'Salon wash and set revenue', value: 6200, unit: 'usd', business: 'salon', period: '2026-09', source },
];

function plan(rank: number, overrides: Record<string, unknown> = {}) {
  return {
    rank,
    title: `Plan ${rank}: grow Mazali online`,
    summary: 'Mazali brought in $12,400 last month; raise its ad budget 20% while ads return 2.4×.',
    actions: ['Raise the Mazali campaign budget by 20%', 'Review results after 14 days'],
    evidence: [
      { metricId: 'm:online.revenue.mazali', value: 12400 },
      { metricId: 'm:online.ads.roas', value: 2.4 },
    ],
    projections: [
      { label: 'Ad spend after the raise', baseMetricId: 'm:online.ads.spend', factor: 1.2, result: 2160, assumption: 'Budget raised 20%' },
    ],
    test: 'Run for 14 days on the Mazali campaign only.',
    stopLoss: 'Stop if spend passes $2,160 without new orders.',
    businesses: ['online'],
    risks: ['Ad costs may rise'],
    ...overrides,
  };
}

const good = { plans: [plan(1), plan(2), plan(3)], memoryConflicts: [] };

describe('checkPlans', () => {
  it('accepts plans whose every number traces to a metric or a projection', () => {
    const result = checkPlans(good, metrics);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.citedMetricIds.sort()).toEqual(['m:online.ads.roas', 'm:online.ads.spend', 'm:online.revenue.mazali']);
  });

  it('rejects evidence that disagrees with the source', () => {
    const bad = { ...good, plans: [plan(1, { evidence: [{ metricId: 'm:online.revenue.mazali', value: 15000 }] }), plan(2), plan(3)] };
    const result = checkPlans(bad, metrics);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).toContain('says 15000 but the source says 12400');
  });

  it('rejects a metric that does not exist', () => {
    const bad = { ...good, plans: [plan(1, { evidence: [{ metricId: 'm:online.revenue.invented', value: 1 }] }), plan(2), plan(3)] };
    const result = checkPlans(bad, metrics);
    expect(result.ok).toBe(false);
  });

  it('rejects projection arithmetic that does not add up', () => {
    const wrong = [{ label: 'Spend', baseMetricId: 'm:online.ads.spend', factor: 1.2, result: 3000, assumption: 'x' }];
    const result = checkPlans({ ...good, plans: [plan(1, { projections: wrong }), plan(2), plan(3)] }, metrics);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).toContain('× 1.2 = 2160');
  });

  it('rejects a dollar amount in the text that no source supports', () => {
    const result = checkPlans({ ...good, plans: [plan(1, { summary: 'This adds $45,000 in profit.' }), plan(2), plan(3)] }, metrics);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).toContain('$45,000');
  });

  it('rejects a plan that cites salon numbers without declaring the salon', () => {
    const mixed = plan(1, {
      evidence: [{ metricId: 'm:online.revenue.mazali', value: 12400 }, { metricId: 'm:salon.revenue.wash_set', value: 6200 }],
    });
    const result = checkPlans({ ...good, plans: [mixed, plan(2), plan(3)] }, metrics);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).toContain('does not list "salon"');
  });

  it('allows a proposed price only when it is declared as a lever, never as a fact', () => {
    const withPrice = (levers: unknown[]) => ({ ...good, plans: [plan(1, { actions: ['Charge $10 for a styling add-on'], levers }), plan(2), plan(3)] });
    expect(checkPlans(withPrice([{ label: 'Add-on price', value: 10, unit: 'usd' }]), metrics).ok).toBe(true);
    const undeclared = checkPlans(withPrice([]), metrics);
    expect(undeclared.ok).toBe(false);
    if (!undeclared.ok) expect(undeclared.errors.join('\n')).toContain('$10');
  });

  it('rejects duplicate ranks and malformed output', () => {
    expect(checkPlans({ ...good, plans: [plan(1), plan(1), plan(3)] }, metrics).ok).toBe(false);
    expect(checkPlans({ plans: [] }, metrics).ok).toBe(false);
    expect(checkPlans('not json', metrics).ok).toBe(false);
  });
});

describe('numbersIn', () => {
  it('finds money, percentages and large numbers but not durations, years or small counts', () => {
    const found = numbersIn('Spend $2,160 (up 20%) for 90 days in 2026; email 40 clients; 1,500 visits; $1.2k extra.');
    expect(found.map((n) => n.raw)).toEqual(['$2,160', '20%', '1,500', '$1.2k']);
    expect(found.at(-1)?.value).toBe(1200);
  });
});
