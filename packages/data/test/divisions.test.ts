import { Division, type Period } from '@fahq/contracts';
import { describe, expect, it } from 'vitest';
import {
  ATTENTION, CATALOG_V2, DIVISIONS, LAYERS, LAYER_VIEW, MARTS_V2, attentionFor, divisionHashText, divisionIds, divisionMartSql, divisionQueries,
  divisionSlice, filterViewBody, layerHashText, layerQueries,
} from '../src/divisions.ts';
import { computeLayers, derivedViewBody, standingViewBody } from '../src/layers.ts';
import { financeViewBody } from '../src/finance-sql.ts';
import { generateYear } from '../src/synthetic.ts';

// The four divisions in Zetaris: who reads which metric is the catalog's `divisions`, drawn as filter views
// and one Virtual Data Mart per division; the attention list only picks out values a division already has.

const layers = computeLayers(generateYear());

describe('division filter views', () => {
  it('give every division at least one metric in every layer, so no filter view is empty', () => {
    for (const d of DIVISIONS) for (const l of LAYERS) expect(divisionIds(d, l).length, `${d} ${l}`).toBeGreaterThan(0);
    expect([...DIVISIONS].sort()).toEqual([...Division.options].sort());
  });

  it("keep exactly the division's ids from the layer view and compute nothing", () => {
    for (const d of DIVISIONS) {
      for (const l of LAYERS) {
        const ids = divisionIds(d, l);
        expect(filterViewBody(d, l)).toBe(`SELECT period, metric_id, value FROM ${LAYER_VIEW[l].view} WHERE metric_id IN (${ids.map((id) => `'${id}'`).join(', ')})`);
        for (const m of CATALOG_V2) if (!ids.includes(m.id)) expect(filterViewBody(d, l)).not.toContain(`'${m.id}'`);
      }
    }
  });

  it('keep the businesses apart: the salon reads no online metric, the online division no salon metric', () => {
    for (const l of LAYERS) {
      expect(divisionIds('salon', l).every((id) => id.startsWith('m:salon.'))).toBe(true);
      expect(divisionIds('online', l).every((id) => id.startsWith('m:online.'))).toBe(true);
    }
  });

  it("give Finance the budget room and the season, and HQ the headline, the season and what needs attention", () => {
    expect(divisionIds('finance', 'derived')).toEqual(expect.arrayContaining(['m:online.budget.google.room', 'm:online.budget.meta.used', 'm:salon.season.month_index', 'm:online.season.last_year_index']));
    expect(divisionIds('hq', 'standing')).toEqual(expect.arrayContaining(['m:online.budget.proposed.count', 'm:salon.revenue.last_7d', 'm:online.revenue.last_7d']));
    expect(divisionIds('hq', 'period')).not.toContain('m:online.revenue.mazali');
    expect(divisionIds('online', 'derived')).not.toContain('m:online.budget.google.room');
  });

  it('route the day-to-day systems: repairs to the Salon, the inbox, checkouts and stock to Online, what is owed and what sales cost to Finance', () => {
    const all = (d: Division) => LAYERS.flatMap((l) => divisionIds(d, l));
    expect(all('salon')).toEqual(expect.arrayContaining(['m:salon.repairs.received.count', 'm:salon.repairs.within_14d.share', 'm:salon.repairs.open.count', 'm:salon.repairs.open_over_14d.count', 'm:salon.dq.rejected_repairs']));
    expect(all('online')).toEqual(expect.arrayContaining([
      'm:online.service.replied_1h.share', 'm:online.service.missed_sale_intent.count', 'm:online.service.waiting_now.count', 'm:online.checkouts.recovery_rate',
      'm:online.inventory.wanted_low_stock.count', 'm:online.refunds.count', 'm:online.refund_rate', 'm:online.dq.rejected_messages',
    ]));
    expect(all('finance')).toEqual(expect.arrayContaining([
      'm:online.fees.payment', 'm:online.shipping.cost', 'm:online.refunds.total', 'm:online.contribution', 'm:online.refund_rate', 'm:salon.repairs.cost',
      'm:salon.ap.invoiced', 'm:online.ap.open', 'm:salon.ap.due_30d', 'm:online.ap.overdue', 'm:combined.dq.rejected_invoices',
    ]));
    // Finance reads the money, not the inbox or the stock; Online does not read what is owed to factories.
    expect(all('finance').some((id) => /service|inventory|checkouts\.abandoned/.test(id))).toBe(false);
    expect(all('online').some((id) => /\.ap\.|contribution/.test(id))).toBe(false);
    // HQ: the profit after costs, what needs attention, and every rejected-rows count of every source.
    expect(all('hq')).toEqual(expect.arrayContaining(['m:online.contribution', 'm:online.service.waiting_over_24h.count', 'm:salon.repairs.open_over_14d.count', 'm:online.ap.overdue.count', 'm:salon.ap.overdue.count']));
    expect(all('hq')).toEqual(expect.arrayContaining(CATALOG_V2.filter((m) => m.id.includes('.dq.rejected_')).map((m) => m.id)));
    expect(all('hq')).not.toContain('m:online.service.inbound.count');
    // A combined number is a count of rows, never money, and only Finance and HQ read it.
    for (const m of CATALOG_V2.filter((x) => x.business === 'combined')) {
      expect(m.unit).toBe('count');
      expect([...m.divisions].sort()).toEqual(['finance', 'hq']);
    }
  });
});

