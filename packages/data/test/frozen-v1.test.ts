import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeAll, financeViewBody } from '../src/finance-sql.ts';
import { generateBusiness, generateYear } from '../src/synthetic.ts';

// The numbers of hq/foundation @ bb29578, frozen. Version 1 of the data is what the live worker reads
// (the view fortune_hq.finance_metrics), and run logs, plans and docs/submission quote these values.
// Whatever the data grows into, today's rows, today's view and these 33 values per period stay exactly
// as they were. Computed by running the bb29578 code itself (git archive bb29578 packages/data/src).
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

const BB29578_BUSINESS_SHA = 'ada7d7427963450d87b073fa33d278c03173514d6691a1b672b433feb7934ed7';
const BB29578_VIEW_BODY_SHA = '8823fbf2dcf1e9860566487ed85e7a4fbeafe433d85a35d312fea94be334bdeb';

const FROZEN_V1: Record<'2026-09' | '2026-10-mtd', Record<string, number>> = {
  '2026-09': {
    'm:online.ads.amazon.conversions': 24, 'm:online.ads.amazon.revenue': 1089.98, 'm:online.ads.amazon.roas': 2.2823,
    'm:online.ads.amazon.spend': 477.57, 'm:online.ads.google.conversions': 6, 'm:online.ads.google.revenue': 6806.18,
    'm:online.ads.google.roas': 3.095, 'm:online.ads.google.spend': 2199.09, 'm:online.aov': 761.95,
    'm:online.discounts.total': 2213.41, 'm:online.dq.rejected_orders': 1, 'm:online.email.click_rate': 0.0386,
    'm:online.email.revenue': 20243.41, 'm:online.email.sends': 12868, 'm:online.gross_margin': 0.423,
    'm:online.gross_profit': 36102.59, 'm:online.orders.count': 112, 'm:online.revenue.accessories': 5510.76,
    'm:online.revenue.fortune': 24151.8, 'm:online.revenue.mazali': 40271.51, 'm:online.revenue.total': 85338.84,
    'm:online.revenue.tuni': 15404.77, 'm:salon.appointments.count': 242, 'm:salon.avg_ticket': 182.78,
    'm:salon.dq.rejected_appointments': 1, 'm:salon.no_shows.count': 5, 'm:salon.revenue.color': 6710.76,
    'm:salon.revenue.consignment_intake': 300, 'm:salon.revenue.cut_style': 11347.46,
    'm:salon.revenue.fortune_appointment': 6306.01, 'm:salon.revenue.repair': 9252.23, 'm:salon.revenue.total': 44233.45,
    'm:salon.revenue.wash_set': 10316.99,
  },
  '2026-10-mtd': {
    'm:online.ads.amazon.conversions': 28, 'm:online.ads.amazon.revenue': 1292.12, 'm:online.ads.amazon.roas': 3.0253,
    'm:online.ads.amazon.spend': 427.1, 'm:online.ads.google.conversions': 11, 'm:online.ads.google.revenue': 13431.1,
    'm:online.ads.google.roas': 7.1225, 'm:online.ads.google.spend': 1885.74, 'm:online.aov': 727.42,
    'm:online.discounts.total': 1961.38, 'm:online.dq.rejected_orders': 1, 'm:online.email.click_rate': 0.0311,
    'm:online.email.revenue': 16188.11, 'm:online.email.sends': 8071, 'm:online.gross_margin': 0.4245,
    'm:online.gross_profit': 27479.9, 'm:online.orders.count': 89, 'm:online.revenue.accessories': 4240.67,
    'm:online.revenue.fortune': 20463.17, 'm:online.revenue.mazali': 28994.85, 'm:online.revenue.total': 64739.95,
    'm:online.revenue.tuni': 11041.26, 'm:salon.appointments.count': 228, 'm:salon.avg_ticket': 186.26,
    'm:salon.dq.rejected_appointments': 0, 'm:salon.no_shows.count': 11, 'm:salon.revenue.color': 6210.19,
    'm:salon.revenue.consignment_intake': 210, 'm:salon.revenue.cut_style': 8771.85,
    'm:salon.revenue.fortune_appointment': 8197.78, 'm:salon.revenue.repair': 8653.67, 'm:salon.revenue.total': 42467.01,
    'm:salon.revenue.wash_set': 10423.52,
  },
};

describe('version 1 is frozen at bb29578', () => {
  it("keeps today's rows byte for byte", () => {
    expect(sha(JSON.stringify(generateBusiness()))).toBe(BB29578_BUSINESS_SHA);
  });

  it('keeps the live view definition, so its query hash (a plan\'s provenance) does not move', () => {
    expect(sha(financeViewBody())).toBe(BB29578_VIEW_BODY_SHA);
  });

  it('keeps all 33 metric values of 2026-09 and 2026-10-mtd', () => {
    const all = computeAll(generateBusiness(), 1);
    expect([...all.keys()]).toEqual(['2026-09', '2026-10-mtd']);
    for (const period of ['2026-09', '2026-10-mtd'] as const) {
      expect(Object.keys(FROZEN_V1[period])).toHaveLength(33);
      expect(Object.fromEntries(all.get(period)!)).toEqual(FROZEN_V1[period]);
    }
  });
});

describe('version 2 leaves those numbers where they were', () => {
  const year = generateYear();

  // Rebuilt live in slice 3 (2026-10-27, from 08:56 ET) with the day-to-day systems and the appointments' new
  // columns; slice 1's body (574bd04, 07:58 ET) was 2747af1d…. A change here needs `zetaris-setup.ts --v2 --recreate`.
  it("keeps version 2's period view as it was last built live in Zetaris, so the layers built on it read the same view", () => {
    expect(sha(financeViewBody(2))).toBe('e8198a3cc4b9230d2bb1849e5acef25fe91c1f5f5e7d57d4c1b3a88d0398a7e3');
  });

  it("carries version 1's rows unchanged among its own: every version 1 column and value (version 2 may add columns)", () => {
    const v1 = generateBusiness();
    const pairs: [readonly object[], readonly object[]][] = [
      [v1.online.orders, year.online.orders], [v1.salon.appointments, year.salon.appointments],
      [v1.marketing.ads, year.marketing.ads], [v1.marketing.email, year.marketing.email],
    ];
    for (const [rows, all] of pairs) {
      const columns = Object.keys(rows[0]!);
      const asV1 = (r: object) => JSON.stringify(columns.map((c) => (r as Record<string, unknown>)[c]));
      const inYear = new Set(all.map(asV1));
      expect(rows.filter((r) => !inYear.has(asV1(r)))).toEqual([]);
    }
    // The appointments gain only their three new columns.
    expect(Object.keys(year.salon.appointments[0]!)).toEqual([...Object.keys(v1.salon.appointments[0]!), 'location', 'booked_via', 'labor_cost_usd']);
  });

  it('computes the same 33 values for 2026-09 and 2026-10-mtd from thirteen months of rows', () => {
    const all = computeAll(year, 2);
    for (const period of ['2026-09', '2026-10-mtd'] as const) {
      const got = all.get(period)!;
      expect(Object.fromEntries(Object.keys(FROZEN_V1[period]).map((id) => [id, got.get(id)]))).toEqual(FROZEN_V1[period]);
    }
  });
});
