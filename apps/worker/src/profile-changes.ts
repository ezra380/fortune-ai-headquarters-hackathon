import { AssistantId, RecommendationDetail, type TypedRecommendation } from '@fahq/contracts';
import { KIND_LABEL, ProfileRow, READ_TOOL_NAMES, applyProfileChange, changeOf, lessonAddedBy, managerNotes, type ProfileChange, type ProfileContent } from '@fahq/profiles';
import type { WorkerDeps } from './common.ts';
import type { PersonRow, RecommendationRow } from './store.ts';

// Putting one recommendation into force in the assistant's stored profile. The owner's code applies every kind
// (ADOPT). The HQ Manager applies by itself only the kinds MANAGER_APPLIES names (a lesson, a skill note, a retire),
// and only where the review's rules allow it (manager.ts decides that, never the model). Either way the change is a
// new profile version (save_assistant_profile) that records who made it and its words, and the recommendation is
// marked in force. A retried task finds out what an earlier run already did:
//  - the version a recommendation made is looked up in the history before anything is written;
//  - a write is guarded by the version the profile was read at, so a second writer is told and reads again.

const JOBS = ['route', 'code', 'answer', 'plan', 'review'] as const;
const MAX_TRIES = 3;
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

export type Actor = { by: 'manager' } | { by: 'owner'; person: PersonRow };

export type Applied =
  /** In force: written now, or already (by an earlier run, or because the profile already said it). */
  | { status: 'in_force'; version: number | null; changed: boolean; dropped: string[]; earlier: boolean }
  /** The program would not apply it, for this plain reason; the recommendation is closed. */
  | { status: 'refused'; reason: string }
  /** The manager may not apply it by itself (a retire of what the owner put there); it stays open for his code. */
  | { status: 'held'; reason: string }
  /** It could not be applied now (no stored profile to change); the recommendation stays open. */
  | { status: 'unavailable'; reason: string };

/** The models the jobs of all five assistants use today: a model change may only move a job to one of these. */
export function modelsInUse(deps: Pick<WorkerDeps, 'profiles'>): string[] {
  const found = new Set<string>();
  for (const id of AssistantId.options) {
    for (const job of JOBS) {
      try {
        found.add(deps.profiles.model(id, job));
      } catch { /* this assistant does not do that job */ }
    }
  }
  return [...found].sort();
}

/** What the worker is running an assistant on now, in the shape a change is applied to (a dry run for a review). */
export function currentContent(deps: Pick<WorkerDeps, 'profiles'>, id: AssistantId): ProfileContent {
  const models: ProfileContent['models'] = {};
  for (const job of JOBS) {
    try {
      models[job] = { model: deps.profiles.model(id, job), thinking: false, maxTokens: 1, temperature: 0 };
    } catch { /* this assistant does not do that job */ }
  }
  return { assistant_id: id, title: id, skill: deps.profiles.skill(id), reads: [...deps.profiles.reads(id)], models, lessons: [] };
}

/** What the review writer is told about the profiles: the tools that exist, the models in use, and what each assistant has. */
export function profilesOverview(deps: Pick<WorkerDeps, 'profiles'>) {
  return {
    readToolNames: [...READ_TOOL_NAMES],
    modelsInUse: modelsInUse(deps),
    assistants: Object.fromEntries(AssistantId.options.map((id) => {
      const { reads, models } = currentContent(deps, id);
      return [id, { reads, models: Object.fromEntries(Object.entries(models).map(([job, setting]) => [job, setting?.model])) }];
    })),
  };
}

/** The recommendation as a typed change; a model recommendation without its job and model has no such change. */
function changeFor(rec: Pick<RecommendationRow, 'kind' | 'change' | 'detail'>): ProfileChange | string {
  const detail = RecommendationDetail.safeParse(rec.detail);
  try {
    return changeOf({
      kind: rec.kind, change: rec.change,
      reads: detail.success ? detail.data.reads : undefined, model: detail.success ? detail.data.model : undefined, retire: detail.success ? detail.data.retire : undefined,
    });
  } catch (error) {
    return error instanceof Error ? error.message : 'the change is not readable';
  }
}

// ---- Who put a lesson or a note there --------------------------------------------------------------

export type Author = 'manager' | 'owner';
type NoteRecord = { assistant_id: AssistantId; change: string; applied_by: Author | null; applied_version: number | null };

/**
 * Who added a note to the skill's "Notes from the HQ Manager". A note records it through the recommendation that wrote
 * it (applied_by, with the version it wrote). The manager's only when the manager wrote these exact words and the owner
 * never adopted them; anything else (a note written by hand, a reseed, no record) is the owner's, so it fails closed.
 */
