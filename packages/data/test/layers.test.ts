import { PERIOD_KEYS, type Period } from '@fahq/contracts';
import { describe, expect, it } from 'vitest';
import { SOURCES, VERSIONS } from '../src/finance-sql.ts';
import { AS_OF, DERIVED, DERIVED_INPUTS, STANDING_METRICS, computeLayers, derivedViewBody, standingViewBody } from '../src/layers.ts';
import { generateYear } from '../src/synthetic.ts';

// Version 2's derived and standing layers: the SQL each view is created from, and the oracle that proves
// them. The oracle's numbers are checked here against the rows directly, so the proof in setup compares
// Zetaris with something already known to be right.

const WHOLE: readonly Period[] = PERIOD_KEYS.filter((p) => p !== '2026-10-mtd');
const year = generateYear();
const layers = computeLayers(year);
const derived = (p: Period, id: string) => layers.derived.get(p)!.get(id);
const period = (p: Period, id: string) => layers.period.get(p)!.get(id);

describe('derived view', () => {
  const body = derivedViewBody();

  it('reads the period view once, names every derived metric once and holds one statement', () => {
    expect(body.split('fortune_hq_v2.period_metrics').length - 1).toBe(1);
    for (const d of DERIVED) expect(body.split(`'${d.id}'`).length - 1, d.id).toBe(1);
    expect(body).not.toContain(';');
    expect(body).not.toContain('fortune_hq.');
  });

  it('reads only period metrics version 2 serves', () => {
    const served = VERSIONS[2].metrics.map((m) => m.id);
    for (const id of DERIVED_INPUTS) expect(served).toContain(id);
  });

  it('averages the season index over the twelve whole months in a window, and lags it twelve periods in a layer of its own', () => {
    const whole = `period IN (${WHOLE.map((p) => `'${p}'`).join(', ')})`;
    expect(body).toContain(`CASE WHEN ${whole} THEN ROUND(`);
    expect(body).toContain(`AVG(CASE WHEN ${whole} THEN i`);
    expect(body.match(/LAG\(m\d+, 12\) OVER \(ORDER BY period\)/g)).toHaveLength(2);
    // A window cannot sit inside another: the LAG reads a column the select below it made.
    expect(body).not.toMatch(/LAG\([^)]*OVER/);
    expect(body).toContain('NULLIF(');
  });
});

describe('derived numbers (the oracle)', () => {
  it('budget left is the approved cap minus spend, and the share used is spend over the cap, every period and channel', () => {
    for (const p of PERIOD_KEYS) {
      for (const ch of ['google', 'meta', 'amazon']) {
        const cap = period(p, `m:online.budget.${ch}.cap`)!;
        const spend = period(p, `m:online.ads.${ch}.spend`)!;
        expect(derived(p, `m:online.budget.${ch}.room`)).toBeCloseTo(cap - spend, 2);
        expect(derived(p, `m:online.budget.${ch}.used`)).toBeCloseTo(spend / cap, 4);
      }
    }
  });

  it('total ad spend and revenue per ad dollar use all three channels', () => {
    const p = '2026-09';
    const spend = ['google', 'meta', 'amazon'].reduce((t, ch) => t + period(p, `m:online.ads.${ch}.spend`)!, 0);
    expect(derived(p, 'm:online.ads.total.spend')).toBeCloseTo(spend, 2);
    expect(derived(p, 'm:online.mer')).toBeCloseTo(period(p, 'm:online.revenue.total')! / spend, 4);
  });

  it("averages the twelve whole months' season index to one; the month so far has none of its own and carries last October's", () => {
    for (const b of ['salon', 'online']) {
      const index = WHOLE.map((p) => derived(p, `m:${b}.season.month_index`)!);
      expect(index.reduce((t, v) => t + v, 0) / 12).toBeCloseTo(1, 3);
      expect(layers.derived.get('2026-10-mtd')!.has(`m:${b}.season.month_index`)).toBe(false);
      expect(derived('2026-10-mtd', `m:${b}.season.last_year_index`)).toBe(derived('2025-10', `m:${b}.season.month_index`));
      for (const p of WHOLE) expect(layers.derived.get(p)!.has(`m:${b}.season.last_year_index`)).toBe(false);
    }
  });

  it('follows the invented season: December busier than July online, July quieter than October in the salon', () => {
    expect(derived('2025-12', 'm:online.season.month_index')!).toBeGreaterThan(derived('2026-07', 'm:online.season.month_index')!);
    expect(derived('2026-07', 'm:salon.season.month_index')!).toBeLessThan(derived('2025-10', 'm:salon.season.month_index')!);
  });
});

describe('standing view', () => {
  const body = standingViewBody();

  it('is one select per source with a standing metric, period "standing", over every row of the source', () => {
    for (const source of new Set(STANDING_METRICS.map((d) => d.source))) {
      expect(body.split(`fortune_hq_v2.${SOURCES[source].table}`).length - 1).toBe(1);
    }
    expect(body.split("SELECT 'standing' AS period").length - 1).toBe(new Set(STANDING_METRICS.map((d) => d.source)).size);
    expect(body).not.toContain('GROUP BY');
    expect(body).not.toContain(';');
    for (const d of STANDING_METRICS) expect(body.split(`'${d.id}'`).length - 1).toBe(1);
  });

  it('dates its windows from the data date', () => {
    expect(AS_OF).toBe('2026-10-26');
    expect(body).toContain("order_date >= '2026-10-20' AND order_date <= '2026-10-26'");
    expect(body).toContain("status = 'proposed' AND month_start >= '2026-10-01'");
  });
});

describe('standing numbers (the oracle)', () => {
  const inLastWeek = (d: string) => d >= '2026-10-20' && d <= '2026-10-26';

  it('counts the proposed October Google raise as the one change waiting for a decision', () => {
    expect(layers.standing.get('m:online.budget.proposed.count')).toBe(1);
  });

  it('sums the last seven days of valid rows, the salon only from completed appointments', () => {
    const online = year.online.orders.filter((o) => inLastWeek(o.order_date) && SOURCES.orders.valid(o));
    expect(layers.standing.get('m:online.revenue.last_7d')).toBeCloseTo(online.reduce((t, o) => t + o.net_usd, 0), 2);
    const salon = year.salon.appointments.filter((a) => inLastWeek(a.appointment_date) && a.status === 'completed' && SOURCES.appointments.valid(a));
    expect(layers.standing.get('m:salon.revenue.last_7d')).toBeCloseTo(salon.reduce((t, a) => t + a.price_usd, 0), 2);
  });
});
