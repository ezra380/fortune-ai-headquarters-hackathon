import { DEFAULT_PERIODS, PERIOD_KEYS, type Division, type Period } from '@fahq/contracts';
import { OPS_METRICS, OPS_SOURCES, OPS_SOURCE_NAMES, type OpsSource } from './operations.ts';
import { ONE, num, oneIf, oneOf, quoted, type Cond, type Field, type Row, type SourceSpec } from './sql.ts';
import {
  AD_CHANNELS, BOOKING_CHANNELS, PERIODS, PRODUCT_LINES, SALON_LOCATIONS, SALON_SERVICES, type SyntheticBusiness, type SyntheticYear,
} from './synthetic.ts';

// The governed metric views. Each metric is defined once, as data, and turned into two things: the
// Zetaris SQL (one conditional aggregate per metric, one scan per source, UNION ALL'd into one view) and a
// plain TypeScript computation over the same synthetic rows. The TypeScript side is the test oracle:
// setup proves the federated Zetaris answer matches it, metric by metric.
// Data-quality rules live in the view: invalid rows never reach a revenue number, and each source has a
// "rejected rows" metric so the filter is visible, not silent.
// Two versions live side by side. Version 1 is the live view fortune_hq.finance_metrics: four sources, 33
// metrics, two periods, frozen (test/frozen-v1.test.ts). Version 2 adds periods, sources and metrics in
// its own container, so switching (FAHQ_DATA_VERSION) and rolling back are a setting, not a rebuild.

export const CONTAINER = 'fortune_hq';
export const FINANCE_VIEW = `${CONTAINER}.finance_metrics`;
export const CONTAINER_V2 = 'fortune_hq_v2';
export const PERIOD_VIEW_V2 = `${CONTAINER_V2}.period_metrics`;

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

export { quoted, type Row };

export type DataVersion = 1 | 2;
/** Version 1's four sources, the budget sheet, and the day-to-day systems of operations.ts (version 2). */
export type Source = 'orders' | 'appointments' | 'ads' | 'email' | 'budgets' | OpsSource;

/** Each source: its row view's name (in each version's container), its date column and its data-quality rule. */
export const SOURCES: Record<Source, SourceSpec> = {
  ...OPS_SOURCES,
  orders: {
    table: 'online_orders',
    date: 'order_date',
    validSql: `gross_usd >= 0 AND net_usd >= 0 AND cost_usd >= 0 AND product_line IN (${quoted(PRODUCT_LINES)})`,
    valid: (r) => num(r, 'gross_usd') >= 0 && num(r, 'net_usd') >= 0 && num(r, 'cost_usd') >= 0 && (PRODUCT_LINES as readonly unknown[]).includes(r.product_line),
  },
  appointments: {
    table: 'salon_appointments',
    date: 'appointment_date',
    validSql: `price_usd >= 0 AND duration_min > 0 AND service IN (${quoted(SALON_SERVICES)})`,
    valid: (r) => num(r, 'price_usd') >= 0 && num(r, 'duration_min') > 0 && (SALON_SERVICES as readonly unknown[]).includes(r.service),
  },
  ads: {
    table: 'marketing_ads',
    date: 'ad_date',
    validSql: 'spend_usd >= 0 AND clicks >= 0 AND conversions >= 0 AND revenue_usd >= 0',
    valid: (r) => num(r, 'spend_usd') >= 0 && num(r, 'clicks') >= 0 && num(r, 'conversions') >= 0 && num(r, 'revenue_usd') >= 0,
  },
  email: {
    table: 'marketing_email',
    date: 'send_date',
    validSql: 'sends >= 0 AND opens >= 0 AND clicks >= 0 AND revenue_usd >= 0',
    valid: (r) => num(r, 'sends') >= 0 && num(r, 'opens') >= 0 && num(r, 'clicks') >= 0 && num(r, 'revenue_usd') >= 0,
  },
  budgets: {
    table: 'finance_budgets',
    date: 'month_start',
    validSql: `cap_usd >= 0 AND channel IN (${quoted(AD_CHANNELS)}) AND status IN ('approved', 'proposed')`,
    valid: (r) => num(r, 'cap_usd') >= 0 && (AD_CHANNELS as readonly unknown[]).includes(r.channel) && ['approved', 'proposed'].includes(String(r.status)),
  },
};

/**
 * Version 2's appointments also carry the location, how the visit was booked and the stylist's labor cost, and
 * their rule checks those too. Version 1's view never names them: its rule is frozen with it.
 */
