import { describe, expect, it } from 'vitest';
import { PERIOD_KEYS } from '@fahq/contracts';
import { computeAll } from '../src/finance-sql.ts';
import { AD_CHANNELS, PERIODS, generateDivisions, generateHistory, generateYear } from '../src/synthetic.ts';

// Version 2's rows: eleven months of history, Meta as an ad channel and the finance owner's budget sheet,
// each from its own seeded stream, beside version 1's rows (which test/frozen-v1.test.ts holds still).

const year = generateYear();
const sources = {
  orders: [year.online.orders, 'order_date'],
  appointments: [year.salon.appointments, 'appointment_date'],
  ads: [year.marketing.ads, 'ad_date'],
  email: [year.marketing.email, 'send_date'],
  budgets: [year.finance.budgets, 'month_start'],
} as const;
const idOf = (row: object) => String(Object.values(row)[0]);
const all = Object.values(sources).flatMap(([rows]) => rows as readonly object[]);

describe('version 2 rows', () => {
  it('are deterministic and each new source has its own stream', () => {
    expect(JSON.stringify(generateYear())).toBe(JSON.stringify(year));
    expect(JSON.stringify(generateHistory(7))).not.toBe(JSON.stringify(generateHistory()));
    // Meta and the budget sheet do not draw from each other: a different seed changes both, independently.
    expect(generateDivisions(7).budgets).not.toEqual(generateDivisions().budgets);
  });

  it('use only synthetic ids, each once, and new ids put a letter right before their digits', () => {
    const ids = all.map(idOf);
    expect(ids.every((id) => id.startsWith('demo-'))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    const added = [...generateHistory().online.orders, ...generateDivisions().metaAds, ...generateDivisions().budgets].map(idOf);
    // A digit right after a dash would read as an amount to the plan checker's number scan.
    expect(added.filter((id) => /-\d/.test(id))).toEqual([]);
  });

  it('cover Oct 1, 2025 to Oct 26, 2026, every source in every one of the thirteen periods', () => {
    for (const [name, [rows, date]] of Object.entries(sources)) {
      const dates = (rows as readonly Record<string, unknown>[]).map((r) => String(r[date]));
      expect(dates.every((d) => d >= '2025-10-01' && d <= '2026-10-26'), name).toBe(true);
      for (const p of PERIOD_KEYS) expect(dates.some((d) => d >= PERIODS[p].from && d <= PERIODS[p].to), `${name} ${p}`).toBe(true);
    }
    for (const channel of AD_CHANNELS) {
      for (const p of PERIOD_KEYS) expect(year.marketing.ads.some((a) => a.channel === channel && a.ad_date >= PERIODS[p].from && a.ad_date <= PERIODS[p].to)).toBe(true);
    }
  });

  it('keep the salon closed on Saturdays in history too, and plant bad rows only where version 1 did, plus one budget row', () => {
    const history = generateHistory();
    expect(history.salon.appointments.every((a) => new Date(`${a.appointment_date}T00:00:00Z`).getUTCDay() !== 6)).toBe(true);
    expect(all.map(idOf).filter((id) => id.includes('-bad-')).sort()).toEqual(['demo-a-bad-price', 'demo-bu-bad-negative', 'demo-o-bad-line', 'demo-o-bad-negative']);
  });

  it('hold a budget sheet: an approved cap per channel per month in $50 steps, one proposed raise, one bad row', () => {
    const approved = year.finance.budgets.filter((b) => b.status === 'approved' && !b.budget_id.includes('-bad-'));
    expect(approved).toHaveLength(13 * 3);
    expect(approved.every((b) => b.cap_usd > 0 && b.cap_usd % 50 === 0)).toBe(true);
    const proposed = year.finance.budgets.filter((b) => b.status === 'proposed');
    expect(proposed.map((b) => [b.channel, b.month_start])).toEqual([['google', '2026-10-01']]);
  });

  it('carry no medical or hair-loss field or value anywhere (Fortune rule 6)', () => {
    const banned = /medical|hair.?loss|alopecia|chemo|diagnos|fj_interest|topper_interest/i;
    for (const row of all) {
      for (const [key, value] of Object.entries(row)) {
        expect(key).not.toMatch(banned);
        if (typeof value === 'string') expect(value).not.toMatch(banned);
      }
    }
  });
});

describe('version 2 numbers (the oracle)', () => {
  const v2 = computeAll(year, 2);
  const at = (p: (typeof PERIOD_KEYS)[number], id: string) => v2.get(p)!.get(id);

  it('serve every metric in every one of the thirteen periods', () => {
    expect([...v2.keys()]).toEqual([...PERIOD_KEYS]);
    const ids = [...v2.get('2026-09')!.keys()].sort();
    for (const p of PERIOD_KEYS) expect([...v2.get(p)!.keys()].sort()).toEqual(ids);
    expect(ids).toContain('m:online.ads.meta.roas');
    expect(ids).toContain('m:online.budget.amazon.cap');
  });

  it('show the invented season: a quiet salon July and a busy online December', () => {
    expect(at('2026-07', 'm:salon.revenue.total')!).toBeLessThan(at('2026-09', 'm:salon.revenue.total')! * 0.85);
    expect(at('2025-12', 'm:online.revenue.total')!).toBeGreaterThan(at('2026-01', 'm:online.revenue.total')!);
  });

  it("count only approved budget caps: October's proposed Google raise never counts", () => {
    const octApproved = year.finance.budgets.find((b) => b.budget_id === 'demo-bu-google202610')!;
    expect(at('2026-10-mtd', 'm:online.budget.google.cap')).toBe(octApproved.cap_usd);
    expect(at('2026-03', 'm:online.dq.rejected_budgets')).toBe(1); // demo-bu-bad-negative
    expect(PERIOD_KEYS.filter((p) => at(p, 'm:online.dq.rejected_budgets') !== 0)).toEqual(['2026-03']);
    // The bad row's negative cap stays out of March's Meta cap.
    const marchMeta = year.finance.budgets.find((b) => b.budget_id === 'demo-bu-meta202603')!;
    expect(at('2026-03', 'm:online.budget.meta.cap')).toBe(marchMeta.cap_usd);
  });

  it('total Meta spend from the Meta rows alone', () => {
    const sept = year.marketing.ads.filter((a) => a.channel === 'meta' && a.ad_date >= '2026-09-01' && a.ad_date <= '2026-09-30');
    expect(at('2026-09', 'm:online.ads.meta.spend')).toBeCloseTo(sept.reduce((t, a) => t + a.spend_usd, 0), 2);
  });
});
