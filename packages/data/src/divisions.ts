import type { Attention, Division, Metric, Period } from '@fahq/contracts';
import { CONTAINER_V2, PERIOD_VIEW_V2, VERSIONS, financeViewBody, quoted, type MetricDef } from './finance-sql.ts';
import {
  DERIVED, DERIVED_VIEW_V2, STANDING_METRICS, STANDING_PERIOD, STANDING_VIEW_V2, derivedViewBody, standingViewBody,
  type DerivedDef, type Layers,
} from './layers.ts';

// The four divisions in Zetaris (version 2). Who reads a metric is the catalog's `divisions`; the boundary
// is drawn in Zetaris itself: per division and layer, a filter view over the layer view that keeps only that
// division's ids, and per division a Virtual Data Mart whose three tables are those filter views. A division
// reads only its own mart, so per-assistant read-only users can later be granted one mart each.
// The attention list is a fixed set of rules over the values a division already has: a rule picks values
// out, it never makes a number.

export type Layer = 'period' | 'derived' | 'standing';
export const LAYERS: readonly Layer[] = ['period', 'derived', 'standing'];
export const DIVISIONS: readonly Division[] = ['salon', 'finance', 'online', 'hq'];

/** Every metric version 2 serves, all three layers, in layer order. */
export const CATALOG_V2: readonly (MetricDef | DerivedDef)[] = [...VERSIONS[2].metrics, ...DERIVED, ...STANDING_METRICS];
export const CATALOG_V2_BY_ID = new Map(CATALOG_V2.map((m) => [m.id, m]));

/** Each layer's own view and the body it was created from (part of every query hash that reads it). */
export const LAYER_VIEW: Record<Layer, { view: string; body: () => string }> = {
  period: { view: PERIOD_VIEW_V2, body: () => financeViewBody(2) },
  derived: { view: DERIVED_VIEW_V2, body: derivedViewBody },
  standing: { view: STANDING_VIEW_V2, body: standingViewBody },
};

/** The ids one division reads in one layer, in catalog order. */
export function divisionIds(division: Division, layer: Layer): string[] {
  return CATALOG_V2.filter((m) => m.layer === layer && m.divisions.includes(division)).map((m) => m.id);
}

export const filterViewName = (division: Division, layer: Layer) => `${division}_${layer}_metrics`;

/** A division's filter view over one layer: only its own ids, nothing computed. */
export function filterViewBody(division: Division, layer: Layer): string {
  const ids = divisionIds(division, layer);
  if (ids.length === 0) throw new Error(`the ${division} division reads no ${layer} metric`);
  return `SELECT period, metric_id, value FROM ${LAYER_VIEW[layer].view} WHERE metric_id IN (${quoted(ids)})`;
}

/** Version 2's division marts. Not the version 1 mart's name, nor a prefix of it. */
export const MARTS_V2: Record<Division, string> = {
  salon: 'fortune_demo_v2_salon_mart', finance: 'fortune_demo_v2_finance_mart', online: 'fortune_demo_v2_online_mart', hq: 'fortune_demo_v2_hq_mart',
};
export const martTableName = (layer: Layer) => `${layer}_metrics`;

/** A division mart's statements: create it, add one table per layer (from the filter views), drop it. */
export function divisionMartSql(division: Division): { create: string; tables: { table: string; sql: string }[]; drop: string } {
  const mart = MARTS_V2[division];
  return {
    create: `CREATE DATAMART ${mart} DESCRIBE BY 'Fortune demo ${division} division mart, version two, synthetic'`,
    tables: LAYERS.map((layer) => ({
      table: martTableName(layer),
      sql: `ADD DATAMART TABLE ${martTableName(layer)} INTO ${mart} FROM ${CONTAINER_V2}.${filterViewName(division, layer)} VSCHEMA (period period, metric_id metric_id, value value)`,
    })),
    drop: `DROP DATAMART ${mart}`,
  };
}

export type LayerQuery = { layer: Layer; table: string; sql: string; period: string };