describe('division marts', () => {
  it('are four, named under fortune_demo, none the version 1 mart nor starting with its name', () => {
    expect(Object.keys(MARTS_V2).sort()).toEqual([...DIVISIONS].sort());
    for (const mart of Object.values(MARTS_V2)) {
      expect(mart.startsWith('fortune_demo_v2_')).toBe(true);
      expect(mart.startsWith('fortune_demo_finance_mart')).toBe(false);
    }
  });

  it("hold one table per layer, each from the division's own filter view, every column mapped, one statement each", () => {
    for (const d of DIVISIONS) {
      const sql = divisionMartSql(d);
      expect(sql.create).toMatch(new RegExp(`^CREATE DATAMART ${MARTS_V2[d]} DESCRIBE BY '[A-Za-z0-9 _.,-]+'$`));
      expect(sql.drop).toBe(`DROP DATAMART ${MARTS_V2[d]}`);
      expect(sql.tables.map((t) => t.sql)).toEqual(LAYERS.map((l) =>
        `ADD DATAMART TABLE ${l}_metrics INTO ${MARTS_V2[d]} FROM fortune_hq_v2.${d}_${l}_metrics VSCHEMA (period period, metric_id metric_id, value value)`));
      for (const s of [sql.create, sql.drop, ...sql.tables.map((t) => t.sql)]) expect(s).not.toContain(';');
    }
  });

  it("are asked three statements by a division read: the period's totals and derived numbers, and the standing numbers", () => {
    expect(divisionQueries('salon', '2026-10-mtd').map((q) => q.sql)).toEqual([
      "SELECT metric_id, value FROM fortune_demo_v2_salon_mart.period_metrics WHERE period = '2026-10-mtd'",
      "SELECT metric_id, value FROM fortune_demo_v2_salon_mart.derived_metrics WHERE period = '2026-10-mtd'",
      "SELECT metric_id, value FROM fortune_demo_v2_salon_mart.standing_metrics WHERE period = 'standing'",
    ]);
    expect(() => divisionQueries('salon', '2026-13' as Period)).toThrow('unknown period');
    expect(layerQueries('2026-09').map((q) => q.table)).toEqual(['fortune_hq_v2.period_metrics', 'fortune_hq_v2.derived_metrics', 'fortune_hq_v2.standing_metrics']);
  });

  it('hash every view body under the mart, the mart tables and the queries, so a change to any of them moves the hash', () => {
    const queries = divisionQueries('finance', '2026-09');
    const text = divisionHashText('finance', queries);
    for (const part of [financeViewBody(2), derivedViewBody(), standingViewBody(), ...LAYERS.map((l) => filterViewBody('finance', l)), ...divisionMartSql('finance').tables.map((t) => t.sql), ...queries.map((q) => q.sql)]) {
      expect(text).toContain(part);
    }
    expect(divisionHashText('salon', divisionQueries('salon', '2026-09'))).not.toBe(text);
    const unsliced = layerHashText(layerQueries('2026-09'));
    for (const part of [financeViewBody(2), derivedViewBody(), standingViewBody()]) expect(unsliced).toContain(part);
  });

  it("slice the oracle's year to a division: its own ids only, the standing numbers whatever the period", () => {
    const salon = divisionSlice(layers, 'salon', '2026-09');
    expect([...salon.keys()].every((id) => id.startsWith('m:salon.'))).toBe(true);
    expect(salon.get('m:salon.season.month_index')).toBe(layers.derived.get('2026-09')!.get('m:salon.season.month_index'));
    expect(salon.get('m:salon.revenue.last_7d')).toBe(layers.standing.get('m:salon.revenue.last_7d'));
    expect(divisionSlice(layers, 'finance', '2025-11').get('m:online.budget.proposed.count')).toBe(1);
  });
});

