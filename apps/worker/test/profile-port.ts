import type { AssistantId } from '@fahq/contracts';
import { loadProfiles } from '@fahq/profiles';

// The profile tables, in memory, behind the same methods the worker's store has (profileRow, saveProfile,
// profileVersionFor, assistantProfiles). The manager tests run on the shared local database for everything else,
// and a profile version can never be taken back from a real table, so no test here may write one there: this stands
// in for the three profile methods only. save_assistant_profile itself is tested on a throwaway database (supabase/tests).
//  - a profile is read at a version, and a write only goes through from the version the writer last saw;
//  - every version is kept, with who made it and the change it carries (the history is append-only).

type Row = {
  assistant_id: AssistantId; version: number; title: string; skill: string; reads: string[]; models: unknown; lessons: unknown[];
  updated_at: string; updated_by: 'seed' | 'manager' | 'owner';
};
export type Version = { assistant: AssistantId; version: number; madeBy: 'seed' | 'manager' | 'owner'; reason: string; change: Record<string, unknown>; snapshot: Pick<Row, 'title' | 'skill' | 'reads' | 'models' | 'lessons'> };
type Save = {
  assistant: AssistantId; expectedVersion: number; title: string; skill: string; reads: readonly string[]; models: unknown; lessons: unknown;
  by: 'manager' | 'owner'; reason: string; change: Record<string, unknown>; now: Date;
};

export function memoryProfiles(options: { without?: readonly AssistantId[] } = {}) {
  const files = loadProfiles({});
  const rows = new Map<AssistantId, Row>();
  const history: Version[] = [];
  const state = { beforeSave: null as null | ((a: Save) => void), saves: 0 };

  const put = (row: Row, madeBy: Row['updated_by'], reason: string, change: Record<string, unknown>) => {
    rows.set(row.assistant_id, row);
    history.push({
      assistant: row.assistant_id, version: row.version, madeBy, reason, change,
      snapshot: structuredClone({ title: row.title, skill: row.skill, reads: row.reads, models: row.models, lessons: row.lessons }),
    });
  };
  for (const [id, p] of Object.entries(files) as [AssistantId, (typeof files)[AssistantId]][]) {
    if (options.without?.includes(id)) continue;
    put({ assistant_id: id, version: 1, title: p.title, skill: p.skill, reads: [...p.reads], models: structuredClone(p.models), lessons: [], updated_at: '2026-10-27T08:00:00.000Z', updated_by: 'seed' }, 'seed', 'seeded', { kind: 'seed' });
  }

  const port = {
    async assistantProfiles(): Promise<unknown[]> {
      return [...rows.values()].map((r) => structuredClone(r));
    },
    async profileRow(assistant: AssistantId): Promise<unknown | null> {
      const row = rows.get(assistant);
      return row ? structuredClone(row) : null;
    },
    async saveProfile(a: Save): Promise<number | null> {
      state.beforeSave?.(a); // a test can have another writer get in first
      state.saves += 1;
      const row = rows.get(a.assistant);
      if (!row || row.version !== a.expectedVersion) return null;
      const version = Math.max(0, ...history.filter((h) => h.assistant === a.assistant).map((h) => h.version)) + 1;
      put({
        assistant_id: a.assistant, version, title: a.title, skill: a.skill, reads: [...a.reads], models: structuredClone(a.models), lessons: structuredClone(a.lessons) as unknown[],
        updated_at: a.now.toISOString(), updated_by: a.by,
      }, a.by, a.reason, structuredClone(a.change));
      return version;
    },
    async profileVersionFor(recommendationId: string): Promise<number | null> {
      const made = history.filter((h) => h.change.recommendation === recommendationId).map((h) => h.version);
      return made.length > 0 ? Math.max(...made) : null;
    },
  };

  return {
    port, rows, history, state,
    row: (id: AssistantId) => rows.get(id)!,
    lessons: (id: AssistantId) => (rows.get(id)?.lessons ?? []) as { text: string; source: string; adoptedAt: string }[],
    versionsOf: (id: AssistantId) => history.filter((h) => h.assistant === id),
    /** Every version written by someone but the seed. */
    changes: () => history.filter((h) => h.madeBy !== 'seed'),
  };
}
