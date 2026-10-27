import { z } from 'zod';
import { AssistantId, Timestamp } from '@fahq/contracts';
import type { ReadToolName } from './index.ts';

// The shape of a profile as it is stored in the database (public.assistant_profiles), and the rules a stored
// profile must meet before the worker uses it. A row that breaks a rule is not used: the assistant keeps
// the file profile, and the reason is reported (source.ts). Nothing here imports the rest of the package at run time
// (the tool names are a type only).

export const ProfileLesson = z.object({
  text: z.string().min(1).max(300),
  /** What the lesson came from, e.g. a recommendation id. */
  source: z.string().min(1).max(100),
  adoptedAt: Timestamp,
  /**
   * Who put it in the profile: the owner (with his one-time code) or the HQ Manager (by itself). A lesson with no
   * record of that reads as the manager's, the less trusted of the two, and is shown to a model as such (source.ts).
   */
  by: z.enum(['manager', 'owner']).default('manager'),
});
export type ProfileLesson = z.infer<typeof ProfileLesson>;

const MODEL_JOBS = ['route', 'code', 'answer', 'plan', 'review'] as const;
const ModelSettingRow = z.object({
  model: z.string().min(1).max(120),
  thinking: z.boolean(),
  maxTokens: z.number().int().min(1).max(64_000),
  temperature: z.number().min(0).max(2),
}).strict();

export const ProfileRow = z.object({
  assistant_id: AssistantId,
  version: z.number().int().min(1),
  title: z.string().min(1).max(80),
  skill: z.string().min(40).max(12_000),
  reads: z.array(z.string().min(1).max(60)).max(30),
  models: z.partialRecord(z.enum(MODEL_JOBS), ModelSettingRow),
  lessons: z.array(ProfileLesson).max(50),
  updated_at: z.coerce.date(),
  updated_by: z.enum(['seed', 'manager', 'owner']),
});
export type ProfileRow = z.infer<typeof ProfileRow>;

/**
 * Whose business data a read tool can return: the salon's, the online store's, both (or every assistant's), or none from
 * another division (no business data, or only the caller's own: its memory, or a tool that walls itself by caller).
 */
export type ReadScope = 'salon' | 'online' | 'both' | 'none';

/** Every read tool's scope. Keyed by ReadToolName, so a tool added to READ_TOOL_NAMES (index.ts) does not compile without one. */
export const READ_SCOPE: Readonly<Record<ReadToolName, ReadScope>> = {
  get_finance_metrics: 'both', get_online_metrics: 'online', get_salon_metrics: 'salon',
  recall_my_decisions: 'none', recall_decisions: 'both', my_lessons: 'none', list_lessons: 'both',
  get_timeline: 'none', usage_summary: 'none', open_items: 'none', // ids, times and counts per assistant: no business data
  list_work_reports: 'both', latest_proposal: 'both', explain_proposal: 'both',
  list_session_reports: 'none', // walls itself: a department reads its own door's reports (read-tools.ts)
  get_budget_room: 'online', get_metric_series: 'none', // walls itself by caller (SERIES_DIVISIONS in read-tools.ts)
  get_company_overview: 'both', get_data_quality: 'both', get_repair_tickets: 'salon', get_supplier_invoices: 'both',
  get_waiting_conversations: 'online', get_low_stock_interest: 'online',
};

/** The read tools that return money. The HQ Manager reviews the work and never reads them. */
export const MONEY_READS: readonly ReadToolName[] = ['get_finance_metrics', 'get_budget_room', 'get_company_overview', 'get_supplier_invoices'];

/**
 * What an assistant may never read, from the scopes: the salon and the online store stay separate businesses (neither
 * reads the other's data or both), and the manager reads no money. A name with no scope is walled.
 */
function walled(assistant: AssistantId, name: string): boolean {
  const scope = Object.hasOwn(READ_SCOPE, name) ? READ_SCOPE[name as ReadToolName] : undefined;
  if (assistant === 'salon' || assistant === 'online') return scope !== assistant && scope !== 'none';
  return assistant === 'manager' && (MONEY_READS as readonly string[]).includes(name);
}

/**
 * The rules a schema cannot state. Returns a plain reason, or null when the row may be used.
 * `readNames` is the fixed list of read tools (an assistant can never be given anything else).
 */
export function checkProfileRow(row: Pick<ProfileRow, 'assistant_id' | 'reads' | 'skill'>, readNames: readonly string[]): string | null {
  const unknown = row.reads.find((name) => !readNames.includes(name));
  if (unknown) return `it reads "${unknown}", which is not a read tool`;
  if (new Set(row.reads).size !== row.reads.length) return 'it lists a read tool twice';
  const wall = row.reads.find((name) => walled(row.assistant_id, name));
  if (wall) return `the ${row.assistant_id} assistant may never read "${wall}"`;
  if (!/read-only/i.test(row.skill)) return 'its skill no longer says the assistant is read-only';
  if (!/^## You never$/m.test(row.skill)) return 'its skill has lost the "You never" section';
  return null;
}

export type ParsedProfileRows = { rows: Map<AssistantId, ProfileRow>; problems: string[] };

/** Validates every raw row. A bad row is left out and explained; the good ones are returned by assistant. */
export function parseProfileRows(raw: readonly unknown[], readNames: readonly string[]): ParsedProfileRows {
  const rows = new Map<AssistantId, ProfileRow>();
  const problems: string[] = [];
  for (const item of raw) {
    const who = AssistantId.safeParse((item as { assistant_id?: unknown } | null)?.assistant_id);
    const name = who.success ? who.data : 'a row';
    const parsed = ProfileRow.safeParse(item);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      problems.push(`the stored profile of ${name} is not valid (${issue?.path.join('.') || 'row'}: ${issue?.message ?? 'unreadable'}); the files are used`);
      continue;
    }
    const reason = checkProfileRow(parsed.data, readNames);
    if (reason) problems.push(`the stored profile of ${name} was refused: ${reason}; the files are used`);
    else rows.set(parsed.data.assistant_id, parsed.data);
  }
  return { rows, problems };
}
