import { PERIOD_KEYS, type Period } from '@fahq/contracts';
import {
  CHANNEL_LABEL, CONTAINER_V2, PERIOD_VIEW_V2, aggSql, aggregate, computeAll, quoted, round, sourceRows, specOf, unpivot,
  type MetricAbout, type MetricDef, type Source, type SourceRows,
} from './finance-sql.ts';
import { CHANNEL_STANDING } from './channels.ts';
import { OPS_STANDING } from './operations.ts';
import { AD_CHANNELS, AS_OF, LAST_WEEK } from './synthetic.ts';

// Version 2's two layers above the period totals, each its own Zetaris view and its own statement:
// - derived: numbers made from other metrics: the budget left and used, revenue per ad dollar (same
//   period), and the season index (the month against the year around it). One view that reads the period
//   view once, never UNION'd with it (Spark rejects a statement that reads one exploded view twice).
// - standing: numbers as of the data date, whatever period is asked (period key 'standing').
// The oracle computes both again in TypeScript from the same rows, so setup can prove the views.

export { AS_OF };
/** The period key standing numbers carry. */
export const STANDING_PERIOD = 'standing';
export const DERIVED_VIEW_V2 = `${CONTAINER_V2}.derived_metrics`;
export const STANDING_VIEW_V2 = `${CONTAINER_V2}.standing_metrics`;

/** The twelve whole months: the season index averages over them; the month so far has no index of its own. */
const WHOLE_MONTHS: readonly Period[] = PERIOD_KEYS.filter((p) => p !== '2026-10-mtd');

type Formula =
  | { op: 'sum'; of: readonly string[] }
  /** a less the sum of b. */
  | { op: 'minus'; a: string; b: readonly string[] }
  | { op: 'ratio'; num: readonly string[]; den: readonly string[] }
  /** The metric's value in a whole month divided by its average over the twelve whole months. */
  | { op: 'month_index'; of: string }
  /** The named month index of the same month a year earlier (twelve periods back). */
  | { op: 'last_year'; index: string };

export type DerivedDef = MetricAbout & { layer: 'derived'; formula: Formula };

const spend = (ch: string) => `m:online.ads.${ch}.spend`;
const cap = (ch: string) => `m:online.budget.${ch}.cap`;
const FINANCE_HQ = ['finance', 'hq'] as const;
const BUSINESS_LABEL = { salon: 'Salon', online: 'Online' } as const;

export const DERIVED: DerivedDef[] = [
  ...AD_CHANNELS.flatMap((ch): DerivedDef[] => [
    {
      id: `m:online.budget.${ch}.room`, label: `${CHANNEL_LABEL[ch]} ad budget left (approved budget minus spend)`, unit: 'usd', business: 'online',
      divisions: FINANCE_HQ, layer: 'derived', since: 2, formula: { op: 'minus', a: cap(ch), b: [spend(ch)] },
      about: "Below zero when spend went over the approved budget. For the month so far: what is left of the whole month's budget.",
    },
    {
      id: `m:online.budget.${ch}.used`, label: `Share of the approved ${CHANNEL_LABEL[ch]} ad budget spent`, unit: 'ratio', business: 'online',
      divisions: FINANCE_HQ, layer: 'derived', since: 2, formula: { op: 'ratio', num: [spend(ch)], den: [cap(ch)] },
    },
  ]),
  {
    id: 'm:online.ads.total.spend', label: 'Ad spend, all channels', unit: 'usd', business: 'online', divisions: ['online', 'finance', 'hq'],
    layer: 'derived', since: 2, formula: { op: 'sum', of: AD_CHANNELS.map(spend) },
  },
  {
    id: 'm:online.mer', label: 'Online revenue per ad dollar, all channels', unit: 'ratio', business: 'online', divisions: ['online', 'finance', 'hq'],
    layer: 'derived', since: 2, formula: { op: 'ratio', num: ['m:online.revenue.total'], den: AD_CHANNELS.map(spend) },
  },
  {
    id: 'm:online.refund_rate', label: 'Online refunds against online revenue', unit: 'ratio', business: 'online', divisions: ['online', 'finance', 'hq'],
    layer: 'derived', since: 2, formula: { op: 'ratio', num: ['m:online.refunds.total'], den: ['m:online.revenue.total'] },
    about: 'Refunds issued in the period over revenue from orders placed in it, so a refund can fall in a later period than its order.',
  },
  {
    id: 'm:online.contribution', label: 'Online profit after payment fees, shipping, refunds and ad spend', unit: 'usd', business: 'online', divisions: FINANCE_HQ,
    layer: 'derived', since: 2,
    formula: { op: 'minus', a: 'm:online.gross_profit', b: ['m:online.fees.payment', 'm:online.shipping.cost', 'm:online.refunds.total', ...AD_CHANNELS.map(spend)] },
    about: 'Gross profit less payment fees, shipping labels, refunds issued and ad spend on all three channels, same period. Email, staff and rent are not in it.',
  },
  ...(['salon', 'online'] as const).flatMap((b): DerivedDef[] => [
    {
      id: `m:${b}.season.month_index`, label: `${BUSINESS_LABEL[b]} revenue of the month against the average month`, unit: 'ratio', business: b,
      divisions: [b, 'finance', 'hq'], layer: 'derived', since: 2, formula: { op: 'month_index', of: `m:${b}.revenue.total` },
      about: 'The month\'s revenue divided by the average of the twelve whole months, 2025-10 to 2026-09. The month so far has none.',
    },
    {
      id: `m:${b}.season.last_year_index`, label: `${BUSINESS_LABEL[b]} revenue of the same month last year against the average month`, unit: 'ratio',
      business: b, divisions: [b, 'finance', 'hq'], layer: 'derived', since: 2, formula: { op: 'last_year', index: `m:${b}.season.month_index` },
      about: 'The month index of the same month a year earlier. Only the month so far has one (its October a year before).',
    },
  ]),
];

