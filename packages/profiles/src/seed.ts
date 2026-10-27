import { AssistantId } from '@fahq/contracts';
import type { AssistantProfile } from './index.ts';

// Puts the five file profiles into public.assistant_profiles, through public.save_assistant_profile (which
// writes the row and appends the version in one transaction). Safe to run any number of times:
//  - an assistant with no row gets one (version row made by 'seed');
//  - an assistant that already has a row is left exactly as it is, even if the files have changed since
//    (the HQ Manager or the owner may have changed it on purpose) -- the result says whether it differs;
//  - `force` replaces the title, skill, reads and models of every assistant with the files', as a new version.
//    Adopted lessons are kept: a reseed never throws away what a person decided.

/** The part of a pg Client or Pool the seed needs. */
export type Queryable = { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };

export type SeedAction = 'created' | 'kept' | 'reseeded';
export type SeedResult = { assistant: AssistantId; action: SeedAction; version: number; differsFromFiles: boolean };

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
    if (!current) {
      const version = await save(db, profile, null, [], 'seeded from the files (skills and model defaults)', { kind: 'seed' }, now);
      // null = another run created it a moment ago; leave that one as it is.
      if (version !== null) action = 'created';
    } else if (options.force) {
      const version = await save(db, profile, current.version, current.lessons, 'reseeded from the files (--force)', { kind: 'reseed', from: current.version }, now);
      if (version !== null) action = 'reseeded';
    }
    current = await stored(db, id);
    if (!current) throw new Error(`the ${id} profile could not be stored`);
    results.push({ assistant: id, action, version: current.version, differsFromFiles: !sameAsFiles(current, profile) });
  }
  return results;
}
