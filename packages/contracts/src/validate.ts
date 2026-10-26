import { ProfitPlans as ProfitPlansSchema } from './schemas.ts';
import type { BusinessUnit, Metric, Plan, ProfitPlans } from './schemas.ts';

// "No invented numbers": every number a plan states must trace to a Zetaris metric.
//  - Evidence must equal the metric it cites (within 0.5%).
//  - A projection must equal its base metric × its factor (within 1%).
//  - Money and percentages in the prose must be one of the plan's cited or projected numbers, or a
//    declared lever (a proposed price, discount, budget or count, which is a choice, not a fact);
//    bare numbers of 100 or more are checked too. Durations ("90 days") and years are not claims.
//  - A plan declares which businesses it touches, and it must cite numbers from exactly those.
//    Salon and online are never summed in prose unless a labeled `m:combined.*` metric exists.

export type PlanCheck =
  | { ok: true; plans: ProfitPlans; citedMetricIds: string[] }
  | { ok: false; errors: string[] };

export function checkPlans(raw: unknown, metrics: readonly Metric[]): PlanCheck {
  const parsed = ProfitPlansSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || 'plans'}: ${i.message}`),
    };
  }
  const byId = new Map(metrics.map((m) => [m.id, m]));
  const errors: string[] = [];
  const cited = new Set<string>();
  const ranks = parsed.data.plans.map((p) => p.rank).sort((a, b) => a - b);
  if (ranks.join(',') !== '1,2,3') errors.push('plans must be ranked 1, 2 and 3, once each');
  for (const plan of parsed.data.plans) checkPlan(plan, byId, errors, cited);
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, plans: parsed.data, citedMetricIds: [...cited] };
}

function checkPlan(
  plan: Plan,
  byId: ReadonlyMap<string, Metric>,
  errors: string[],
  cited: Set<string>,
): void {
  const where = `plan ${plan.rank}`;
  const values: number[] = [];
  const percents: number[] = [];
  const units = new Set<BusinessUnit>();

  for (const e of plan.evidence) {
    const m = byId.get(e.metricId);
    if (!m) {
      errors.push(`${where}: evidence cites unknown metric ${e.metricId}`);
      continue;
    }
    cited.add(m.id);
    units.add(m.business);
    if (!close(e.value, m.value, 0.005)) {
      errors.push(`${where}: evidence ${m.id} says ${e.value} but the source says ${m.value}`);
    }
    values.push(m.value);
    if (m.unit === 'percent') percents.push(m.value);
    if (m.unit === 'ratio') percents.push(m.value * 100);
  }

  for (const p of plan.projections) {
    const m = byId.get(p.baseMetricId);
    if (!m) {
      errors.push(`${where}: projection "${p.label}" uses unknown metric ${p.baseMetricId}`);
      continue;
    }
    cited.add(m.id);
    units.add(m.business);
    const expected = m.value * p.factor;
    if (!close(p.result, expected, 0.01)) {
      errors.push(`${where}: projection "${p.label}" says ${p.result} but ${m.id} × ${p.factor} = ${round2(expected)}`);
    }
    values.push(m.value, p.result);
    percents.push(p.factor * 100, (p.factor - 1) * 100, (1 - p.factor) * 100);
  }

  // Levers are the plan's own proposed settings: allowed in the text, shown as choices, never as facts.
  for (const l of plan.levers) {
    if (l.unit === 'percent') percents.push(l.value);
    else values.push(l.value);
  }

  const declared = new Set(plan.businesses);
  for (const u of units) {
    if (!declared.has(u)) errors.push(`${where}: cites ${u} numbers but does not list "${u}" in businesses`);
  }
  for (const u of declared) {
    if (!units.has(u)) errors.push(`${where}: lists "${u}" but cites no ${u} numbers`);
  }

  const prose = [plan.title, plan.summary, ...plan.actions, plan.test, plan.stopLoss, ...plan.risks].join('\n');
  for (const n of numbersIn(prose)) {
    const pool = n.percent ? percents : values;
    if (!pool.some((v) => close(n.value, v, n.percent ? 0.02 : 0.01))) {
      errors.push(`${where}: "${n.raw}" in the text is not one of its cited or projected numbers`);
    }
  }
}

type FoundNumber = { raw: string; value: number; percent: boolean };

const NUMBER = /(\$\s?)?(-?\d{1,3}(?:,\d{3})+|-?\d+)(\.\d+)?\s?(%|[kK]\b)?(?:[\s-]*(days?|weeks?|months?|hours?|minutes?|years?|am|pm)\b)?/g;

/** Numbers that read as claims: money, percentages, and bare numbers of 100 or more. */
export function numbersIn(text: string): FoundNumber[] {
  const found: FoundNumber[] = [];
  for (const match of text.matchAll(NUMBER)) {
    const [raw, dollar, whole, fraction, suffix, timeWord] = match;
    if (timeWord || whole === undefined) continue;
    let value = Number(whole.replaceAll(',', '') + (fraction ?? ''));
    if (!Number.isFinite(value)) continue;
    const percent = suffix === '%';
    if (suffix === 'k' || suffix === 'K') value *= 1000;
    const isYear = !dollar && !percent && !fraction && value >= 1900 && value <= 2100;
    if (isYear) continue;
    if (!dollar && !percent && Math.abs(value) < 100) continue;
    found.push({ raw: raw.trim(), value, percent });
  }
  return found;
}

function close(a: number, b: number, relative: number): boolean {
  return Math.abs(a - b) <= Math.max(0.01, relative * Math.abs(b));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
