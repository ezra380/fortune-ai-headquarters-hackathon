import { describe, expect, it } from 'vitest';
import type { AssistantId } from '@fahq/contracts';
import { READ_TOOL_NAMES, createProfileSource, loadProfiles, parseProfileRows, skillWithLessons } from '../src/index.ts';

// The profile source with a scripted "database": rows go in as the database returns them, and the clock is ours.

const files = loadProfiles({});
const lesson = { text: 'Say which business a number is about.', source: 'rec-1', adoptedAt: '2026-10-27T09:00:00Z' };

function rowFor(id: AssistantId, over: Record<string, unknown> = {}) {
  const f = files[id];
  return {
    assistant_id: id, version: 3, title: f.title, skill: f.skill, reads: [...f.reads], models: f.models, lessons: [],
    updated_at: '2026-10-27T10:00:00Z', updated_by: 'seed', ...over,
  };
}

function setup(rows: unknown[] | Error) {
  const state = { rows, loads: 0, problems: [] as string[], t: Date.parse('2026-10-27T12:00:00Z') };
  const source = createProfileSource({
    env: {},
    load: async () => {
      state.loads += 1;
      if (state.rows instanceof Error) throw state.rows;
      return state.rows as unknown[];
    },
    now: () => new Date(state.t),
    onProblem: (m) => state.problems.push(m),
  });
  const wait = (ms: number) => { state.t += ms; };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { state, source, wait, settle };
}

