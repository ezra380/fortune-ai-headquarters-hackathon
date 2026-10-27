import { PERIODS, PRODUCT_LINES, SALON_SERVICES, type Period, type SyntheticBusiness } from './synthetic.ts';

// The governed finance view. Each metric is defined once, as data, and turned into two things:
// the Zetaris SQL (one SELECT per metric, UNION ALL'd into fortune_hq.finance_metrics) and a plain
// TypeScript computation over the same synthetic rows. The TypeScript side is the test oracle:
// setup proves the federated Zetaris answer matches it, metric by metric.
// Data-quality rules live in the view: invalid rows never reach a revenue number, and each
// business has a "rejected rows" metric so the filter is visible, not silent.

export const CONTAINER = 'fortune_hq';
export const FINANCE_VIEW = `${CONTAINER}.finance_metrics`;

// The Virtual Data Mart over the governed view: the same three columns under their own names, no copy.
// A mart table is queried as <mart>.<table> (a flat two-part name, without the container prefix).
export const MART = 'fortune_demo_finance_mart';
export const MART_TABLE = 'finance_metrics';
export const MART_VIEW = `${MART}.${MART_TABLE}`;
/** The view's columns in order; ADD DATAMART TABLE needs every source column to be given a virtual name. */
export const FINANCE_VIEW_COLUMNS = ['period', 'metric_id', 'value'] as const;

/** The three Virtual Data Mart statements (create, add the table, drop). One statement per call. */
export function martSql(): { create: string; addTable: string; drop: string } {
  return {
    create: `CREATE DATAMART ${MART} DESCRIBE BY 'Fortune demo finance mart, synthetic'`,
    addTable: `ADD DATAMART TABLE ${MART_TABLE} INTO ${MART} FROM ${FINANCE_VIEW} VSCHEMA (${FINANCE_VIEW_COLUMNS.map((c) => `${c} ${c}`).join(', ')})`,
    drop: `DROP DATAMART ${MART}`,
  };
}

type Row = Record<string, unknown>;
type Field = string | { sql: string; js: (r: Row) => number };

type Source = 'orders' | 'appointments' | 'ads' | 'email';
const quoted = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');
const num = (r: Row, k: string) => Number(r[k]);

export const SOURCES: Record<Source, { view: string; date: string; validSql: string; valid: (r: Row) => boolean }> = {
  orders: {
    view: `${CONTAINER}.online_orders`,
    date: 'order_date',
    validSql: `gross_usd >= 0 AND net_usd >= 0 AND cost_usd >= 0 AND product_line IN (${quoted(PRODUCT_LINES)})`,
    valid: (r) => num(r, 'gross_usd') >= 0 && num(r, 'net_usd') >= 0 && num(r, 'cost_usd') >= 0 && (PRODUCT_LINES as readonly unknown[]).includes(r.product_line),
  },
  appointments: {
    view: `${CONTAINER}.salon_appointments`,
    date: 'appointment_date',
    validSql: `price_usd >= 0 AND duration_min > 0 AND service IN (${quoted(SALON_SERVICES)})`,
    valid: (r) => num(r, 'price_usd') >= 0 && num(r, 'duration_min') > 0 && (SALON_SERVICES as readonly unknown[]).includes(r.service),
  },
  ads: {
    view: `${CONTAINER}.marketing_ads`,
    date: 'ad_date',
    validSql: 'spend_usd >= 0 AND clicks >= 0 AND conversions >= 0 AND revenue_usd >= 0',
    valid: (r) => num(r, 'spend_usd') >= 0 && num(r, 'clicks') >= 0 && num(r, 'conversions') >= 0 && num(r, 'revenue_usd') >= 0,
  },
  email: {
    view: `${CONTAINER}.marketing_email`,
    date: 'send_date',
    validSql: 'sends >= 0 AND opens >= 0 AND clicks >= 0 AND revenue_usd >= 0',
    valid: (r) => num(r, 'sends') >= 0 && num(r, 'opens') >= 0 && num(r, 'clicks') >= 0 && num(r, 'revenue_usd') >= 0,
  },
};

