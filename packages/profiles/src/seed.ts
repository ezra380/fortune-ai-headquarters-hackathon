import { AssistantId } from '@fahq/contracts';
import { managerNotes, withManagerNotes } from './changes.ts';
import type { AssistantProfile } from './index.ts';

// Puts the five file profiles into public.assistant_profiles, through public.save_assistant_profile (which
// writes the row and appends the version in one transaction). Safe to run any number of times:
//  - an assistant with no row gets one (version row made by 'seed');
//  - an assistant that already has a row is left exactly as it is, even if the files have changed since
//    (the HQ Manager or the owner may have changed it on purpose) -- the result says whether it differs;
//  - `force` replaces the title, skill, reads and models of every assistant with the files', as a new version, EXCEPT
//    what the owner decided with his code: the read tools, and the model of each job, whose latest change in the history
//    was made by the owner stay as they are (the result says which). Adopted lessons and the HQ Manager's notes at the
//    end of the skill are kept too. A reseed never throws away what a person decided (and every earlier version stays in
//    the history); to take an owner's choice back, put an earlier version back (scripts/revert-profile.ts).

/** The part of a pg Client or Pool the seed needs. */
export type Queryable = { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };

export type SeedAction = 'created' | 'kept' | 'reseeded';
export type SeedResult = {
  assistant: AssistantId; action: SeedAction; version: number; differsFromFiles: boolean;
  /** Present only when a reseed left the owner's choices alone: 'reads', and 'model <job>' for each job. */
  keptFromOwner?: string[];
};

type Stored = { version: number; title: string; skill: string; reads: string[]; models: unknown; lessons: unknown };

/** JSON with sorted keys, so two equal values compare equal whatever order a database returned their keys in. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const fromFiles = (p: AssistantProfile) => ({ title: p.title, skill: p.skill, reads: [...p.reads], models: p.models });
const sameAsFiles = (stored: Stored, p: AssistantProfile) =>
  canonicalJson({ title: stored.title, skill: stored.skill, reads: stored.reads, models: stored.models }) === canonicalJson(fromFiles(p));

// ---- What the owner decided ------------------------------------------------------------------------------

type VersionRow = { made_by: string; snapshot: { reads?: unknown; models?: unknown } };
export type OwnerChoices = { reads: string[] | null; models: Record<string, unknown> };

/**
 * The read tools and the per-job models whose LATEST change in the history (oldest version first) was made by the owner:
 * the choices he approved with his code (or by putting a version back). A field's latest change is the last version whose
 * value differs from the version before; the first version is nobody's change. A field that a later version changed again
 * (the manager, a reseed) is no longer his.
 */
export function ownerChoices(history: readonly VersionRow[]): OwnerChoices {
  let readsBy: string | null = null;
  const modelBy = new Map<string, string>();
  let reads: unknown = history[0]?.snapshot.reads;
  let models = new Map<string, string>(Object.entries((history[0]?.snapshot.models ?? {}) as Record<string, unknown>).map(([job, s]) => [job, canonicalJson(s)]));
  for (const version of history.slice(1)) {
    if (canonicalJson(version.snapshot.reads) !== canonicalJson(reads)) readsBy = version.made_by;
    reads = version.snapshot.reads;
    const now = new Map<string, string>(Object.entries((version.snapshot.models ?? {}) as Record<string, unknown>).map(([job, s]) => [job, canonicalJson(s)]));
    for (const job of new Set([...models.keys(), ...now.keys()])) if (models.get(job) !== now.get(job)) modelBy.set(job, version.made_by);
    models = now;
  }
  const latest = (history.at(-1)?.snapshot ?? {}) as { reads?: unknown; models?: unknown };
  const current = (latest.models ?? {}) as Record<string, unknown>;
  return {
    reads: readsBy === 'owner' && Array.isArray(latest.reads) ? (latest.reads as string[]) : null,
    models: Object.fromEntries(Object.entries(current).filter(([job]) => modelBy.get(job) === 'owner')),
  };
}

async function history(db: Queryable, id: AssistantId): Promise<VersionRow[]> {
  const { rows } = await db.query('select made_by, snapshot from public.assistant_profile_versions where assistant_id = $1 order by version', [id]);
  return rows as VersionRow[];
}

async function save(
  db: Queryable, p: AssistantProfile, expected: number | null, lessons: unknown, reason: string, change: Record<string, unknown>, now: Date,
): Promise<number | null> {
  const { rows } = await db.query(
    `select public.save_assistant_profile($1::public.assistant_id, $2::integer, $3, $4, $5::text[], $6::jsonb, $7::jsonb, 'seed', $8, $9::jsonb, $10::timestamptz) as version`,
    [p.id, expected, p.title, p.skill, [...p.reads], JSON.stringify(p.models), JSON.stringify(lessons), reason, JSON.stringify(change), now.toISOString()],
  );
  return (rows[0]?.version as number | null | undefined) ?? null;
}

async function stored(db: Queryable, id: AssistantId): Promise<Stored | null> {
  const { rows } = await db.query('select version, title, skill, reads, models, lessons from public.assistant_profiles where assistant_id = $1', [id]);
  return (rows[0] as Stored | undefined) ?? null;
}

export async function seedFromFiles(
  db: Queryable, files: Record<AssistantId, AssistantProfile>, options: { force?: boolean; now?: Date } = {},
): Promise<SeedResult[]> {
  const now = options.now ?? new Date();
  const results: SeedResult[] = [];
  for (const id of AssistantId.options) {
    const profile = files[id];
    let current = await stored(db, id);
    let action: SeedAction = 'kept';
    let kept: string[] = [];
    if (!current) {
      const version = await save(db, profile, null, [], 'seeded from the files (skills and model defaults)', { kind: 'seed' }, now);
      // null = another run created it a moment ago; leave that one as it is.
      if (version !== null) action = 'created';
    } else if (options.force) {
      // What the HQ Manager added (the notes at the end of the skill), what a person adopted (the lessons) and what the
      // owner decided (the read tools and the models of the jobs he changed) is kept.
      const owner = ownerChoices(await history(db, id));
      kept = [...(owner.reads ? ['reads'] : []), ...Object.keys(owner.models).map((job) => `model ${job}`)];
      const next: AssistantProfile = {
        ...profile,
        skill: withManagerNotes(profile.skill, managerNotes(current.skill)),
        reads: (owner.reads ?? profile.reads) as AssistantProfile['reads'],
        models: { ...profile.models, ...owner.models } as AssistantProfile['models'],
      };
      const change = { kind: 'reseed', from: current.version, ...(kept.length > 0 ? { keptFromOwner: kept } : {}) };
      const version = await save(db, next, current.version, current.lessons, 'reseeded from the files (--force)', change, now);
      if (version !== null) action = 'reseeded';
    }
    current = await stored(db, id);
    if (!current) throw new Error(`the ${id} profile could not be stored`);
    results.push({ assistant: id, action, version: current.version, differsFromFiles: !sameAsFiles(current, profile), ...(action === 'reseeded' && kept.length > 0 ? { keptFromOwner: kept } : {}) });
  }
  return results;
}