const APPOINTMENTS_V2: SourceSpec = {
  ...SOURCES.appointments,
  validSql: `${SOURCES.appointments.validSql} AND status IN ('completed', 'no_show') AND location IN (${quoted(SALON_LOCATIONS)}) AND booked_via IN (${quoted(BOOKING_CHANNELS)}) AND labor_cost_usd >= 0`,
  valid: (r) => SOURCES.appointments.valid(r) && oneOf(['completed', 'no_show'], r.status) && oneOf(SALON_LOCATIONS, r.location)
    && oneOf(BOOKING_CHANNELS, r.booked_via) && num(r, 'labor_cost_usd') >= 0,
};

/** A source as a version reads it: the same everywhere but version 2's appointments. */
export const specOf = (source: Source, version: DataVersion): SourceSpec => (version === 2 && source === 'appointments' ? APPOINTMENTS_V2 : SOURCES[source]);

type Agg =
  | { kind: 'sum'; field: Field }
  | { kind: 'avg'; field: Field }
  | { kind: 'count' }
  | { kind: 'ratio'; num: Field; den: Field }
  | { kind: 'rejected' };

/** What every metric says about itself, whichever layer computes it. */
export type MetricAbout = {
  id: string;
  label: string;
  unit: 'usd' | 'count' | 'ratio';
  /**
   * The legal split (salon or online); never changes, and the number validator keeps using it. 'combined' only
   * for a count that belongs to neither, like rows rejected from a source both businesses share; never money.
   */
  business: 'salon' | 'online' | 'combined';
  /** Who reads it. Ad spend is online business, read by Finance and Online. */
  divisions: readonly Division[];
  /** 'period': a total over the period's rows; 'derived': from other metrics (layers.ts); 'standing': as of the data date. */
  layer: 'period' | 'derived' | 'standing';
  /** Thresholds and caveats a reader needs, kept out of the label so a plan never echoes them as numbers. */
  about?: string;
  /** For a count: the words that name what it counts, so a plan's small counts can be checked against it. */
  nouns?: readonly string[];
  /** false keeps it out of plan writing until the validator can check its kind of number (default true). */
  planUse?: boolean;
  /** 2: first served by data version 2. Absent: served by both versions. */
  since?: 2;
};

/** A metric computed from one source's rows: a period total, or (standing) one number as of the data date. */
export type MetricDef = MetricAbout & {
  layer: 'period' | 'standing';
  source: Source;
  agg: Agg;
  where?: Record<string, string>;
  /** A condition beyond equality (a comparison, NULL, a list), in SQL and in TypeScript. */
  test?: Cond;
  /** Standing metrics: only rows dated from `from` (and up to `to`, when given), whatever the period. */
  window?: { from: string; to?: string };
};

const profit: Field = { sql: '(net_usd - cost_usd)', js: (r) => num(r, 'net_usd') - num(r, 'cost_usd') };
const LINE_LABEL: Record<(typeof PRODUCT_LINES)[number], string> = { fortune: 'Fortune', mazali: 'Mazali', tuni: 'Tuni', accessories: 'accessories' };
const SERVICE_LABEL: Record<(typeof SALON_SERVICES)[number], string> = {
  wash_set: 'wash and set', cut_style: 'cut and style', repair: 'repair', consignment_intake: 'consignment intake fee',
  color: 'color', fortune_appointment: 'Fortune fitting appointment',
};
export const CHANNEL_LABEL: Record<(typeof AD_CHANNELS)[number], string> = { google: 'Google', meta: 'Meta', amazon: 'Amazon' };
const done = { status: 'completed' };

// Who reads what. Finance reads the money of both businesses side by side; HQ reads the headline and
// what needs attention; each business's own division reads all of its metrics.
const ONLINE: readonly Division[] = ['online'];
const SALON: readonly Division[] = ['salon'];
const ONLINE_MONEY: readonly Division[] = ['online', 'finance'];
const SALON_MONEY: readonly Division[] = ['salon', 'finance'];
const ROWS = ['row', 'rows'] as const;
const ORDERS = ['order', 'orders'] as const;

