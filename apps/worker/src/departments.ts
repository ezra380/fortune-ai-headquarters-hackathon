import type { AssistantId, Metric } from '@fahq/contracts';

// The departments that propose when the owner asks for plans. Each is an expert on its own data:
// finance reads every metric, the salon only the salon's, online only the online store's.

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

/** The metrics a department may plan from. */
export function sliceFor(department: Department, metrics: readonly Metric[]): Metric[] {
  return department === 'finance' ? [...metrics] : metrics.filter((m) => m.business === department);
}

/** The one line added to the plan writer's rules to name the department and its data. */
export function departmentLine(department: Department): string {
  const data = department === 'finance'
    ? 'every metric provided (salon, online and combined)'
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