/** The three statements a division read runs against its mart (the standing one asks no period). */
export function divisionQueries(division: Division, period: Period): LayerQuery[] {
  if (!VERSIONS[2].periods.includes(period)) throw new Error(`unknown period ${period}`);
  return LAYERS.map((layer) => {
    const table = `${MARTS_V2[division]}.${martTableName(layer)}`;
    const asked = layer === 'standing' ? STANDING_PERIOD : period;
    return { layer, table, period: asked, sql: `SELECT metric_id, value FROM ${table} WHERE period = '${asked}'` };
  });
}

/** The three statements the unsliced read (getFinanceMetrics, version 2) runs against the layer views. */
export function layerQueries(period: Period): LayerQuery[] {
  if (!VERSIONS[2].periods.includes(period)) throw new Error(`unknown period ${period}`);
  return LAYERS.map((layer) => {
    const asked = layer === 'standing' ? STANDING_PERIOD : period;
    return { layer, table: LAYER_VIEW[layer].view, period: asked, sql: `SELECT metric_id, value FROM ${LAYER_VIEW[layer].view} WHERE period = '${asked}'` };
  });
}

/** What a division read's query hash covers: every view body under its mart, the mart tables and the queries. */
export function divisionHashText(division: Division, queries: readonly LayerQuery[]): string {
  const mart = divisionMartSql(division);
  return [
    ...LAYERS.map((l) => LAYER_VIEW[l].body()),
    ...LAYERS.map((l) => filterViewBody(division, l)),
    ...mart.tables.map((t) => t.sql),
    ...queries.map((q) => q.sql),
  ].join('\n--\n');
}

/** What the unsliced version 2 read's query hash covers: the three layer bodies and the queries. */
export function layerHashText(queries: readonly LayerQuery[]): string {
  return [...LAYERS.map((l) => LAYER_VIEW[l].body()), ...queries.map((q) => q.sql)].join('\n--\n');
}

/**
 * The statement a metric's series runs: every period of one id, from the division's own mart table for its layer.
 * The id in the SQL is the catalog's own; an id the division does not read, or a standing one, is refused.
 */
export function seriesQuery(division: Division, metricId: string): { layer: Exclude<Layer, 'standing'>; table: string; sql: string } {
  const def = CATALOG_V2_BY_ID.get(metricId);
  if (!def || !def.divisions.includes(division)) throw new Error(`the ${division} division does not read a metric "${metricId.slice(0, 80)}"`);
  if (def.layer === 'standing') throw new Error(`${def.id} is a standing number: one value as of the data date, with no series`);
  const table = `${MARTS_V2[division]}.${martTableName(def.layer)}`;
  return { layer: def.layer, table, sql: `SELECT period, value FROM ${table} WHERE metric_id = '${def.id}'` };
}

/** What a series read's query hash covers: the layer view, the division's filter view, the mart table and the statement. */
export function seriesHashText(division: Division, q: ReturnType<typeof seriesQuery>): string {
  const added = divisionMartSql(division).tables.find((t) => t.table === martTableName(q.layer))!;
  return [LAYER_VIEW[q.layer].body(), filterViewBody(division, q.layer), added.sql, q.sql].join('\n--\n');
}

/** The oracle's series of one metric: its value in every period that has one, oldest first. */
export function seriesOf(layers: Layers, metricId: string): { period: Period; value: number }[] {
  const layer = CATALOG_V2_BY_ID.get(metricId)?.layer;
  if (layer !== 'period' && layer !== 'derived') return [];
  return [...layers[layer]].flatMap(([period, values]) => (values.has(metricId) ? [{ period, value: values.get(metricId)! }] : []));
}

/** The oracle's answer to one division read: its own ids, each layer's value for the period (standing: as of the data date). */
export function divisionSlice(layers: Layers, division: Division, period: Period): Map<string, number> {
  const out = new Map<string, number>();
  const take = (layer: Layer, values: Map<string, number> | undefined) => {
    for (const id of divisionIds(division, layer)) if (values?.has(id)) out.set(id, values.get(id)!);
  };
  take('period', layers.period.get(period));
  take('derived', layers.derived.get(period));
  take('standing', layers.standing);
  return out;
}

