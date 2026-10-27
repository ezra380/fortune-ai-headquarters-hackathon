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
    expect(read('salon', '2026-09').map((a) => a.metricId)).toEqual(['m:salon.dq.rejected_appointments']); // demo-a-bad-price, Sept 22
    expect(read('online', '2026-10-mtd').map((a) => a.metricId)).toEqual(['m:online.dq.rejected_orders']); // demo-o-bad-line, Oct 3
    expect(read('finance', '2026-03').map((a) => a.metricId)).toContain('m:online.dq.rejected_budgets'); // demo-bu-bad-negative
  });
});