describe('the profile source', () => {
  it('uses the stored row for an assistant that has one and the file for the rest', async () => {
    const { source } = setup([rowFor('finance', {
      version: 7, title: 'Finance (stored)', skill: files.finance.skill.replace('Job', 'Job and nothing else'),
      reads: ['get_finance_metrics', 'recall_my_decisions'],
      models: { ...files.finance.models, answer: { model: 'stored-answer-model', thinking: true, maxTokens: 500, temperature: 0.1 } },
      lessons: [lesson],
    })]);
    const loaded = await source.refresh();
    expect(loaded.fromDatabase).toEqual(['finance']);
    expect(loaded.fromFiles).toEqual(['owner', 'salon', 'online', 'manager']);
    expect(loaded.problems).toEqual([]);

    const finance = source.profile('finance');
    expect(finance).toMatchObject({ source: 'database', version: 7, title: 'Finance (stored)', reads: ['get_finance_metrics', 'recall_my_decisions'] });
    expect(finance.skill).toContain('Job and nothing else');
    expect(finance.models.answer).toEqual({ model: 'stored-answer-model', thinking: true, maxTokens: 500, temperature: 0.1 });
    expect(finance.models.plan).toEqual(files.finance.models.plan); // a job the row leaves as it was
    expect(finance.lessons).toEqual([lesson]);

    expect(source.profile('owner')).toEqual(files.owner);
    expect(source.profile('owner')).toMatchObject({ source: 'files', version: null, lessons: [] });
  });

  it('keeps the settings the database does not hold, and ignores a job the assistant does not have', async () => {
    const { source } = setup([rowFor('salon', { models: { ...files.salon.models, route: { model: 'x', thinking: false, maxTokens: 10, temperature: 0 } } })]);
    await source.refresh();
    const salon = source.profile('salon');
    expect(salon).toMatchObject({ memory: 'salon', serves: 'head_stylist', status: 'live', writes: files.salon.writes });
    expect(salon.models.route).toBeUndefined(); // the salon plans, answers and writes code; it never routes
  });

  it.each([
    ['a read that is not a read tool', { reads: ['get_finance_metrics', 'send_sms'] }, /it reads "send_sms", which is not a read tool/],
    ['a read listed twice', { reads: ['my_lessons', 'my_lessons'] }, /it lists a read tool twice/],
    ['a skill that dropped the read-only rule', { skill: files.finance.skill.replace(/read-only/g, 'free') }, /no longer says the assistant is read-only/],
    ['a skill without its "You never" section', { skill: files.finance.skill.replace('## You never', '## Notes read-only') }, /lost the "You never" section/],
    ['a version below 1', { version: 0 }, /not valid \(version/],
    ['a model setting out of range', { models: { code: { model: 'm', thinking: false, maxTokens: 100, temperature: 9 } } }, /not valid \(models/],
    ['a job that does not exist', { models: { dance: { model: 'm', thinking: false, maxTokens: 100, temperature: 0 } } }, /not valid \(models/],
    ['a skill that is too short', { skill: 'read-only' }, /not valid \(skill/],
  ])('keeps the file profile when the row has %s, and says so once', async (_name, over, reason) => {
    const { source, state } = setup([rowFor('finance', over)]);
    const loaded = await source.refresh();
    expect(loaded.fromDatabase).toEqual([]);
    expect(source.profile('finance')).toEqual(files.finance);
    expect(loaded.problems).toHaveLength(1);
    expect(loaded.problems[0]).toMatch(reason);
    expect(loaded.problems[0]).toContain('the files are used');
    await source.refresh({ force: true });
    expect(state.problems).toHaveLength(1); // the same problem is not repeated on every read
  });

  it('never lets the salon or the online store read across the wall, or the manager read the finance metrics', () => {
    const walls: [AssistantId, string][] = [
      ['salon', 'get_online_metrics'], ['salon', 'get_finance_metrics'], ['online', 'get_salon_metrics'], ['online', 'get_finance_metrics'], ['manager', 'get_finance_metrics'],
    ];
    for (const [id, name] of walls) {
      const parsed = parseProfileRows([rowFor(id, { reads: [...files[id].reads, name] })], READ_TOOL_NAMES);
      expect(parsed.rows.size, `${id} ${name}`).toBe(0);
      expect(parsed.problems[0], `${id} ${name}`).toContain(`may never read "${name}"`);
    }
    expect(parseProfileRows([rowFor('owner', { reads: [...files.owner.reads] })], READ_TOOL_NAMES).rows.size).toBe(1);
  });

  it('accepts the rows exactly as pg and supabase-js hand them over (a Date or a string for the time)', () => {
    const asPg = rowFor('online', { updated_at: new Date('2026-10-27T10:00:00Z') });
    const asJson = rowFor('online', { updated_at: '2026-10-27T10:00:00+00:00' });
    expect(parseProfileRows([asPg, asJson], READ_TOOL_NAMES).problems).toEqual([]);
  });

  it('reads at most once per minute and shares one read between callers asking at once', async () => {
    const { source, state, wait } = setup([rowFor('owner')]);
    await Promise.all([source.refresh(), source.refresh(), source.refresh()]);
    expect(state.loads).toBe(1);
    wait(59_000);
    await source.refresh();
    expect(state.loads).toBe(1);
    wait(2_000);
    await source.refresh();
    expect(state.loads).toBe(2);
    await source.refresh({ force: true });
    expect(state.loads).toBe(3);
  });

  it('serves the last profile at once when the cache is old, and a change reaches it within the minute', async () => {
    const { source, state, wait, settle } = setup([rowFor('owner', { title: 'Owner one' })]);
    await source.refresh();
    expect(source.profile('owner').title).toBe('Owner one');
    state.rows = [rowFor('owner', { title: 'Owner two', version: 4 })];
    wait(30_000);
    expect(source.profile('owner').title).toBe('Owner one'); // still inside the minute
    expect(state.loads).toBe(1);
    wait(31_000);
    expect(source.profile('owner').title).toBe('Owner one'); // old cache: answers now, reads in the background
    await settle();
    expect(state.loads).toBe(2);
    expect(source.profile('owner')).toMatchObject({ title: 'Owner two', version: 4 });
    expect(state.loads).toBe(2);
  });

  it('refuses to start from a table it cannot read, in plain words, and serves the files meanwhile', async () => {
    const { source, state, wait, settle } = setup(new Error('relation "assistant_profiles" does not exist'));
    await expect(source.refresh()).rejects.toThrow('the stored profiles could not be read (relation "assistant_profiles" does not exist)');
    expect(source.profile('finance')).toEqual(files.finance);
    await settle();
    expect(state.loads).toBe(1); // no read per call while it is failing: the next try waits a minute
    wait(61_000);
    source.profile('finance');
    await settle();
    expect(state.loads).toBe(2);
    expect(state.problems).toHaveLength(1);
    expect(source.status()).toMatchObject({ loadedAt: null, lastError: expect.stringContaining('could not be read') });
  });

  it('keeps the last good profiles when a later read fails, and recovers when it works again', async () => {
    const { source, state, wait, settle } = setup([rowFor('finance', { title: 'Finance stored' })]);
    await source.refresh();
    state.rows = new Error('connection reset');
    wait(61_000);
    source.profile('finance');
    await settle();
    expect(source.profile('finance').title).toBe('Finance stored');
    expect(source.status().lastError).toContain('connection reset');
    expect(state.problems).toHaveLength(1);
    state.rows = [rowFor('finance', { title: 'Finance back' })];
    await source.refresh({ force: true });
    expect(source.profile('finance').title).toBe('Finance back');
    expect(source.status().lastError).toBeNull();
  });

  it('hands out copies, so changing one never changes the next', async () => {
    const { source } = setup([rowFor('finance')]);
    await source.refresh();
    const before = structuredClone(source.profile('finance'));
    const first = source.profile('finance');
    first.title = 'changed';
    (first.reads as string[]).push('get_online_metrics');
    first.models.code!.model = 'changed';
    expect(source.profile('finance')).toEqual(before);
    expect(before.source).toBe('database');
  });
});

describe('skillWithLessons', () => {
  it('is the skill itself when there are no lessons', () => {
    expect(skillWithLessons(files.finance)).toBe(files.finance.skill);
  });

  it('adds the newest ten lessons after the skill', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ text: `Lesson ${String.fromCharCode(97 + i)}`, source: `rec-${i}`, adoptedAt: '2026-10-27T09:00:00Z' }));
    const text = skillWithLessons({ skill: files.finance.skill, lessons: many });
    expect(text.startsWith(files.finance.skill)).toBe(true);
    expect(text).toContain('## Standing lessons');
    expect(text).not.toContain('Lesson a');
    expect(text).not.toContain('Lesson b');
    expect(text).toContain('- Lesson c');
    expect(text.endsWith('- Lesson l')).toBe(true);
  });
});
