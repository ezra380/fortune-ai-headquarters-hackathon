import { describe, expect, it } from 'vitest';
import { checkPlans, Metric, mixedSentences, numbersIn, Plan } from '../src/index.ts';

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

  // Design 4e: a row id ("demo-rt-01234", "demo-inv-00412") used to read as a claim of 1,234 and fail the plan.
  it('reads the digits of an id after a letter and a hyphen as part of the id, not as an amount', () => {
    expect(numbersIn('Call about ticket demo-rt-01234 and invoice demo-inv-00412 today.')).toEqual([]);
    expect(numbersIn('Chase SUP-2201 first.')).toEqual([]);
    // A minus sign or a range is still read: the hyphen there follows a space or a digit, not a letter.
    expect(numbersIn('net was -$3,000; a 10-20% lift; down -150 units').map((n) => n.value)).toEqual([-3000, 10, 20, -150]);
    expect(numbersIn('ticket demo-rt-01234 owes $1,234').map((n) => n.raw)).toEqual(['$1,234']);
  });

  // Review 2026-10-27: the id rule skipped every figure after a letter and a hyphen, so "a sub-$5,000 test" read nothing.
  it.each([
    ['a mid-$45,000 profit', 45000, 'usd'], ['a sub-$5,000 test', 5000, 'usd'], ['a mid-$40k month', 40000, 'usd'],
    ['a high-35% margin', 35, 'percent'], ['returns in the mid-30% range', 30, 'percent'], ['ROAS-9.5x', 9.5, 'ratio'],
    ['a sub-5,000 budget', 5000, 'plain'], ['the top-100 buyers', 100, 'plain'], ['a demo-rt-1,234 claim', 1234, 'plain'],
  ])('still reads a figure after a word and a hyphen that is not a row id: "%s"', (text, value, kind) => {
    expect(numbersIn(text).map((n) => [n.value, n.kind])).toEqual([[value, kind]]);
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

  it('reads "combined" about levers as fine, and a projection naming both businesses as a blend', () => {
    const p = { label: 'Projected online gross profit', baseMetricId: 'm:online.ads.spend', factor: 1.2, result: 2160, assumption: 'The combined effect of more ads and email' };
    expect(checkPlans(withPlan1({ projections: [p] }), metrics).ok).toBe(true); // live Nemotron wording
    rejects(withPlan1({ projections: [{ ...p, label: 'Salon and online revenue together' }] }), 'reads as a salon + online figure');
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

  it('lets an action name a row by its id: the digits after a letter and a hyphen are not an amount (design 4e)', () => {
    expect(checkPlans(withPlan1({ actions: ['Chase invoice demo-inv-i00412 and ticket demo-rt-01234 first'] }), metrics).ok).toBe(true);
  });

  // Review 2026-10-27: PLAN_SYSTEM rule 2 said a seasonal budget's factor is last year's index, and nothing checked it.
  describe('a seasonal budget (the approved cap × last year\'s index for the month)', () => {
    const budget: Metric[] = [
      ...metrics,
      { ...metrics[1]!, id: 'm:online.budget.google.cap', label: 'Approved Google ad budget', value: 2000 },
      { ...metrics[2]!, id: 'm:online.season.last_year_index', label: 'Online revenue of the same month last year against the average month', value: 1.35 },
    ];
    const seasonal = (factor: number, cite = true, label = 'Google budget for the season') => withPlan1({
      evidence: [{ metricId: 'm:online.revenue.mazali', value: 12400 }, ...(cite ? [{ metricId: 'm:online.season.last_year_index', value: 1.35 }] : [])],
      projections: [{ label, baseMetricId: 'm:online.budget.google.cap', factor, result: 2000 * factor, assumption: 'Spend follows last year' }],
      summary: 'Mazali brought in $12,400 last month.', actions: ['Set the Google cap to the seasonal budget'], stopLoss: 'Stop if orders fall.',
    });
    const errorsOf = (raw: unknown) => { const r = checkPlans(raw, budget); return r.ok ? [] : r.errors; };

    it("accepts the cap times the index, and refuses any other factor once the plan cites the index", () => {
      expect(errorsOf(seasonal(1.35))).toEqual([]);
      expect(errorsOf(seasonal(1.5))).toEqual([
        'plan 1: projection "Google budget for the season" multiplies m:online.budget.google.cap by 1.5, but a seasonal budget\'s factor is m:online.season.last_year_index (1.35)',
      ]);
      expect(errorsOf(seasonal(1.5, true, 'Google cap after a raise'))[0]).toContain("a seasonal budget's factor is m:online.season.last_year_index (1.35)");
    });

    it('refuses a cap projection that names the season without citing the index, and leaves a plain raise alone', () => {
      expect(errorsOf(seasonal(1.35, false))).toEqual([
        'plan 1: projection "Google budget for the season" is a seasonal budget, so cite m:online.season.last_year_index and use its value as the factor',
      ]);
      expect(errorsOf(seasonal(1.2, false, 'Google cap after a raise'))).toEqual([]);
    });

    it('checks an index written as a bare decimal in the text', () => {
      expect(errorsOf(seasonal(1.35, true, 'Google budget at 1.35 for the season'))).toEqual([]);
      expect(errorsOf(seasonal(1.35, true, 'Google budget at 1.42 for the season'))).toEqual([
        'plan 1 projection 1 label: "1.42" in the text is not one of its cited or projected numbers',
      ]);
    });
  });

  it('still refuses an untraced figure written after a word and a hyphen ("a mid-$45,000 profit")', () => {
    rejects(withPlan1({ summary: 'This adds a mid-$45,000 profit every month.' }), '$45,000');
    rejects(withPlan1({ summary: 'Run a sub-$5,000 test.' }), '$5,000');
    rejects(withPlan1({ summary: 'Margins sit in the high-35% range.' }), '35%');
    rejects(withPlan1({ summary: 'Ads reach ROAS-9.5x.' }), '9.5x');
  });
});

// Design 4d: small counts were never checked, so "clear the 5 late repairs" passed when the data said 3.
describe('checkPlans and small counts next to what a cited count counts', () => {
  const counts: Metric[] = [
    ...metrics.filter((m) => m.business === 'salon'),
    { id: 'm:salon.repairs.open_over_14d.count', label: 'Repairs open longer than two weeks', value: 3, unit: 'count', business: 'salon', period: 'standing', source },
  ];
  const nouns = new Map([['m:salon.repairs.open_over_14d.count', ['repair', 'repairs', 'ticket', 'tickets']]]);
  const salonPlan = (rank: number, overrides: Record<string, unknown> = {}) => plan(rank, {
    title: `Plan ${rank}: finish the late repairs`, summary: 'Finish the 3 late repairs before new intake.', actions: ['Call each owner today'],
    evidence: [{ metricId: 'm:salon.repairs.open_over_14d.count', value: 3 }, { metricId: 'm:salon.revenue.wash_set', value: 6200 }],
    projections: [], test: 'Track it for 14 days.', stopLoss: 'Stop if the late count does not fall.', businesses: ['salon'], risks: ['Stylists are busy'], ...overrides,
  });
  const three = (p1: Record<string, unknown>) => ({ plans: [salonPlan(1, p1), salonPlan(2), salonPlan(3)], memoryConflicts: [] });

  it("accepts the cited count, and refuses another count of the same thing within two words", () => {
    expect(checkPlans(three({}), counts, nouns)).toMatchObject({ ok: true });
    const wrong = checkPlans(three({ summary: 'Finish the 5 late repairs before new intake.' }), counts, nouns);
    expect(wrong.ok).toBe(false);
    expect(!wrong.ok && wrong.errors).toEqual(['plan 1 summary: "5 late repairs" counts what m:salon.repairs.open_over_14d.count counts, so it must be its value (3), one of its projections or a count lever']);
    expect(checkPlans(three({ actions: ['Call the 7 tickets owners'] }), counts, nouns).ok).toBe(false);
  });

  // Review 2026-10-27: any count in the plan passed, so "16 late repairs" passed on the open count (16).
  describe('two cited counts that count the same thing', () => {
    const both: Metric[] = [...counts, { ...counts.at(-1)!, id: 'm:salon.repairs.open.count', label: 'Repairs not finished yet', value: 16 }];
    const qualified = new Map([
      ['m:salon.repairs.open_over_14d.count', ['late repair', 'late repairs', 'repair', 'repairs']],
      ['m:salon.repairs.open.count', ['open repair', 'open repairs', 'repair', 'repairs']],
    ]);
    const citing = (p1: Record<string, unknown>) => three({
      evidence: [{ metricId: 'm:salon.repairs.open_over_14d.count', value: 3 }, { metricId: 'm:salon.repairs.open.count', value: 16 }], ...p1,
    });
    const errorsOf = (p1: Record<string, unknown>) => { const r = checkPlans(citing(p1), both, qualified); return r.ok ? [] : r.errors; };

    it("holds a number to the count its words name, never to another count in the plan", () => {
      expect(errorsOf({ summary: 'Finish the 3 late repairs, then the 16 open repairs.' })).toEqual([]);
      expect(errorsOf({ summary: 'Finish the 16 late repairs.' })).toEqual([
        'plan 1 summary: "16 late repairs" counts what m:salon.repairs.open_over_14d.count counts, so it must be its value (3), one of its projections or a count lever',
      ]);
      expect(errorsOf({ summary: 'Clear the 3 open repairs.' })[0]).toContain('m:salon.repairs.open.count counts, so it must be its value (16)');
    });

    it('asks which count a bare noun means when the counts it could be differ', () => {
      expect(errorsOf({ summary: 'Finish the 3 repairs this week.' })).toEqual([
        'plan 1 summary: "3 repairs" could be m:salon.repairs.open_over_14d.count (3) or m:salon.repairs.open.count (16); name which, as in "late repair" or "open repair"',
      ]);
      // A count lever is a choice, whatever it is next to.
      expect(errorsOf({ actions: ['Book 5 repairs a day'], levers: [{ label: 'Repairs booked a day', value: 5, unit: 'count' }] })).toEqual([]);
    });
  });

  it('reads the words after "of the" and further than two words ("3 of the overdue invoices", "4 overdue supplier invoices")', () => {
    const owed: Metric[] = [
      ...metrics.filter((m) => m.business === 'salon'),
      { id: 'm:salon.ap.overdue.count', label: 'Overdue salon supplier invoices', value: 4, unit: 'count', business: 'salon', period: 'standing', source },
    ];
    const invoiceNouns = new Map([['m:salon.ap.overdue.count', ['overdue invoice', 'overdue invoices', 'invoice', 'invoices']]]);
    const raw = (summary: string) => ({ plans: [1, 2, 3].map((rank) => salonPlan(rank, {
      summary, evidence: [{ metricId: 'm:salon.ap.overdue.count', value: 4 }, { metricId: 'm:salon.revenue.wash_set', value: 6200 }],
    })), memoryConflicts: [] });
    expect(checkPlans(raw('Pay 3 of the overdue invoices first.'), owed, invoiceNouns).ok).toBe(false);
    expect(checkPlans(raw('Pay 5 overdue supplier invoices first.'), owed, invoiceNouns).ok).toBe(false);
    expect(checkPlans(raw('Pay 4 of the overdue invoices first.'), owed, invoiceNouns).ok).toBe(true);
    // A joining word ends what the number names: 2 owners, not 2 invoices.
    expect(checkPlans(raw('Call 2 owners about the overdue invoices.'), owed, invoiceNouns).ok).toBe(true);
  });

  it('accepts a count lever, and leaves alone a number next to other words, a duration, or no catalog words at all', () => {
    const lever = three({ actions: ['Book 5 repairs a day'], levers: [{ label: 'Repairs booked a day', value: 5, unit: 'count' }] });
    expect(checkPlans(lever, counts, nouns).ok).toBe(true);
    expect(checkPlans(three({ actions: ['Open 2 evening slots and call 5 owners'] }), counts, nouns).ok).toBe(true);
    expect(checkPlans(three({ actions: ['Finish them in 5 days, then review the repairs'] }), counts, nouns).ok).toBe(true);
    expect(checkPlans(three({ summary: 'Finish the 5 late repairs before new intake.' }), counts).ok).toBe(true); // no nouns given: as before
  });
});

describe('mixedSentences (the same rule for a reason or a note written about picked plans)', () => {
  // The review probe: a plan that cites salon revenue 12,400 and online revenue 18,900, so it lists both businesses.
  const probe: Metric[] = [
    { ...metrics[3]!, id: 'm:salon.revenue.total', label: 'Salon revenue', value: 12400 },
    { ...metrics[0]!, id: 'm:online.revenue.total', label: 'Online revenue', value: 18900 },
    ...metrics,
  ];
  const bothPlan = Plan.parse(plan(1, {
    evidence: [{ metricId: 'm:salon.revenue.total', value: 12400 }, { metricId: 'm:online.revenue.total', value: 18900 }],
    projections: [{ label: 'Online revenue with the test', baseMetricId: 'm:online.revenue.total', factor: 1.1, result: 20790, assumption: 'A small lift' }],
    businesses: ['salon', 'online'],
  }));
  const onlinePlan = Plan.parse(plan(2));
  const salonPlan = Plan.parse(plan(3, {
    evidence: [{ metricId: 'm:salon.revenue.wash_set', value: 6200 }], projections: [], businesses: ['salon'],
  }));

  it('flags a sentence that quotes a salon number and an online number from a plan that lists both businesses', () => {
    const text = 'Salon revenue is $12,400 while online revenue is $18,900, so both shops get a test.';
    expect(mixedSentences(text, [bothPlan], probe)).toEqual([['$12,400', '$18,900']]);
    // With other picks beside it (the salon's own plan holds 6,200, nothing that collides with these two).
    expect(mixedSentences(text, [bothPlan, salonPlan], probe)).toEqual([['$12,400', '$18,900']]);
  });

  it('is not hidden by a hyphen glued to each figure ("online-$12,400 … salon-$6,200")', () => {
    expect(mixedSentences('Mazali online-$12,400 beat wash and set salon-$6,200.', [onlinePlan, salonPlan], probe)).toEqual([['$12,400', '$6,200']]);
  });

  it('lets each side be quoted in its own sentence, and a business with itself', () => {
    expect(mixedSentences('Salon revenue is $12,400. Online revenue is $18,900.', [bothPlan], probe)).toEqual([]);
    expect(mixedSentences('Online revenue is $18,900 and would reach $20,790.', [bothPlan], probe)).toEqual([]);
  });

  it('knows the ratio and percent forms: 2.4x and 240% are the online return, $6,200 is the salon', () => {
    expect(mixedSentences('Ads return 2.4x while the salon earned $6,200.', [onlinePlan, salonPlan], probe)).toEqual([['2.4x', '$6,200']]);
    expect(mixedSentences('Ads return 240% while the salon earned $6,200.', [onlinePlan, salonPlan], probe)).toEqual([['240%', '$6,200']]);
  });

  it('is not hidden by a number two picks share, and does not judge numbers the plans do not hold', () => {
    // 6,200 is the salon plan's and also the other salon plan's; 12,400 is salon revenue in the both-plan.
    expect(mixedSentences('Ads return 2.4x while the salon earned $6,200.', [onlinePlan, salonPlan, bothPlan], probe)).toEqual([['2.4x', '$6,200']]);
    expect(mixedSentences('Ads return 2.4x while the salon earned $77,000.', [onlinePlan, salonPlan], probe)).toEqual([]);
  });

  it('counts a lever as the business of its plan when the plan touches one business, and as neither when it touches both', () => {
    const lever = { label: 'Daily budget', value: 55, unit: 'usd' as const };
    const onlineWithLever = Plan.parse(plan(2, { levers: [lever] }));
    const bothWithLever = Plan.parse({ ...bothPlan, levers: [lever] });
    expect(mixedSentences('Spend $55 a day while the salon earned $6,200.', [onlineWithLever, salonPlan], probe)).toEqual([['$55', '$6,200']]);
    expect(mixedSentences('Spend $55 a day while the salon earned $12,400.', [bothWithLever], probe)).toEqual([]);
  });

  it('leaves a combined metric out: a labeled blend is neither business', () => {
    const blended: Metric[] = [...probe, { ...metrics[0]!, id: 'm:combined.revenue.total', label: 'Both shops', value: 31300, business: 'combined' }];
    const withBlend = Plan.parse(plan(1, {
      evidence: [{ metricId: 'm:salon.revenue.total', value: 12400 }, { metricId: 'm:combined.revenue.total', value: 31300 }],
      projections: [], businesses: ['salon', 'combined'],
    }));
    expect(mixedSentences('Both shops made $31,300, of which the salon made $12,400.', [withBlend], blended)).toEqual([]);
  });
});