// ---- Attention ----------------------------------------------------------------------------

/** One fixed rule: which metrics it looks at, when a value needs a look, how urgent, and why in plain words. */
export type AttentionRule = { metrics: RegExp; when: (value: number) => boolean; level: Attention['level']; rule: string };

const BUDGET_USED = /^m:online\.budget\.(google|meta|amazon)\.used$/;

/** The attention list. Its sentences carry no numbers: the number is the metric's own value. */
export const ATTENTION: readonly AttentionRule[] = [
  { metrics: /^m:(salon|online|combined)\.dq\.rejected_/, when: (v) => v > 0, level: 'watch', rule: 'Some rows failed the data checks and were left out of the numbers.' },
  { metrics: BUDGET_USED, when: (v) => v > 1, level: 'act', rule: 'Ad spend went over the approved budget.' },
  { metrics: BUDGET_USED, when: (v) => v > 0.9 && v <= 1, level: 'watch', rule: 'Ad spend is close to the approved budget.' },
  { metrics: /^m:online\.budget\.proposed\.count$/, when: (v) => v > 0, level: 'act', rule: "A proposed ad budget change is waiting for the finance owner's decision." },
  { metrics: /^m:online\.service\.waiting_over_24h\.count$/, when: (v) => v > 0, level: 'act', rule: 'Customer messages have waited more than a day for a first answer.' },
  { metrics: /^m:online\.service\.missed_sale_intent\.count$/, when: (v) => v > 0, level: 'watch', rule: 'Customers who asked to buy got no answer in time and did not order.' },
  { metrics: /^m:online\.inventory\.wanted_out_of_stock\.count$/, when: (v) => v > 0, level: 'act', rule: 'Products customers are looking at are out of stock.' },
  { metrics: /^m:online\.inventory\.wanted_low_stock\.count$/, when: (v) => v > 0, level: 'watch', rule: 'Products customers are looking at are low on stock.' },
  { metrics: /^m:salon\.repairs\.open_over_14d\.count$/, when: (v) => v > 0, level: 'act', rule: 'Repairs have been open longer than two weeks.' },
  { metrics: /^m:(salon|online)\.ap\.overdue\.count$/, when: (v) => v > 0, level: 'act', rule: 'Supplier invoices are past their due date and unpaid.' },
  // Wave 2: the marketplace warehouses.
  { metrics: /^m:online\.(amazon|walmart)\.stock\.out\.count$/, when: (v) => v > 0, level: 'act', rule: 'Products are out of stock at a marketplace warehouse.' },
  { metrics: /^m:online\.(amazon|walmart)\.stock\.low_cover\.count$/, when: (v) => v > 0, level: 'watch', rule: 'Products at a marketplace warehouse have less than three weeks of stock left.' },
  // Wave 2: the customers.
  { metrics: /^m:online\.returns\.repeat_customers\.count$/, when: (v) => v > 0, level: 'watch', rule: 'Some customers have sent orders back again and again this year.' },
  { metrics: /^m:online\.service\.duplicate\.count$/, when: (v) => v > 0, level: 'watch', rule: 'Customers wrote again on another channel before their first message was answered.' },
  { metrics: /^m:online\.reviews\.low_rating\.count$/, when: (v) => v > 0, level: 'watch', rule: 'Customers left low product ratings.' },
];

/** The rules that fire on these metrics, in metric order. Only metrics present can fire; nothing is computed. */
export function attentionFor(metrics: readonly Pick<Metric, 'id' | 'value'>[]): Attention[] {
  return metrics.flatMap((m) =>
    ATTENTION.filter((r) => r.metrics.test(m.id) && r.when(m.value)).map((r) => ({ metricId: m.id, level: r.level, rule: r.rule })));
}
