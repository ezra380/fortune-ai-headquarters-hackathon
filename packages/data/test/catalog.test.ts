import { describe, expect, it } from 'vitest';
import { Division, MetricId } from '@fahq/contracts';
import { METRICS, VERSIONS } from '../src/finance-sql.ts';

// The metric catalog: who reads each metric (divisions), which layer it is, and what a reader or the plan
// checker needs to know about it. The business stays the legal split; divisions only say who reads.

describe('metric catalog', () => {
  it('names each metric once, under its business, readable by at least one division', () => {
    expect(new Set(METRICS.map((m) => m.id)).size).toBe(METRICS.length);
    for (const m of METRICS) {
      expect(() => MetricId.parse(m.id)).not.toThrow();
      expect(m.id.startsWith(`m:${m.business}.`)).toBe(true);
      expect(m.divisions.length).toBeGreaterThan(0);
      for (const d of m.divisions) expect(() => Division.parse(d)).not.toThrow();
      expect(['period', 'derived', 'standing']).toContain(m.layer);
    }
  });

  it('keeps thresholds and amounts out of labels (they go in "about"), and gives every count its nouns', () => {
    for (const m of METRICS) {
      expect(m.label, m.id).not.toMatch(/\d/);
      if (m.unit === 'count') expect(m.nouns?.length, m.id).toBeGreaterThan(0);
    }
  });

  it('keeps each business with its own division: salon metrics never reach Online, online never Salon', () => {
    for (const m of METRICS) {
      if (m.business === 'salon') expect(m.divisions).not.toContain('online');
      if (m.business === 'online') expect(m.divisions).not.toContain('salon');
    }
  });

  it("gives every division its slice: the money to Finance, the headline and data checks to HQ", () => {
    const of = (d: Division) => METRICS.filter((m) => m.divisions.includes(d)).map((m) => m.id);
    expect(of('salon')).toContain('m:salon.no_shows.count');
    expect(of('online')).toContain('m:online.email.click_rate');
    expect(of('finance')).toEqual(expect.arrayContaining(['m:online.ads.google.spend', 'm:online.ads.meta.spend', 'm:online.budget.google.cap', 'm:salon.revenue.total', 'm:online.revenue.total']));
    expect(of('finance')).not.toContain('m:online.email.sends');
    expect(of('hq')).toEqual(expect.arrayContaining(['m:online.revenue.total', 'm:online.gross_profit', 'm:salon.revenue.total', 'm:online.dq.rejected_orders', 'm:salon.dq.rejected_appointments', 'm:online.dq.rejected_budgets']));
    expect(of('hq')).not.toContain('m:online.revenue.mazali');
  });

  it('version 1 serves its original 33 metrics in their original order; version 2 serves every metric', () => {
    expect(VERSIONS[1].metrics.map((m) => m.id)).toEqual(METRICS.filter((m) => !m.since).map((m) => m.id));
    expect(VERSIONS[1].metrics).toHaveLength(33);
    expect(VERSIONS[1].metrics.some((m) => m.id.includes('meta') || m.id.includes('budget'))).toBe(false);
    expect(VERSIONS[2].metrics).toHaveLength(METRICS.length);
    expect(VERSIONS[1].periods).toEqual(['2026-09', '2026-10-mtd']);
    expect(VERSIONS[2].periods).toHaveLength(13);
  });
});