export const METRICS: MetricDef[] = [
  { id: 'm:online.revenue.total', label: 'Online revenue, all lines, after discounts', unit: 'usd', business: 'online', divisions: ['online', 'finance', 'hq'], layer: 'period', source: 'orders', agg: { kind: 'sum', field: 'net_usd' } },
  ...PRODUCT_LINES.map((line): MetricDef => ({
    id: `m:online.revenue.${line}`, label: `Online ${LINE_LABEL[line]} revenue`, unit: 'usd', business: 'online', divisions: ONLINE_MONEY, layer: 'period', source: 'orders',
    agg: { kind: 'sum', field: 'net_usd' }, where: { product_line: line },
  })),
  { id: 'm:online.orders.count', label: 'Online orders', unit: 'count', business: 'online', divisions: ONLINE_MONEY, layer: 'period', source: 'orders', agg: { kind: 'count' }, nouns: ORDERS },
  { id: 'm:online.aov', label: 'Online average order value', unit: 'usd', business: 'online', divisions: ONLINE_MONEY, layer: 'period', source: 'orders', agg: { kind: 'avg', field: 'net_usd' } },
  { id: 'm:online.discounts.total', label: 'Online discounts given', unit: 'usd', business: 'online', divisions: ONLINE_MONEY, layer: 'period', source: 'orders', agg: { kind: 'sum', field: 'discount_usd' } },
  { id: 'm:online.gross_profit', label: 'Online gross profit', unit: 'usd', business: 'online', divisions: ['online', 'finance', 'hq'], layer: 'period', source: 'orders', agg: { kind: 'sum', field: profit } },
  { id: 'm:online.gross_margin', label: 'Online gross margin (profit / revenue)', unit: 'ratio', business: 'online', divisions: ONLINE_MONEY, layer: 'period', source: 'orders', agg: { kind: 'ratio', num: profit, den: 'net_usd' } },
  { id: 'm:online.dq.rejected_orders', label: 'Online order rows rejected by data checks', unit: 'count', business: 'online', divisions: ['online', 'hq'], layer: 'period', source: 'orders', agg: { kind: 'rejected' }, nouns: ROWS },
  // Version 1 has Google and Amazon; Meta joins in version 2 (its rows are a separate stream).
  ...AD_CHANNELS.flatMap((ch): MetricDef[] => {
    const name = CHANNEL_LABEL[ch];
    const since: Pick<MetricDef, 'since'> = ch === 'meta' ? { since: 2 } : {};
    const ad = { business: 'online', divisions: ONLINE_MONEY, layer: 'period', source: 'ads', where: { channel: ch }, ...since } as const;
    return [
      { id: `m:online.ads.${ch}.spend`, label: `${name} ad spend`, unit: 'usd', agg: { kind: 'sum', field: 'spend_usd' }, ...ad },
      { id: `m:online.ads.${ch}.revenue`, label: `${name} ad revenue`, unit: 'usd', agg: { kind: 'sum', field: 'revenue_usd' }, ...ad },
      { id: `m:online.ads.${ch}.roas`, label: `${name} ad return (revenue / spend)`, unit: 'ratio', agg: { kind: 'ratio', num: 'revenue_usd', den: 'spend_usd' }, ...ad },
      { id: `m:online.ads.${ch}.conversions`, label: `${name} ad orders`, unit: 'count', agg: { kind: 'sum', field: 'conversions' }, nouns: ORDERS, ...ad },
    ];
  }),
  { id: 'm:online.email.revenue', label: 'Email revenue', unit: 'usd', business: 'online', divisions: ONLINE_MONEY, layer: 'period', source: 'email', agg: { kind: 'sum', field: 'revenue_usd' } },
  { id: 'm:online.email.sends', label: 'Emails sent', unit: 'count', business: 'online', divisions: ONLINE, layer: 'period', source: 'email', agg: { kind: 'sum', field: 'sends' }, nouns: ['email', 'emails'] },
  { id: 'm:online.email.click_rate', label: 'Email click rate (clicks / sends)', unit: 'ratio', business: 'online', divisions: ONLINE, layer: 'period', source: 'email', agg: { kind: 'ratio', num: 'clicks', den: 'sends' } },
  { id: 'm:salon.revenue.total', label: 'Salon revenue, all services (completed appointments)', unit: 'usd', business: 'salon', divisions: ['salon', 'finance', 'hq'], layer: 'period', source: 'appointments', agg: { kind: 'sum', field: 'price_usd' }, where: done },
  ...SALON_SERVICES.map((s): MetricDef => ({
    id: `m:salon.revenue.${s}`, label: `Salon ${SERVICE_LABEL[s]} revenue`, unit: 'usd', business: 'salon', divisions: SALON_MONEY, layer: 'period', source: 'appointments',
    agg: { kind: 'sum', field: 'price_usd' }, where: { ...done, service: s },
  })),
  { id: 'm:salon.appointments.count', label: 'Salon completed appointments', unit: 'count', business: 'salon', divisions: SALON_MONEY, layer: 'period', source: 'appointments', agg: { kind: 'count' }, where: done, nouns: ['appointment', 'appointments'] },
  { id: 'm:salon.no_shows.count', label: 'Salon no-shows', unit: 'count', business: 'salon', divisions: SALON, layer: 'period', source: 'appointments', agg: { kind: 'count' }, where: { status: 'no_show' }, nouns: ['no-show', 'no-shows'] },
  { id: 'm:salon.avg_ticket', label: 'Salon average ticket', unit: 'usd', business: 'salon', divisions: SALON_MONEY, layer: 'period', source: 'appointments', agg: { kind: 'avg', field: 'price_usd' }, where: done },
  { id: 'm:salon.dq.rejected_appointments', label: 'Salon appointment rows rejected by data checks', unit: 'count', business: 'salon', divisions: ['salon', 'hq'], layer: 'period', source: 'appointments', agg: { kind: 'rejected' }, nouns: ROWS },
  // Version 2's appointment columns: the no-show rate, each location's revenue, online booking, and the
  // stylists' labor, so the salon has a profit beside the store's.
  {
    id: 'm:salon.no_show_rate', label: 'Salon no-show rate (no-shows over booked visits)', unit: 'ratio', business: 'salon', divisions: ['salon', 'hq'], layer: 'period', source: 'appointments',
    agg: { kind: 'ratio', num: oneIf({ sql: "status = 'no_show'", js: (r) => r.status === 'no_show' }), den: ONE }, since: 2,
  },
  ...SALON_LOCATIONS.map((loc): MetricDef => ({
    id: `m:salon.revenue.${loc}`, label: `Salon revenue, ${loc === 'brooklyn' ? 'Brooklyn' : 'Lakewood'}`, unit: 'usd', business: 'salon', divisions: SALON_MONEY, layer: 'period',
    source: 'appointments', agg: { kind: 'sum', field: 'price_usd' }, where: { ...done, location: loc }, since: 2,
  })),
  {
    id: 'm:salon.booked_online.share', label: 'Salon visits booked through the online store', unit: 'ratio', business: 'salon', divisions: SALON, layer: 'period', source: 'appointments',
    agg: { kind: 'ratio', num: oneIf({ sql: "booked_via = 'online'", js: (r) => r.booked_via === 'online' }), den: ONE }, where: done, since: 2,
  },
  { id: 'm:salon.labor_cost', label: 'Salon stylist labor cost', unit: 'usd', business: 'salon', divisions: SALON_MONEY, layer: 'period', source: 'appointments', agg: { kind: 'sum', field: 'labor_cost_usd' }, where: done, since: 2 },
  {
    id: 'm:salon.gross_profit', label: 'Salon gross profit after stylist labor', unit: 'usd', business: 'salon', divisions: ['salon', 'finance', 'hq'], layer: 'period', source: 'appointments',
    agg: { kind: 'sum', field: { sql: '(price_usd - labor_cost_usd)', js: (r) => num(r, 'price_usd') - num(r, 'labor_cost_usd') } }, where: done, since: 2,
    about: 'Completed visits: price less the stylist labor cost. Rent, products and front desk are not in it.',
  },
  // The finance owner's budget sheet (version 2). Only approved caps count; a proposed raise never does.
  ...AD_CHANNELS.map((ch): MetricDef => ({
    id: `m:online.budget.${ch}.cap`, label: `Approved ${CHANNEL_LABEL[ch]} ad budget`, unit: 'usd', business: 'online', divisions: ['finance'], layer: 'period',
    source: 'budgets', agg: { kind: 'sum', field: 'cap_usd' }, where: { channel: ch, status: 'approved' }, since: 2,
    about: 'The whole month\'s approved cap from the budget sheet, also for the month so far.',
  })),
  // The budget sheet lists only online ad channels, so its rejected rows are online business.
  { id: 'm:online.dq.rejected_budgets', label: 'Budget sheet rows rejected by data checks', unit: 'count', business: 'online', divisions: ['finance', 'hq'], layer: 'period', source: 'budgets', agg: { kind: 'rejected' }, nouns: ROWS, since: 2 },
  // The day-to-day systems (version 2): order fees and shipping, refunds, checkouts, inventory, the support
  // inbox, salon repair tickets and supplier invoices.
  ...OPS_METRICS,
];