export const STANDING_METRICS: MetricDef[] = [
  {
    id: 'm:online.revenue.last_7d', label: 'Online revenue in the last seven days, after discounts', unit: 'usd', business: 'online',
    divisions: ['online', 'finance', 'hq'], layer: 'standing', source: 'orders', agg: { kind: 'sum', field: 'net_usd' }, window: LAST_WEEK, since: 2,
    about: `The seven days ending on the data date, ${AS_OF}.`,
  },
  {
    id: 'm:salon.revenue.last_7d', label: 'Salon revenue in the last seven days (completed appointments)', unit: 'usd', business: 'salon',
    divisions: ['salon', 'finance', 'hq'], layer: 'standing', source: 'appointments', agg: { kind: 'sum', field: 'price_usd' },
    where: { status: 'completed' }, window: LAST_WEEK, since: 2, about: `The seven days ending on the data date, ${AS_OF}.`,
  },
  {
    id: 'm:online.budget.proposed.count', label: 'Proposed ad budget changes waiting for a decision', unit: 'count', business: 'online',
    divisions: FINANCE_HQ, layer: 'standing', source: 'budgets', agg: { kind: 'count' }, where: { status: 'proposed' },
    window: { from: `${AS_OF.slice(0, 7)}-01` }, nouns: ['change', 'changes', 'raise', 'raises'], since: 2,
    about: 'Proposed lines on the budget sheet for this month or later. A proposed cap never counts as approved.',
  },
  // The day-to-day systems: the inbox's waiting messages, open and late repairs, what is owed to suppliers.
  ...OPS_STANDING,
  // The channels (wave 2): each marketplace warehouse's stock on the data date.
  ...CHANNEL_STANDING,
];

// ---- SQL ----------------------------------------------------------------------------------

/** The period metrics a formula reads (a last-year index reads another derived metric, not the period view). */
const inputsOf = (f: Formula): readonly string[] =>
  f.op === 'sum' ? f.of : f.op === 'minus' ? [f.a, ...f.b] : f.op === 'ratio' ? [...f.num, ...f.den] : f.op === 'month_index' ? [f.of] : [];

/** Every period metric the derived view reads, in first-use order. */
export const DERIVED_INPUTS: readonly string[] = [...new Set(DERIVED.flatMap((d) => inputsOf(d.formula)))];

function formulaSql(f: Exclude<Formula, { op: 'last_year' }>, col: (id: string) => string): string {
  const plus = (ids: readonly string[]) => ids.map(col).join(' + ');
  switch (f.op) {
    case 'sum': return `ROUND(${plus(f.of)}, 2)`;
    case 'minus': return `ROUND(${col(f.a)} - (${plus(f.b)}), 2)`;
    case 'ratio': return `ROUND((${plus(f.num)}) / NULLIF(${plus(f.den)}, 0), 4)`;
    case 'month_index': {
      const whole = `period IN (${quoted(WHOLE_MONTHS)})`;
      return `CASE WHEN ${whole} THEN ROUND(${col(f.of)} / NULLIF(AVG(CASE WHEN ${whole} THEN ${col(f.of)} END) OVER (), 0), 4) END`;
    }
  }
}

/**
 * The derived view's body: the period view read once and pivoted to one row per period (i0, i1, ...), the
 * formulas over it (the season index's average is a window over all thirteen rows, so asking one period
 * still averages the year), then the last-year indexes as LAG(…, 12) in a layer of their own (a window
 * cannot sit inside another), then unpivoted.
 */