type Agg =
  | { kind: 'sum'; field: Field }
  | { kind: 'avg'; field: Field }
  | { kind: 'count' }
  | { kind: 'ratio'; num: Field; den: Field }
  | { kind: 'rejected' };

export type MetricDef = {
  id: string;
  label: string;
  unit: 'usd' | 'count' | 'ratio';
  business: 'salon' | 'online';
  source: Source;
  agg: Agg;
  where?: Record<string, string>;
};

const profit: Field = { sql: '(net_usd - cost_usd)', js: (r) => num(r, 'net_usd') - num(r, 'cost_usd') };
const LINE_LABEL: Record<(typeof PRODUCT_LINES)[number], string> = { fortune: 'Fortune', mazali: 'Mazali', tuni: 'Tuni', accessories: 'accessories' };
const SERVICE_LABEL: Record<(typeof SALON_SERVICES)[number], string> = {
  wash_set: 'wash and set', cut_style: 'cut and style', repair: 'repair', consignment_intake: 'consignment intake fee',
  color: 'color', fortune_appointment: 'Fortune fitting appointment',
};
const done = { status: 'completed' };

export const METRICS: MetricDef[] = [
  { id: 'm:online.revenue.total', label: 'Online revenue after discounts', unit: 'usd', business: 'online', source: 'orders', agg: { kind: 'sum', field: 'net_usd' } },
  ...PRODUCT_LINES.map((line): MetricDef => ({
    id: `m:online.revenue.${line}`, label: `Online ${LINE_LABEL[line]} revenue`, unit: 'usd', business: 'online', source: 'orders',
    agg: { kind: 'sum', field: 'net_usd' }, where: { product_line: line },
  })),
  { id: 'm:online.orders.count', label: 'Online orders', unit: 'count', business: 'online', source: 'orders', agg: { kind: 'count' } },
  { id: 'm:online.aov', label: 'Online average order value', unit: 'usd', business: 'online', source: 'orders', agg: { kind: 'avg', field: 'net_usd' } },
  { id: 'm:online.discounts.total', label: 'Online discounts given', unit: 'usd', business: 'online', source: 'orders', agg: { kind: 'sum', field: 'discount_usd' } },
  { id: 'm:online.gross_profit', label: 'Online gross profit', unit: 'usd', business: 'online', source: 'orders', agg: { kind: 'sum', field: profit } },
  { id: 'm:online.gross_margin', label: 'Online gross margin (profit / revenue)', unit: 'ratio', business: 'online', source: 'orders', agg: { kind: 'ratio', num: profit, den: 'net_usd' } },
  { id: 'm:online.dq.rejected_orders', label: 'Online order rows rejected by data checks', unit: 'count', business: 'online', source: 'orders', agg: { kind: 'rejected' } },
  ...(['google', 'amazon'] as const).flatMap((ch): MetricDef[] => {
    const name = ch === 'google' ? 'Google' : 'Amazon';
    const where = { channel: ch };
    return [
      { id: `m:online.ads.${ch}.spend`, label: `${name} ad spend`, unit: 'usd', business: 'online', source: 'ads', agg: { kind: 'sum', field: 'spend_usd' }, where },
      { id: `m:online.ads.${ch}.revenue`, label: `${name} ad revenue`, unit: 'usd', business: 'online', source: 'ads', agg: { kind: 'sum', field: 'revenue_usd' }, where },
      { id: `m:online.ads.${ch}.roas`, label: `${name} ad return (revenue / spend)`, unit: 'ratio', business: 'online', source: 'ads', agg: { kind: 'ratio', num: 'revenue_usd', den: 'spend_usd' }, where },
      { id: `m:online.ads.${ch}.conversions`, label: `${name} ad orders`, unit: 'count', business: 'online', source: 'ads', agg: { kind: 'sum', field: 'conversions' }, where },
    ];
  }),
  { id: 'm:online.email.revenue', label: 'Email revenue', unit: 'usd', business: 'online', source: 'email', agg: { kind: 'sum', field: 'revenue_usd' } },
  { id: 'm:online.email.sends', label: 'Emails sent', unit: 'count', business: 'online', source: 'email', agg: { kind: 'sum', field: 'sends' } },
  { id: 'm:online.email.click_rate', label: 'Email click rate (clicks / sends)', unit: 'ratio', business: 'online', source: 'email', agg: { kind: 'ratio', num: 'clicks', den: 'sends' } },
  { id: 'm:salon.revenue.total', label: 'Salon revenue (completed appointments)', unit: 'usd', business: 'salon', source: 'appointments', agg: { kind: 'sum', field: 'price_usd' }, where: done },
  ...SALON_SERVICES.map((s): MetricDef => ({
    id: `m:salon.revenue.${s}`, label: `Salon ${SERVICE_LABEL[s]} revenue`, unit: 'usd', business: 'salon', source: 'appointments',
    agg: { kind: 'sum', field: 'price_usd' }, where: { ...done, service: s },
  })),
  { id: 'm:salon.appointments.count', label: 'Salon completed appointments', unit: 'count', business: 'salon', source: 'appointments', agg: { kind: 'count' }, where: done },
  { id: 'm:salon.no_shows.count', label: 'Salon no-shows', unit: 'count', business: 'salon', source: 'appointments', agg: { kind: 'count' }, where: { status: 'no_show' } },
  { id: 'm:salon.avg_ticket', label: 'Salon average ticket', unit: 'usd', business: 'salon', source: 'appointments', agg: { kind: 'avg', field: 'price_usd' }, where: done },
  { id: 'm:salon.dq.rejected_appointments', label: 'Salon appointment rows rejected by data checks', unit: 'count', business: 'salon', source: 'appointments', agg: { kind: 'rejected' } },
];

