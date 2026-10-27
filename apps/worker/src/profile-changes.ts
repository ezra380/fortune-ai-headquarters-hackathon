import { AssistantId, RecommendationDetail, type TypedRecommendation } from '@fahq/contracts';
import { KIND_LABEL, ProfileRow, READ_TOOL_NAMES, applyProfileChange, changeOf, type ProfileChange, type ProfileContent } from '@fahq/profiles';
import type { WorkerDeps } from './common.ts';
import type { PersonRow, RecommendationRow } from './store.ts';

// Putting one recommendation into force in the assistant's stored profile. Today the owner's code applies every kind
// (ADOPT). The HQ Manager can apply a kind by itself only where MANAGER_APPLIES says so, which is nowhere until Ezra
// approves it; the caller decides who applies, by kind. Either way the change is a new profile version
// (save_assistant_profile) that records who made it, and the recommendation is marked in force. A retried task finds
// out what an earlier run already did:
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
    return changeOf({ kind: rec.kind, change: rec.change, reads: detail.success ? detail.data.reads : undefined, model: detail.success ? detail.data.model : undefined });
  } catch (error) {
    return error instanceof Error ? error.message : 'the change is not readable';
  }
}

/**
 * A plain reason a recommendation, as the review model wrote it, would not apply to what the assistant runs on now
 * (a note that breaks a rule, a tool the assistant may never read, a model no job uses), or that it changes
 * nothing. Null when it would apply. Used by the review's own check, so the model gets one correction round.
 */
export function objectionToChange(deps: Pick<WorkerDeps, 'profiles'>, rec: TypedRecommendation, now: Date): string | null {
  const change = changeFor({ kind: rec.kind, change: rec.change, detail: { ...(rec.reads ? { reads: rec.reads } : {}), ...(rec.model ? { model: rec.model } : {}) } });
  if (typeof change === 'string') return change;
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
        ...(detail.success && detail.data.reads ? { reads: detail.data.reads } : {}),
        ...(detail.success && detail.data.model ? { model: detail.data.model } : {}),
        ...(result.dropped.length > 0 ? { dropped: result.dropped } : {}),
      },
    });
    if (version === null) continue; // another writer changed the profile since we read it: read it again
    await deps.store.putInForce(rec.id, { by: actor.by, personId: person, version, now });
    return { status: 'in_force', version, changed: true, dropped: result.dropped, earlier: false };
  }
  throw new Error(`the ${rec.assistant_id} profile kept changing, so the change was not written`);
}