describe('attention list', () => {
  it('has a level and a plain sentence without numbers for each rule, and every rule can match a metric version 2 serves', () => {
    for (const r of ATTENTION) {
      expect(['watch', 'act']).toContain(r.level);
      expect(r.rule).not.toMatch(/\d/);
      expect(r.rule).toMatch(/^[A-Z].*\.$/);
      expect(CATALOG_V2.some((m) => r.metrics.test(m.id)), r.rule).toBe(true);
    }
  });

  it('only picks out values it is given: no number of its own, nothing for a metric it was not given', () => {
    const fired = attentionFor([
      { id: 'm:online.dq.rejected_orders', value: 1 }, { id: 'm:salon.dq.rejected_appointments', value: 0 },
      { id: 'm:online.budget.google.used', value: 1.2 }, { id: 'm:online.budget.meta.used', value: 0.95 }, { id: 'm:online.budget.amazon.used', value: 0.5 },
      { id: 'm:online.budget.proposed.count', value: 1 }, { id: 'm:online.revenue.total', value: 99999 },
    ]);
    expect(fired.map((a) => [a.metricId, a.level])).toEqual([
      ['m:online.dq.rejected_orders', 'watch'], ['m:online.budget.google.used', 'act'], ['m:online.budget.meta.used', 'watch'], ['m:online.budget.proposed.count', 'act'],
    ]);
    for (const a of fired) expect(Object.keys(a).sort()).toEqual(['level', 'metricId', 'rule']);
    expect(attentionFor([])).toEqual([]);
  });

  it("fires on the synthetic year where the data says so: the waiting budget change for Finance and HQ, the planted bad rows", () => {
    const read = (d: Division, p: Period) => attentionFor([...divisionSlice(layers, d, p)].map(([id, value]) => ({ id, value })));
    expect(read('finance', '2026-10-mtd')).toContainEqual({ metricId: 'm:online.budget.proposed.count', level: 'act', rule: "A proposed ad budget change is waiting for the finance owner's decision." });
    expect(read('hq', '2026-10-mtd').map((a) => a.metricId)).toContain('m:online.budget.proposed.count');
    expect(read('salon', '2026-09').map((a) => a.metricId)).toContain('m:salon.dq.rejected_appointments'); // demo-a-bad-price, Sept 22
    expect(read('online', '2026-10-mtd').map((a) => a.metricId)).toContain('m:online.dq.rejected_orders'); // demo-o-bad-line, Oct 3
    expect(read('finance', '2026-03').map((a) => a.metricId)).toContain('m:online.dq.rejected_budgets'); // demo-bu-bad-negative
  });

  it("fires on the day-to-day systems where their rows say so, each in the divisions that read them, HQ seeing them all", () => {
    const read = (d: Division, p: Period) => attentionFor([...divisionSlice(layers, d, p)].map(([id, value]) => ({ id, value }))).map((a) => a.metricId);
    // Late repairs (standing, so every period), and nothing else for the salon this month.
    expect(read('salon', '2026-10-mtd')).toEqual(['m:salon.repairs.open_over_14d.count']);
    // The inbox, the stock and the planted order row for the online division; wave 2's repeat returners, low ratings
    // and duplicated messages.
    expect(read('online', '2026-10-mtd').sort()).toEqual([
      'm:online.dq.rejected_orders', 'm:online.inventory.wanted_low_stock.count', 'm:online.inventory.wanted_out_of_stock.count',
      'm:online.returns.repeat_customers.count', 'm:online.reviews.low_rating.count', 'm:online.service.duplicate.count',
      'm:online.service.missed_sale_intent.count', 'm:online.service.waiting_over_24h.count',
    ]);
    // Overdue supplier invoices of both businesses for Finance; no inbox or stock rule there.
    expect(read('finance', '2026-10-mtd')).toEqual(expect.arrayContaining(['m:salon.ap.overdue.count', 'm:online.ap.overdue.count']));
    expect(read('finance', '2026-10-mtd').some((id) => /service|inventory|repairs/.test(id))).toBe(false);
    const hq = read('hq', '2026-10-mtd');
    for (const d of ['salon', 'online', 'finance'] as const) for (const id of read(d, '2026-10-mtd')) expect(hq, id).toContain(id);
    // Each planted row of a new source shows where its source is read, in its own month.
    expect(read('online', '2026-02')).toContain('m:online.dq.rejected_checkouts'); // demo-ck-bad-recovery
    expect(read('online', '2026-08')).toContain('m:online.dq.rejected_messages'); // demo-msg-bad-reply
    expect(read('online', '2026-02')).toContain('m:online.dq.rejected_reviews'); // demo-rv-bad-rating
    expect(read('salon', '2026-07')).toContain('m:salon.dq.rejected_repairs'); // demo-rt-bad-dates
    expect(read('hq', '2026-01')).toContain('m:combined.dq.rejected_invoices'); // demo-inv-bad-due
  });
});