export const METRIC_BY_ID = new Map(METRICS.map((m) => [m.id, m]));

// ---- SQL ----------------------------------------------------------------------------------

const PERIOD_KEYS = Object.keys(PERIODS) as Period[];
const FIRST_DAY = PERIODS[PERIOD_KEYS[0]!].from;
const LAST_DAY = PERIODS[PERIOD_KEYS[PERIOD_KEYS.length - 1]!].to;

function periodCase(col: string): string {
  return `CASE ${PERIOD_KEYS.map((p) => `WHEN ${col} BETWEEN '${PERIODS[p].from}' AND '${PERIODS[p].to}' THEN '${p}'`).join(' ')} END`;
}
const fieldSql = (f: Field) => (typeof f === 'string' ? f : f.sql);

// Conditional aggregates: each metric's filter goes inside its aggregate, so every source view is
// scanned once. (Spark rejects a query that unions the same LATERAL VIEW explode view with itself:
// MISSING_ATTRIBUTES.RESOLVED_ATTRIBUTE_APPEAR_IN_OPERATION, seen live 2026-10-26.)
function aggSql(d: MetricDef, validSql: string): string {
  const filters = Object.entries(d.where ?? {}).map(([k, v]) => `${k} = '${v}'`);
  const agg = d.agg;
  const cond = [...(agg.kind === 'rejected' ? [] : [`(${validSql})`]), ...filters].join(' AND ') || 'TRUE';
  const when = (f: Field) => `CASE WHEN ${cond} THEN ${fieldSql(f)} END`;
  switch (agg.kind) {
    case 'sum': return `ROUND(SUM(${when(agg.field)}), 2)`;
    case 'avg': return `ROUND(AVG(${when(agg.field)}), 2)`;
    case 'count': return `COUNT(CASE WHEN ${cond} THEN 1 END)`;
    case 'ratio': return `ROUND(SUM(${when(agg.num)}) / SUM(${when(agg.den)}), 4)`;
    case 'rejected': return `COUNT(CASE WHEN ${cond} AND NOT COALESCE(${validSql}, FALSE) THEN 1 END)`;
  }
}

