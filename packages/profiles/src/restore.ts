import { AssistantId } from '@fahq/contracts';
import { ProfileRow, checkProfileRow } from './rows.ts';
import type { Queryable } from './seed.ts';

// Puts an earlier version of a profile back, as a NEW version (the history is append-only; nothing is edited or
// removed). This is how any change the HQ Manager or the owner made is undone: the manager's lessons and notes, and the
// read tools and models the owner approved, are all in the version history with who made them and why.

export type RestoreResult = { assistant: AssistantId; restored: number; replaced: number; version: number };

/**
 * Copies version `version` of a profile (its title, skill, read tools, models and lessons) into a new version made by
 * 'owner', guarded by the version the profile is at now. Refuses, in plain words, a version that does not exist, one
 * that no longer passes the rules every stored profile must (a read tool that has been removed, say), or a profile that
 * changed while it was being restored (run it again). `readNames` is the fixed list of read tools.
 */
export async function restoreVersion(
  db: Queryable, assistant: AssistantId, version: number, options: { readNames: readonly string[]; now?: Date },
): Promise<RestoreResult> {
  if (!AssistantId.safeParse(assistant).success) throw new Error(`"${assistant}" is not an assistant`);
  if (!Number.isInteger(version) || version < 1) throw new Error('the version to put back must be a whole number from 1');
  const found = await db.query('select snapshot from public.assistant_profile_versions where assistant_id = $1 and version = $2', [assistant, version]);
  const snapshot = found.rows[0]?.snapshot;
  if (!snapshot) throw new Error(`the ${assistant} profile has no version ${version}`);
  const current = await db.query('select version from public.assistant_profiles where assistant_id = $1', [assistant]);
  const replaced = current.rows[0]?.version as number | undefined;
  if (replaced === undefined) throw new Error(`the ${assistant} profile is not stored, so there is nothing to put back`);

  // The old version must still be a profile the worker would use today.
  const parsed = ProfileRow.omit({ assistant_id: true, version: true, updated_at: true, updated_by: true }).safeParse(snapshot);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`version ${version} of the ${assistant} profile cannot be read any more (${issue?.path.join('.') || 'row'}: ${issue?.message ?? 'unreadable'})`);
  }
  const { title, skill, reads, models, lessons } = parsed.data;
  const reason = checkProfileRow({ assistant_id: assistant, reads, skill }, options.readNames);
  if (reason) throw new Error(`version ${version} of the ${assistant} profile would not be accepted today: ${reason}`);

  const saved = await db.query(
    `select public.save_assistant_profile($1::public.assistant_id, $2::integer, $3, $4, $5::text[], $6::jsonb, $7::jsonb, 'owner', $8, $9::jsonb, $10::timestamptz) as version`,
    [assistant, replaced, title, skill, reads, JSON.stringify(models), JSON.stringify(lessons), `put back version ${version}`, JSON.stringify({ kind: 'restore', restored: version, from: replaced }), (options.now ?? new Date()).toISOString()],
  );
  const written = saved.rows[0]?.version as number | null | undefined;
  if (written === null || written === undefined) throw new Error(`the ${assistant} profile changed while version ${version} was being put back; run it again`);
  return { assistant, restored: version, replaced, version: written };
}