export const METRIC_BY_ID = new Map(METRICS.map((m) => [m.id, m]));

/** What each version serves: its periods, its view, its sources (in view order) and its metrics. */
export const VERSIONS: Record<DataVersion, { periods: readonly Period[]; container: string; view: string; sources: readonly Source[]; metrics: readonly MetricDef[] }> = {
  1: {
    periods: DEFAULT_PERIODS, container: CONTAINER, view: FINANCE_VIEW,
    sources: ['orders', 'appointments', 'ads', 'email'], metrics: METRICS.filter((m) => !m.since),
  },
  2: {
    periods: PERIOD_KEYS, container: CONTAINER_V2, view: PERIOD_VIEW_V2,
    sources: ['orders', 'appointments', 'ads', 'email', 'budgets', ...OPS_SOURCE_NAMES], metrics: METRICS.filter((m) => m.layer === 'period'),
  },
};

/** The version FAHQ_DATA_VERSION names; 1 when unset. Anything else is a setup mistake and stops the start. */
export function dataVersionFromEnv(env: NodeJS.ProcessEnv): DataVersion {
  const value = env.FAHQ_DATA_VERSION ?? '1';
  if (value === '1' || value === '2') return Number(value) as DataVersion;
  throw new Error('FAHQ_DATA_VERSION must be 1 or 2');
}

