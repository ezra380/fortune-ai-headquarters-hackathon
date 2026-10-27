import { z } from 'zod';
import { AssistantId, Timestamp } from '@fahq/contracts';

// The shape of a profile as it is stored in the database (public.assistant_profiles), and the rules a stored
// profile must meet before the worker uses it. A row that breaks a rule is not used: the assistant keeps
// the file profile, and the reason is reported (source.ts). Nothing here imports the rest of the package.

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

/** What a department may never read: the salon and the online store stay separate businesses. */
const NEVER_READS: Partial<Record<AssistantId, readonly string[]>> = {
  salon: ['get_online_metrics', 'get_finance_metrics'],
  online: ['get_salon_metrics', 'get_finance_metrics'],
  manager: ['get_finance_metrics'],
};

/**
 * The rules a schema cannot state. Returns a plain reason, or null when the row may be used.
 * `readNames` is the fixed list of read tools (an assistant can never be given anything else).
 */
export function checkProfileRow(row: Pick<ProfileRow, 'assistant_id' | 'reads' | 'skill'>, readNames: readonly string[]): string | null {
  const unknown = row.reads.find((name) => !readNames.includes(name));
  if (unknown) return `it reads "${unknown}", which is not a read tool`;
  if (new Set(row.reads).size !== row.reads.length) return 'it lists a read tool twice';
  const walled = row.reads.find((name) => NEVER_READS[row.assistant_id]?.includes(name));
  if (walled) return `the ${row.assistant_id} assistant may never read "${walled}"`;
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
