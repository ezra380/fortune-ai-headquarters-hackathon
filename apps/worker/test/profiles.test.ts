import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssistantId } from '@fahq/contracts';
import { READ_TOOL_NAMES, loadProfiles, parseProfileRows, seedProfiles } from '@fahq/profiles';
import { workerProfiles } from '../src/profiles.ts';
import { createReadTools, pick } from '../src/read-tools.ts';
import { createStore } from '../src/store.ts';
import { dbUrl, localApi } from './localdb.ts';

// The worker's profile loading: with a scripted store (what happens when), then with the real store and the real
// table (what the worker reads at start-up). The real part skips itself when the local stack is down.

const files = loadProfiles({});
const NOW = () => new Date('2026-10-27T12:00:00Z');
const row = (id: AssistantId, over: Record<string, unknown> = {}) => ({
  assistant_id: id, version: 2, title: files[id].title, skill: files[id].skill, reads: [...files[id].reads], models: files[id].models, lessons: [],
  updated_at: '2026-10-27T10:00:00Z', updated_by: 'manager', ...over,
});

describe('workerProfiles (scripted store)', () => {
  it('serves a stored profile: its skill with the standing lessons, its model, its reads', async () => {
    const lesson = { text: 'Ask which month before answering.', source: 'rec-9', adoptedAt: '2026-10-27T09:00:00Z', by: 'owner' };
    const log: string[] = [];
    const profiles = await workerProfiles({}, {
      assistantProfiles: async () => [row('finance', {
        skill: `${files.finance.skill}\nOne more rule.`, reads: ['get_finance_metrics', 'my_lessons'], lessons: [lesson],
        models: { ...files.finance.models, answer: { model: 'stored-answer', thinking: false, maxTokens: 300, temperature: 0 } },
      })],
    }, NOW, (line) => log.push(line));

    expect(profiles.reads('finance')).toEqual(['get_finance_metrics', 'my_lessons']);
    expect(profiles.model('finance', 'answer')).toBe('stored-answer');
    expect(profiles.model('finance', 'code')).toBe(files.finance.models.code!.model);
    expect(profiles.skill('finance')).toContain('One more rule.');
    expect(profiles.skill('finance')).toContain('## Standing lessons');
    expect(profiles.skill('finance')).toContain('- Ask which month before answering.');
    // An assistant with no row keeps its file, with no lessons section.
    expect(profiles.skill('owner')).toBe(files.owner.skill);
    expect(profiles.reads('owner')).toEqual([...files.owner.reads]);
    expect(log).toEqual(['worker: profiles from the database: finance; from the files: owner, salon, online, manager, legal']);
  });

  it('says plainly that an assistant has no model for a job it does not do', async () => {
    const profiles = await workerProfiles({}, { assistantProfiles: async () => [] }, NOW, () => undefined);
    expect(() => profiles.model('owner', 'review')).toThrow('The Owner HQ assistant has no model for "review".');
    expect(profiles.model('manager', 'review')).toBe(files.manager.models.review!.model);
  });

  it('refuses to start when the table cannot be read, and tells the operator what to do', async () => {
    const down = { assistantProfiles: async () => { throw new Error('assistant profiles failed (42P01)'); } };
    await expect(workerProfiles({}, down, NOW, () => undefined)).rejects.toThrow(
      /the stored profiles could not be read \(assistant profiles failed \(42P01\)\)\. Apply supabase\/migrations\/20261027100000_profiles\.sql and run scripts\/seed-profiles\.ts, or set PROFILES_SOURCE=files/,
    );
  });

  it('runs on the files alone when told to, without reading the table', async () => {
    const log: string[] = [];
    let reads = 0;
    const store = { assistantProfiles: async () => { reads += 1; return [row('finance', { title: 'Stored' })]; } };
    const profiles = await workerProfiles({ PROFILES_SOURCE: 'files' }, store, NOW, (line) => log.push(line));
    expect(reads).toBe(0);
    expect(profiles.skill('finance')).toBe(files.finance.skill);
    expect(profiles.reads('finance')).toEqual([...files.finance.reads]);
    expect(log).toEqual(['worker: profiles from the files only (PROFILES_SOURCE=files)']);
  });

  it('keeps the file profile of an assistant whose stored row breaks a rule, and says so', async () => {
    const log: string[] = [];
    const profiles = await workerProfiles({}, {
      assistantProfiles: async () => [row('salon', { reads: ['get_salon_metrics', 'get_online_metrics'] })],
    }, NOW, (line) => log.push(line));
    expect(profiles.reads('salon')).toEqual([...files.salon.reads]);
    expect(log.some((l) => l.includes('the stored profile of salon was refused: the salon assistant may never read "get_online_metrics"'))).toBe(true);
  });
});

const api = localApi();
if (!api) console.warn('SKIPPED worker profile tests on the real table: needs local Supabase (npm run db:start)');
const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
afterAll(async () => pool.end());

describe.skipIf(!api)('workerProfiles (real store, real table)', () => {
  const store = createStore(api!.url, api!.key);
  let migrated = false;

  beforeAll(async () => {
    migrated = (await pool.query(`select to_regclass('public.assistant_profiles') as t`)).rows[0].t !== null;
    if (!migrated) console.warn('SKIPPED worker profile tests on the real table: apply supabase/migrations/20261027100000_profiles.sql');
    else await seedProfiles(pool, {}); // an assistant with no row gets one; the others are left alone
  });

  it('reads the five stored profiles through the store, and every one passes the profile checks', async ({ skip }) => {
    if (!migrated) skip();
    const raw = await store.assistantProfiles();
    expect(raw.length).toBeGreaterThanOrEqual(5);
    const parsed = parseProfileRows(raw, READ_TOOL_NAMES);
    expect(parsed.problems).toEqual([]);
    expect([...parsed.rows.keys()].sort()).toEqual([...AssistantId.options].sort());
  });

  it('gives the worker a profile for every assistant, each read tool of which the worker can build', async ({ skip }) => {
    if (!migrated) skip();
    const log: string[] = [];
    const profiles = await workerProfiles({}, store, NOW, (line) => log.push(line));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(/^worker: profiles from the database: .*owner.*; from the files: /);
    for (const id of AssistantId.options) {
      expect(profiles.skill(id), id).toMatch(/read-only/);
      expect(profiles.reads(id).length, id).toBeGreaterThan(0);
      // The production wiring (common.ts toolsFor): every name a stored profile lists must be a tool that exists.
      const all = createReadTools({ store, brain: {} as never, data: null, now: NOW }, id);
      expect(pick(all, profiles.reads(id)).map((t) => t.name), id).toEqual([...profiles.reads(id)]);
    }
    expect(profiles.reads('salon')).not.toContain('get_online_metrics');
    expect(profiles.reads('online')).not.toContain('get_salon_metrics');
  });
});
