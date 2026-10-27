import { AssistantId } from '@fahq/contracts';
import type { AssistantProfile, ReadToolName } from './index.ts';
import { parseProfileRows, type ProfileRow } from './rows.ts';

// Where the worker gets its profiles. The database holds the current profile of each assistant; the files
// under skills/ are the baseline an assistant keeps when it has no row (or when its row breaks a rule).
//  - The profiles are held in memory and read again at most once per `ttlMs` (about a minute), so a model
//    call never waits on the database and a change reaches the worker within that time.
//  - The first read must work: a database that cannot be read at start-up is an error, not a quiet
//    fall-back. After that, a failed read keeps the last good profiles and is reported once.

export const DEFAULT_PROFILE_TTL_MS = 60_000;
const MAX_LESSONS_IN_SKILL = 10;

export type ProfileSourceOptions = {
  /** The file profiles: the baseline, and the fixed settings (memory, status, who it serves) of every assistant. */
  files: () => Record<AssistantId, AssistantProfile>;
  /** The fixed list of read tools; a stored profile may name nothing else. */
  readNames: readonly string[];
  /** Reads every stored profile row, as the database returned it. */
  load: () => Promise<readonly unknown[]>;
  now: () => Date;
  ttlMs?: number;
  /** Told once about each problem (a refused row, an unreadable table). Default: stderr. */
  onProblem?: (message: string) => void;
};

export type ProfileSnapshot = { fromDatabase: AssistantId[]; fromFiles: AssistantId[]; problems: string[] };
export type ProfileSource = {
  /** The assistant's profile as last loaded. Never waits: when the cache is old it starts a read in the background. */
  profile(id: AssistantId): AssistantProfile;
  /** Reads the rows again unless they were read within the ttl (or `force`). Rejects, in plain words, when they cannot be read. */
  refresh(options?: { force?: boolean }): Promise<ProfileSnapshot>;
  status(): ProfileSnapshot & { loadedAt: Date | null; lastError: string | null };
};

/** The stored row on top of the file profile: its words, reads, models and lessons; everything fixed stays from the files. */
function overlay(base: AssistantProfile, row: ProfileRow): AssistantProfile {
  const models = { ...base.models };
  for (const job of Object.keys(base.models) as (keyof typeof base.models)[]) {
    const stored = row.models[job];
    if (stored) models[job] = { ...stored };
  }
  return {
    ...base,
    title: row.title,
    skill: row.skill,
    reads: row.reads as ReadToolName[],
    models,
    lessons: row.lessons.map((l) => ({ ...l })),
    version: row.version,
    source: 'database',
  };
}

export function buildProfileSource(options: ProfileSourceOptions): ProfileSource {
  const ttlMs = options.ttlMs ?? DEFAULT_PROFILE_TTL_MS;
  const report = options.onProblem ?? ((message: string) => console.error(`profiles: ${message}`));
  let profiles = options.files();
  let snapshot: ProfileSnapshot = { fromDatabase: [], fromFiles: [...AssistantId.options], problems: [] };
  let loadedAt: Date | null = null;
  let checkedAt: Date | null = null;
  let lastError: string | null = null;
  let inFlight: Promise<ProfileSnapshot> | null = null;
  let announced = new Set<string>();

  const isFresh = () => checkedAt !== null && options.now().getTime() - checkedAt.getTime() < ttlMs;
  const announce = (messages: readonly string[]) => {
    for (const m of messages) if (!announced.has(m)) report(m);
    announced = new Set(messages);
  };

  async function read(): Promise<ProfileSnapshot> {
    let raw: readonly unknown[];
    try {
      raw = await options.load();
    } catch (error) {
      checkedAt = options.now();
      lastError = `the stored profiles could not be read (${error instanceof Error && error.message ? error.message : 'unknown error'})`;
      announce([lastError]);
      throw new Error(lastError);
    }
    const { rows, problems } = parseProfileRows(raw, options.readNames);
    const files = options.files();
    const next = {} as Record<AssistantId, AssistantProfile>;
    const fromDatabase: AssistantId[] = [];
    const fromFiles: AssistantId[] = [];
    for (const id of AssistantId.options) {
      const row = rows.get(id);
      next[id] = row ? overlay(files[id], row) : files[id];
      (row ? fromDatabase : fromFiles).push(id);
    }
    profiles = next;
    snapshot = { fromDatabase, fromFiles, problems };
    loadedAt = checkedAt = options.now();
    lastError = null;
    announce(problems);
    return snapshot;
  }

  function refresh(opts: { force?: boolean } = {}): Promise<ProfileSnapshot> {
    if (!opts.force && isFresh()) return Promise.resolve(snapshot);
    inFlight ??= read().finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    profile(id) {
      if (!isFresh() && !inFlight) refresh().catch(() => { /* read() already reported it */ });
      return structuredClone(profiles[id]);
    },
    refresh,
    status: () => ({ ...snapshot, loadedAt, lastError }),
  };
}

/**
 * The skill text a model is given: the profile's skill, then its standing lessons when it has any (the
 * newest ten). Lessons are adopted by a person's code, so they are as trusted as the skill itself.
 */
export function skillWithLessons(profile: Pick<AssistantProfile, 'skill' | 'lessons'>): string {
  if (profile.lessons.length === 0) return profile.skill;
  const shown = profile.lessons.slice(-MAX_LESSONS_IN_SKILL).map((l) => `- ${l.text}`);
  return `${profile.skill}\n\n## Standing lessons\nThe owner adopted these for you. Follow them.\n${shown.join('\n')}`;
}