export function derivedViewBody(): string {
  const col = (id: string) => `i${DERIVED_INPUTS.indexOf(id)}`;
  const at = (id: string) => `m${DERIVED.findIndex((d) => d.id === id)}`;
  const pivot = `SELECT period, ${DERIVED_INPUTS.map((id, i) => `MAX(CASE WHEN metric_id = '${id}' THEN value END) AS i${i}`).join(', ')} FROM ${PERIOD_VIEW_V2} GROUP BY period`;
  const own = `SELECT period, ${DERIVED.flatMap((d, i) => (d.formula.op === 'last_year' ? [] : [`CAST(${formulaSql(d.formula, col)} AS DOUBLE) AS m${i}`])).join(', ')} FROM (${pivot}) p`;
  const lagged = `SELECT period, ${DERIVED.map((d, i) => (d.formula.op === 'last_year' ? `LAG(${at(d.formula.index)}, 12) OVER (ORDER BY period) AS m${i}` : `m${i}`)).join(', ')} FROM (${own}) o`;
  return unpivot(DERIVED, lagged, 'derived');
}

/** One source's standing numbers: every row of the source, no period, one scan. */
function standingSelect(source: Source): string {
  const s = specOf(source, 2);
  const defs = STANDING_METRICS.filter((d) => d.source === source);
  const wide = `SELECT '${STANDING_PERIOD}' AS period, ${defs.map((d, i) => `CAST(${aggSql(d, s)} AS DOUBLE) AS m${i}`).join(', ')} FROM ${CONTAINER_V2}.${s.table}`;
  return unpivot(defs, wide, source);
}

/** The standing view's body: one select per source that has a standing metric, UNION ALL'd. */
export function standingViewBody(): string {
  return [...new Set(STANDING_METRICS.map((d) => d.source))].map(standingSelect).join('\nUNION ALL\n');
}

// ---- Oracle -------------------------------------------------------------------------------

/** Every version 2 number, layer by layer, computed in TypeScript from the same rows Zetaris reads. */
export type Layers = {
  period: Map<Period, Map<string, number>>;
  derived: Map<Period, Map<string, number>>;
  standing: Map<string, number>;
};

/** One formula for one period; undefined (SQL's NULL) when an input is missing or a divisor is zero. */
function formulaValue(f: Exclude<Formula, { op: 'last_year' }>, period: Period, value: (p: Period, id: string) => number | undefined): number | undefined {
  const all = (ids: readonly string[]) => {
    const xs = ids.map((id) => value(period, id));
    return xs.every((x) => x !== undefined) ? (xs as number[]).reduce((t, x) => t + x, 0) : undefined;
  };
  if (f.op === 'sum') { const s = all(f.of); return s === undefined ? undefined : round(s, 2); }
  if (f.op === 'minus') { const [a, b] = [value(period, f.a), all(f.b)]; return a === undefined || b === undefined ? undefined : round(a - b, 2); }
  if (f.op === 'ratio') { const [n, d] = [all(f.num), all(f.den)]; return n === undefined || !d ? undefined : round(n / d, 4); }
  if (!WHOLE_MONTHS.includes(period)) return undefined;
  const x = value(period, f.of);
  const year = WHOLE_MONTHS.map((p) => value(p, f.of)).filter((v): v is number => v !== undefined);
  const mean = year.reduce((t, v) => t + v, 0) / year.length;
  return x === undefined || !mean ? undefined : round(x / mean, 4);
}

export function computeDerived(period: Map<Period, Map<string, number>>): Map<Period, Map<string, number>> {
  const value = (p: Period, id: string) => period.get(p)?.get(id);
  const out = new Map(PERIOD_KEYS.map((p) => [p, new Map<string, number>()]));
  for (const p of PERIOD_KEYS) {
    for (const d of DERIVED) {
      if (d.formula.op === 'last_year') continue;
      const v = formulaValue(d.formula, p, value);
      if (v !== undefined) out.get(p)!.set(d.id, v);
    }
  }
  PERIOD_KEYS.forEach((p, i) => {
    for (const d of DERIVED) {
      if (d.formula.op !== 'last_year' || i < 12) continue;
      const v = out.get(PERIOD_KEYS[i - 12]!)!.get(d.formula.index);
      if (v !== undefined) out.get(p)!.set(d.id, v);
    }
  });
  return out;
}

export function computeStanding(b: SourceRows): Map<string, number> {
  const rows = sourceRows(b);
  const out = new Map<string, number>();
  for (const d of STANDING_METRICS) {
    const v = aggregate(d, rows[d.source], 2);
    if (v !== undefined) out.set(d.id, v);
  }
  return out;
}

export function computeLayers(b: SourceRows): Layers {
  const period = computeAll(b, 2);
  return { period, derived: computeDerived(period), standing: computeStanding(b) };
}