export function noteAddedBy(records: readonly NoteRecord[], assistant: AssistantId, text: string): Author {
  const same = records.filter((r) => r.assistant_id === assistant && r.change.trim() === text.trim());
  const wroteIt = same.some((r) => r.applied_by === 'manager' && r.applied_version !== null);
  return wroteIt && !same.some((r) => r.applied_by === 'owner') ? 'manager' : 'owner';
}

/** Each assistant's standing lessons (the newest 20) and notes, with who put each there: what a retire may name. */
export type Standing = Partial<Record<AssistantId, { lessons: { text: string; by: Author }[]; notes: { text: string; by: Author }[] }>>;

const SHOWN_LESSONS = 20;

/** What each stored profile holds now, for the review writer. An assistant with no stored profile is left out. */
export async function standingOf(deps: Pick<WorkerDeps, 'store'>): Promise<Standing> {
  const records = await deps.store.skillNotesInForce();
  const standing: Standing = {};
  for (const id of AssistantId.options) {
    const raw = await deps.store.profileRow(id);
    const row = raw === null ? null : ProfileRow.safeParse(raw);
    if (!row?.success) continue;
    const rawLessons = (raw as { lessons?: unknown }).lessons;
    standing[id] = {
      lessons: row.data.lessons.slice(-SHOWN_LESSONS).map((l) => ({ text: l.text, by: lessonAddedBy(rawLessons, l.text) ?? 'owner' })),
      notes: managerNotes(row.data.skill).map((text) => ({ text, by: noteAddedBy(records, id, text) })),
    };
  }
  return standing;
}

/**
 * Who put the lesson or note a retire names into this stored row (as the database holds it), or null when the row does
 * not hold it. A retire applies by itself only when the answer is 'manager'; the write asks this of the very row its
 * version guard is based on, so an owner who adopts the same words in between is never overruled.
 */
async function retireAuthorIn(deps: Pick<WorkerDeps, 'store'>, raw: unknown, assistant: AssistantId, retire: { target: 'lesson' | 'note'; text: string }): Promise<Author | null> {
  const text = retire.text.trim();
  if (retire.target === 'lesson') return lessonAddedBy((raw as { lessons?: unknown } | null)?.lessons, text);
  const row = ProfileRow.safeParse(raw);
  if (!row.success || !managerNotes(row.data.skill).includes(text)) return null;
  return noteAddedBy(await deps.store.skillNotesInForce(assistant), assistant, text);
}

/** Why a retire the manager would apply waits for the owner's code. */
export const OWNERS_TO_RETIRE = 'the owner put it there, so taking it out is his decision';

/**
 * A plain reason a recommendation, as the review model wrote it, would not apply to what the assistant runs on now
 * (a note that breaks a rule, a tool the assistant may never read, a model no job uses, a retire of words the profile
 * does not hold), or that it changes nothing. Null when it would apply. Used by the review's own check, so the model
 * gets one correction round. A retire is checked against `standing` (the stored profiles); the write checks it again.
 * Every reason is in the program's words and never quotes the model's: an objection lands on the review's receipt and
 * from there in its work report, which the internal review reads, and a doors review's model has read outside words.
 */
export function objectionToChange(deps: Pick<WorkerDeps, 'profiles'>, rec: TypedRecommendation, now: Date, standing?: Standing): string | null {
  const change = changeFor({ kind: rec.kind, change: rec.change, detail: { ...(rec.reads ? { reads: rec.reads } : {}), ...(rec.model ? { model: rec.model } : {}), ...(rec.retire ? { retire: rec.retire } : {}) } });
  if (typeof change === 'string') return change;
  if (change.kind === 'retire') {
    const held = standing?.[rec.assistant];
    if (!held) return `the ${rec.assistant} profile is not stored, so there is nothing to retire`;
    const list = change.target === 'lesson' ? held.lessons : held.notes;
    return list.some((item) => item.text.trim() === change.text.trim())
      ? null
      : `the retire names words that are not a ${change.target === 'lesson' ? 'standing lesson' : 'note'} of ${rec.assistant}; copy the text exactly from standing`;
  }
  if (change.kind === 'reads' && [...change.add, ...change.remove].some((name) => !(READ_TOOL_NAMES as readonly string[]).includes(name))) {
    return 'it names a read tool that does not exist; use only names in profiles.readToolNames';
  }
  if (change.kind === 'model' && !modelsInUse(deps).includes(change.model)) {
    return 'it names a model no job uses today; use only a name in profiles.modelsInUse';
  }
  const result = applyProfileChange(currentContent(deps, rec.assistant), change, {
    readNames: READ_TOOL_NAMES, knownModels: modelsInUse(deps), source: 'review-check', by: 'owner', now,
  });
  if (!result.ok) return result.reason;
  return result.changed ? null : 'the assistant already has this';
}