// ---- SQL ----------------------------------------------------------------------------------

function periodCase(col: string, periods: readonly Period[]): string {
  return `CASE ${periods.map((p) => `WHEN ${col} BETWEEN '${PERIODS[p].from}' AND '${PERIODS[p].to}' THEN '${p}'`).join(' ')} END`;
}
const fieldSql = (f: Field) => (typeof f === 'string' ? f : f.sql);

// Conditional aggregates: each metric's filter goes inside its aggregate, so every source view is
// scanned once. (Spark rejects a query that unions the same LATERAL VIEW explode view with itself:
// MISSING_ATTRIBUTES.RESOLVED_ATTRIBUTE_APPEAR_IN_OPERATION, seen live 2026-10-26.)
export function aggSql(d: MetricDef, s: SourceSpec): string {
  const validSql = s.validSql;
  const filters = Object.entries(d.where ?? {}).map(([k, v]) => `${k} = '${v}'`);
  const test = d.test ? [`(${d.test.sql})`] : [];
  const window = d.window ? [`${s.date} >= '${d.window.from}'`, ...(d.window.to ? [`${s.date} <= '${d.window.to}'`] : [])] : [];
  const agg = d.agg;
  const cond = [...(agg.kind === 'rejected' ? [] : [`(${validSql})`]), ...filters, ...test, ...window].join(' AND ') || 'TRUE';
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
function sourceSelect(source: Source, version: DataVersion): string {
  const s = specOf(source, version);
  const { periods, container, metrics } = VERSIONS[version];
  const defs = metrics.filter((d) => d.source === source);
  const period = periodCase(s.date, periods);
  const [first, last] = [PERIODS[periods[0]!].from, PERIODS[periods[periods.length - 1]!].to];
  const wide = `SELECT ${period} AS period, ${defs.map((d, i) => `CAST(${aggSql(d, s)} AS DOUBLE) AS m${i}`).join(', ')} FROM ${container}.${s.table} WHERE ${s.date} BETWEEN '${first}' AND '${last}' GROUP BY ${period}`;
  return unpivot(defs, wide, source);
}

/** Turns a wide select (period, m0, m1, ...) into rows (period, metric_id, value), dropping NULLs. */
export function unpivot(defs: readonly { id: string }[], wide: string, name: string): string {
  const stack = `stack(${defs.length}, ${defs.map((d, i) => `'${d.id}', m${i}`).join(', ')}) AS (metric_id, value)`;
  return `SELECT period, metric_id, value FROM (SELECT period, ${stack} FROM (${wide}) w_${name}) s_${name} WHERE value IS NOT NULL`;
}

/** The body of a version's period view (version 1: fortune_hq.finance_metrics): one row per (period, metric). */
export function financeViewBody(version: DataVersion = 1): string {
  return VERSIONS[version].sources.map((s) => sourceSelect(s, version)).join('\nUNION ALL\n');
}

const servedPeriod = (period: Period, version: DataVersion) => {
  if (!VERSIONS[version].periods.includes(period)) throw new Error(`unknown period ${period}`);
};

export function financeQuery(period: Period, version: DataVersion = 1): string {
  servedPeriod(period, version);
  return `SELECT metric_id, value FROM ${VERSIONS[version].view} WHERE period = '${period}'`;
}

/** The same question asked of the version 1 Virtual Data Mart table instead of the view. */
export function martQuery(period: Period): string {
  servedPeriod(period, 1);
  return `SELECT metric_id, value FROM ${MART_VIEW} WHERE period = '${period}'`;
}

// ---- Oracle -------------------------------------------------------------------------------

const fieldJs = (f: Field) => (typeof f === 'string' ? (r: Row) => num(r, f) : f.js);
const sum = (rows: Row[], f: Field) => rows.reduce((t, r) => t + fieldJs(f)(r), 0);
export const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

/** Rows to compute from: a version 1 business, or version 2's year (which adds the budget sheet and the operations). */
export type SourceRows = SyntheticBusiness | SyntheticYear;

/** Each source's rows, by the name the metric definitions use (a version 1 business has none of version 2's). */
export function sourceRows(b: SourceRows): Record<Source, readonly Row[]> {
  const y = 'finance' in b ? b : undefined;
  return {
    orders: b.online.orders, appointments: b.salon.appointments, ads: b.marketing.ads, email: b.marketing.email,
    budgets: y?.finance.budgets ?? [], order_costs: y?.online.orderCosts ?? [], refunds: y?.online.refunds ?? [],
    checkouts: y?.online.checkouts ?? [], inventory: y?.online.inventory ?? [], messages: y?.support.messages ?? [],
    repairs: y?.salon.repairs ?? [], invoices: y?.finance.invoices ?? [],
  };
}

/**
 * One metric over the rows its SQL aggregates (a period's rows, or for a standing metric all of them), as
 * the SQL computes it. undefined is SQL's NULL: COUNT of nothing is 0; SUM, AVG and a ratio over nothing are
 * NULL, and NULL rows are dropped from the view. Version 2's appointments are checked by version 2's rule.
 */
export function aggregate(d: MetricDef, rows: readonly Row[], version: DataVersion): number | undefined {
  const s = specOf(d.source, version);
  const inWindow = (r: Row) => !d.window || (String(r[s.date]) >= d.window.from && (!d.window.to || String(r[s.date]) <= d.window.to));
  const matching = rows
    .filter((r) => d.agg.kind === 'rejected' || s.valid(r))
    .filter((r) => Object.entries(d.where ?? {}).every(([k, v]) => r[k] === v))
    .filter((r) => !d.test || d.test.js(r))
    .filter(inWindow);
  const a = d.agg;
  if (matching.length === 0 && (a.kind === 'sum' || a.kind === 'avg' || a.kind === 'ratio')) return undefined;
  // A ratio over a zero denominator is NULL in Zetaris (no row), as here.
  if (a.kind === 'ratio' && sum(matching, a.den) === 0) return undefined;
  return a.kind === 'sum' ? round(sum(matching, a.field), 2)
    : a.kind === 'avg' ? round(sum(matching, a.field) / matching.length, 2)
    : a.kind === 'count' ? matching.length
    : a.kind === 'ratio' ? round(sum(matching, a.num) / sum(matching, a.den), 4)
    : matching.filter((r) => !s.valid(r)).length;
}

/** One period's metric values, as the view's SQL computes them. */
function periodValues(rowsBySource: Record<Source, readonly Row[]>, period: Period, version: DataVersion): Map<string, number> {
  const { from, to } = PERIODS[period];
  const out = new Map<string, number>();
  for (const d of VERSIONS[version].metrics) {
    const s = SOURCES[d.source];
    const inPeriod = rowsBySource[d.source].filter((r) => String(r[s.date]) >= from && String(r[s.date]) <= to);
    if (inPeriod.length === 0) continue; // no GROUP BY row for this source and period
    const value = aggregate(d, inPeriod, version);
    if (value !== undefined) out.set(d.id, value);
  }
  return out;
}

/**
 * The oracle: every metric of a version for every period it serves, computed in TypeScript from the same
 * rows Zetaris reads. All periods at once, because a season index needs the whole year.
 */
export function computeAll(b: SourceRows, version: DataVersion = 2): Map<Period, Map<string, number>> {
  const rows = sourceRows(b);
  return new Map(VERSIONS[version].periods.map((p) => [p, periodValues(rows, p, version)]));
}