/** One source: aggregate every metric per period in one scan, then unpivot to (period, metric_id, value). */
function sourceSelect(source: Source): string {
  const s = SOURCES[source];
  const defs = METRICS.filter((d) => d.source === source);
  const period = periodCase(s.date);
  const wide = `SELECT ${period} AS period, ${defs.map((d, i) => `CAST(${aggSql(d, s.validSql)} AS DOUBLE) AS m${i}`).join(', ')} FROM ${s.view} WHERE ${s.date} BETWEEN '${FIRST_DAY}' AND '${LAST_DAY}' GROUP BY ${period}`;
  const stack = `stack(${defs.length}, ${defs.map((d, i) => `'${d.id}', m${i}`).join(', ')}) AS (metric_id, value)`;
  return `SELECT period, metric_id, value FROM (SELECT period, ${stack} FROM (${wide}) w_${source}) s_${source} WHERE value IS NOT NULL`;
}

/** The body of fortune_hq.finance_metrics: one row per (period, metric). */
export function financeViewBody(): string {
  return (Object.keys(SOURCES) as Source[]).map(sourceSelect).join('\nUNION ALL\n');
}

export function financeQuery(period: Period): string {
  if (!(period in PERIODS)) throw new Error(`unknown period ${period}`);
  return `SELECT metric_id, value FROM ${FINANCE_VIEW} WHERE period = '${period}'`;
}

/** The same question asked of the Virtual Data Mart table instead of the view. */
export function martQuery(period: Period): string {
  if (!(period in PERIODS)) throw new Error(`unknown period ${period}`);
  return `SELECT metric_id, value FROM ${MART_VIEW} WHERE period = '${period}'`;
}

// ---- Oracle -------------------------------------------------------------------------------

const fieldJs = (f: Field) => (typeof f === 'string' ? (r: Row) => num(r, f) : f.js);
const sum = (rows: Row[], f: Field) => rows.reduce((t, r) => t + fieldJs(f)(r), 0);
const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

/** The same metrics computed in TypeScript from the same rows; used to prove the Zetaris answer. */
export function computeFinanceMetricsLocally(b: SyntheticBusiness, period: Period): Map<string, number> {
  const rowsBySource: Record<Source, Row[]> = {
    orders: b.online.orders, appointments: b.salon.appointments, ads: b.marketing.ads, email: b.marketing.email,
  };
  const { from, to } = PERIODS[period];
  const out = new Map<string, number>();
  for (const d of METRICS) {
    const s = SOURCES[d.source];
    const inPeriod = rowsBySource[d.source].filter((r) => String(r[s.date]) >= from && String(r[s.date]) <= to);
    if (inPeriod.length === 0) continue; // no GROUP BY row for this source and period
    const rows = inPeriod
      .filter((r) => d.agg.kind === 'rejected' || s.valid(r))
      .filter((r) => Object.entries(d.where ?? {}).every(([k, v]) => r[k] === v));
    const a = d.agg;
    // SQL: COUNT of nothing is 0; SUM, AVG and a ratio over nothing are NULL, and NULL rows are dropped.
    if (rows.length === 0 && (a.kind === 'sum' || a.kind === 'avg' || a.kind === 'ratio')) continue;
    const value =
      a.kind === 'sum' ? round(sum(rows, a.field), 2)
      : a.kind === 'avg' ? round(sum(rows, a.field) / rows.length, 2)
      : a.kind === 'count' ? rows.length
      : a.kind === 'ratio' ? round(sum(rows, a.num) / sum(rows, a.den), 4)
      : rows.filter((r) => !s.valid(r)).length;
    out.set(d.id, value);
  }
  return out;
}