const reasonFor = (rec: RecommendationRow, actor: Actor) =>
  clip(`${actor.by === 'manager' ? 'The HQ Manager applied' : `${actor.person.name} adopted`} a ${KIND_LABEL[rec.kind]}: ${rec.why}`, 300);

/**
 * Puts one open recommendation into force. A closed one comes back as it stands (in force earlier, or refused).
 * Throws when a stored profile keeps changing under it (the task runs again) or the database fails.
 */
export async function applyRecommendation(deps: WorkerDeps, rec: RecommendationRow, actor: Actor): Promise<Applied> {
  if (rec.status === 'expired') {
    const refused = RecommendationDetail.safeParse(rec.detail);
    return { status: 'refused', reason: refused.success && refused.data.refused ? refused.data.refused : 'it is closed' };
  }
  if (rec.status === 'adopted') return { status: 'in_force', version: rec.applied_version, changed: rec.applied_version !== null, dropped: [], earlier: true };

  const change = changeFor(rec);
  const person = actor.by === 'owner' ? actor.person.id : null;
  const detail = RecommendationDetail.safeParse(rec.detail);
  const refuse = async (reason: string): Promise<Applied> => {
    await deps.store.refuseRecommendation(rec.id, { ...(detail.success ? detail.data : {}), refused: clip(reason, 300) });
    return { status: 'refused', reason: clip(reason, 300) };
  };
  if (typeof change === 'string') return refuse(change);

  for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
    const raw = await deps.store.profileRow(rec.assistant_id);
    if (raw === null) return { status: 'unavailable', reason: `the ${rec.assistant_id} profile is not stored in the database yet (run scripts/seed-profiles.ts)` };
    const row = ProfileRow.safeParse(raw);
    if (!row.success) return { status: 'unavailable', reason: `the stored ${rec.assistant_id} profile cannot be read` };

    // An earlier run of this task may have written the version and not marked the recommendation.
    const made = await deps.store.profileVersionFor(rec.id);
    if (made !== null) {
      await deps.store.putInForce(rec.id, { by: actor.by, personId: person, version: made, now: deps.now() });
      return { status: 'in_force', version: made, changed: true, dropped: [], earlier: true };
    }

    // The manager retires only what it put there, judged on this very row (the one the write below is guarded by).
    if (actor.by === 'manager' && change.kind === 'retire' && (await retireAuthorIn(deps, raw, rec.assistant_id, change)) === 'owner') {
      return { status: 'held', reason: OWNERS_TO_RETIRE };
    }

    const now = deps.now();
    const result = applyProfileChange(row.data, change, { readNames: READ_TOOL_NAMES, knownModels: modelsInUse(deps), source: rec.id, by: actor.by, now });
    if (!result.ok) return refuse(result.reason);
    if (!result.changed) {
      await deps.store.putInForce(rec.id, { by: actor.by, personId: person, version: null, now });
      return { status: 'in_force', version: null, changed: false, dropped: [], earlier: false };
    }
    const version = await deps.store.saveProfile({
      assistant: rec.assistant_id, expectedVersion: row.data.version, ...result.next, by: actor.by, reason: reasonFor(rec, actor), now,
      change: {
        kind: rec.kind, recommendation: rec.id, review: rec.review_id, rank: rec.rank, from: row.data.version,
        // The words a lesson or a note added, or a retire took out: who added what is in the history from now on.
        ...(change.kind === 'lesson' || change.kind === 'skill_note' || change.kind === 'retire' ? { text: change.text } : {}),
        ...(detail.success && detail.data.reads ? { reads: detail.data.reads } : {}),
        ...(detail.success && detail.data.model ? { model: detail.data.model } : {}),
        ...(detail.success && detail.data.retire ? { retire: detail.data.retire } : {}),
        ...(result.dropped.length > 0 ? { dropped: result.dropped } : {}),
      },
    });
    if (version === null) continue; // another writer changed the profile since we read it: read it again
    await deps.store.putInForce(rec.id, { by: actor.by, personId: person, version, now });
    return { status: 'in_force', version, changed: true, dropped: result.dropped, earlier: false };
  }
  throw new Error(`the ${rec.assistant_id} profile kept changing, so the change was not written`);
}
