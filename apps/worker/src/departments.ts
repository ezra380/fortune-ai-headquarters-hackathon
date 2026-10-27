import type { AssistantId, Metric, MetricInfo } from '@fahq/contracts';

// The departments that propose when the owner asks for plans. Each is an expert on its own data: the metrics
// its division reads (the data's catalog says who reads each one): finance the money of both businesses side
// by side, the salon the salon's, online the online store's. A port without divisions: finance reads every
// metric, the others their own business.

export type Department = 'finance' | 'salon' | 'online';

/** The order a round asks them in. */
export const ROUND_DEPARTMENTS: readonly Department[] = ['finance', 'salon', 'online'];
/** The order a plan is picked by rule when Owner HQ's model cannot pick (finance, online, salon). */
export const RULE_ORDER: readonly Department[] = ['finance', 'online', 'salon'];

export const DEPARTMENT_LABEL: Record<Department, string> = { finance: 'Finance', salon: 'Salon', online: 'Online' };

export const isDepartment = (value: unknown): value is Department => ROUND_DEPARTMENTS.includes(value as Department);

/** Who is asked for a round: Owner HQ and the manager mean everyone; a department means only itself. */
export function departmentsFor(target: AssistantId): Department[] {
  return isDepartment(target) ? [target] : [...ROUND_DEPARTMENTS];
}

/**
 * The metrics a department may plan from: the ones its division reads, never one the catalog keeps out of plan
 * writing (planUse false: the validator cannot check its kind of number yet). A metric the catalog does not
 * know is left out when the catalog has divisions.
 */
export function sliceFor(department: Department, metrics: readonly Metric[], catalog: readonly MetricInfo[] = []): Metric[] {
  const info = new Map(catalog.map((m) => [m.id, m]));
  const byDivision = catalog.some((m) => m.divisions !== undefined);
  return metrics.filter((m) => {
    if (info.get(m.id)?.planUse === false) return false;
    if (byDivision) return info.get(m.id)?.divisions?.includes(department) ?? false;
    return department === 'finance' || m.business === department;
  });
}

/** The one line added to the plan writer's rules to name the department and its data. */
export function departmentLine(department: Department): string {
  const data = department === 'finance'
    ? 'the money metrics of both businesses provided, side by side (salon, online and combined)'
    : `only the ${department} metrics provided (the ${department === 'salon' ? 'online' : 'salon'} business is not yours to plan for)`;
  return `You are writing as the ${DEPARTMENT_LABEL[department]} department. Your data is ${data}.`;
}

/** Where one of the final three plans came from. */
export type Origin = { rank: number; department: Department; originalRank: number; proposalId: string };

/** The origins stored on a final proposal; an older proposal, or a malformed entry, has none. */
export function originsOf(body: Record<string, unknown>): Origin[] {
  if (!Array.isArray(body.origins)) return [];
  return body.origins.filter((o): o is Origin =>
    typeof o === 'object' && o !== null && isDepartment((o as Origin).department)
    && Number.isInteger((o as Origin).rank) && Number.isInteger((o as Origin).originalRank) && typeof (o as Origin).proposalId === 'string');
}
