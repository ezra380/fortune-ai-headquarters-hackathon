import { describe, expect, it } from 'vitest';
import { checkPlans, Metric, numbersIn } from '../src/index.ts';

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

  // Each of these forms used to produce no number at all, so an invented figure passed unseen.
  it.each([
    ['45 percent', 45, 'percent'], ['45 per cent', 45, 'percent'], ['30 pct', 30, 'percent'], ['４５％', 45, 'percent'],
    ['50 dollars', 50, 'usd'], ['12 million', 12e6, 'plain'], ['1.2M', 1.2e6, 'plain'], ['$12.4M', 12.4e6, 'usd'],
    ['45 thousand dollars', 45000, 'usd'], ['45 000', 45000, 'plain'], ['45 000', 45000, 'plain'], ['45​000', 45000, 'plain'],
    ['35% year-over-year', 35, 'percent'], ['$45,000 year-one', 45000, 'usd'], ['2,000 new customers', 2000, 'plain'],
    ['2k customers', 2000, 'plain'], ['net was -$3,000', -3000, 'usd'], ['net was $-3,000', -3000, 'usd'], ['2.4x return', 2.4, 'ratio'],
  ])('reads "%s"', (text, value, kind) => {
    const found = numbersIn(text);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ value, kind });
  });

  it('reads both ends of a range, with shared units', () => {
    expect(numbersIn('expect a 10-20% lift').map((n) => [n.value, n.kind])).toEqual([[10, 'percent'], [20, 'percent']]);
    expect(numbersIn('an add-on at $200-300').map((n) => [n.value, n.kind])).toEqual([[200, 'usd'], [300, 'usd']]);
    expect(numbersIn('1,000-2,000 visits').map((n) => n.value)).toEqual([1000, 2000]);
  });
});

describe('checkPlans against invented numbers (adversarial review, 2026-10-26)', () => {
  const withPlan1 = (overrides: Record<string, unknown>) => ({ ...good, plans: [plan(1, overrides), plan(2), plan(3)] });
  const rejects = (raw: unknown, fragment: string) => {
    const result = checkPlans(raw, metrics);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join('\n')).toContain(fragment);
  };
  const projection = { label: 'Ad spend after the raise', baseMetricId: 'm:online.ads.spend', factor: 1.2, result: 2160, assumption: 'Budget raised 20%' };

  it('scans projection labels and assumptions, evidence notes, lever labels and memory notes', () => {
    rejects(withPlan1({ projections: [{ ...projection, label: 'Profit doubles to $99,999 by Q1' }] }), '$99,999');
    rejects(withPlan1({ projections: [{ ...projection, assumption: 'Assumes $250,000 lifetime value and 87% repeat rate' }] }), '$250,000');
    rejects(withPlan1({ evidence: [{ metricId: 'm:online.revenue.mazali', value: 12400, note: 'Last year this was $310,000' }, { metricId: 'm:online.ads.roas', value: 2.4 }] }), '$310,000');
    rejects({ ...good, memoryConflicts: [{ memoryId: 'mem-1', note: 'It earned $500,000 before' }] }, '$500,000');
  });

  it('checks both ends of a range and dollar or percent claims next to a time word', () => {
    rejects(withPlan1({ summary: 'Expect a 10-20% lift on Mazali.' }), '10');
    rejects(withPlan1({ summary: 'Expect $45,000 year-one profit.' }), '$45,000');
    rejects(withPlan1({ summary: 'Mazali grows 35% year-over-year.' }), '35%');
    rejects(withPlan1({ summary: 'This brings 2,000 new customers.' }), '2,000');
  });

  it('refuses numbers in words', () => {
    rejects(withPlan1({ summary: 'This adds twelve thousand dollars of profit.' }), 'cannot read');
  });

  it('matches by unit: a ratio or a count never backs a dollar claim', () => {
    rejects(withPlan1({ summary: 'Mazali made $12,400; this adds $2.4 million in profit.' }), '$2.4 million');
    const counted = [...metrics, { ...metrics[0]!, id: 'm:online.orders.count', label: 'Orders', value: 400, unit: 'count' as const }];
    const r = checkPlans(withPlan1({ evidence: [{ metricId: 'm:online.revenue.mazali', value: 12400 }, { metricId: 'm:online.orders.count', value: 400 }], summary: 'Mazali made $12,400 across 400 orders; each order nets $400 more.' }), counted);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toContain('$400');
  });

  it('refuses a lever that is a result, or a salon + online sum dressed as a lever', () => {
    rejects(withPlan1({ levers: [{ label: 'Expected extra profit', value: 45000, unit: 'usd' }], summary: 'This adds $45,000 in profit.' }), 'reads as a result');
    // A bidding target is a setting (Nemotron proposed exactly this live).
    expect(checkPlans(withPlan1({ levers: [{ label: 'Target Google ROAS', value: 3, unit: 'ratio' }], test: 'Bid to a 3x target for 14 days.' }), metrics).ok).toBe(true);
    const both = withPlan1({
      evidence: [{ metricId: 'm:online.revenue.mazali', value: 12400 }, { metricId: 'm:salon.revenue.wash_set', value: 6200 }],
      businesses: ['online', 'salon'],
      levers: [{ label: 'Shared budget', value: 18600, unit: 'usd' }],
      summary: 'Combined, the two businesses made $18,600.',
    });
    rejects(both, 'sum or difference');
  });

  it('refuses one sentence that mixes salon and online numbers', () => {
    rejects(withPlan1({
      evidence: [{ metricId: 'm:online.revenue.mazali', value: 12400 }, { metricId: 'm:salon.revenue.wash_set', value: 6200 }],
      businesses: ['online', 'salon'],
      summary: 'The salon made $6,200 and Mazali online $12,400 last month.',
    }), 'mixes salon and online');
  });

  it('holds projection arithmetic and evidence close to exact', () => {
    rejects(withPlan1({ projections: [{ ...projection, result: 2181 }], stopLoss: 'Stop at $2,181.' }), '× 1.2 = 2160');
    rejects(withPlan1({ evidence: [{ metricId: 'm:online.revenue.mazali', value: 12450 }, { metricId: 'm:online.ads.roas', value: 2.4 }] }), 'says 12450');
  });

  it('lets a negative metric be quoted as a loss', () => {
    const loss = [...metrics, { ...metrics[0]!, id: 'm:online.net.accessories', label: 'Accessories net', value: -3000, unit: 'usd' as const }];
    const raw = withPlan1({
      evidence: [{ metricId: 'm:online.revenue.mazali', value: 12400 }, { metricId: 'm:online.net.accessories', value: -3000 }],
      summary: 'Mazali made $12,400 while accessories were a loss of $3,000 (net -$3,000).',
    });
    expect(checkPlans(raw, loss).ok).toBe(true);
  });

  it("refuses a metric whose id names a different business than its label", () => {
    expect(() => Metric.parse({ ...metrics[3]!, id: 'm:salon.revenue.wash_set', business: 'online' })).toThrow();
  });
});
