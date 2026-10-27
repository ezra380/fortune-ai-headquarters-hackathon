import { describe, expect, it } from 'vitest';
import type { AssistantId } from '@fahq/contracts';
import { MANAGER_LESSONS_HEADING, OWNER_LESSONS_HEADING, READ_TOOL_NAMES, createProfileSource, loadProfiles, parseProfileRows, skillWithLessons } from '../src/index.ts';

// The profile source with a scripted "database": rows go in as the database returns them, and the clock is ours.

const files = loadProfiles({});
const lesson = { text: 'Say which business a number is about.', source: 'rec-1', adoptedAt: '2026-10-27T09:00:00Z', by: 'owner' as const };

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
    expect(loaded.fromFiles).toEqual(['owner', 'salon', 'online', 'manager', 'legal']);
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

  it('reads a stored lesson with no record of who applied it as the manager\'s, the less trusted of the two', async () => {
    const { by: _by, ...bare } = lesson;
    const { source } = setup([rowFor('finance', { lessons: [bare, { ...bare, source: 'rec-2', by: 'owner' }] })]);
    await source.refresh();
    expect(source.profile('finance').lessons.map((l) => [l.source, l.by])).toEqual([['rec-1', 'manager'], ['rec-2', 'owner']]);
    expect(parseProfileRows([rowFor('finance', { lessons: [{ ...bare, by: 'someone' }] })], READ_TOOL_NAMES).problems[0]).toContain('is not valid (lessons.0.by');
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

  it('never lets the salon or the online store read across the wall, the manager read the finance metrics, or the Legal Team read any business data', () => {
    const walls: [AssistantId, string][] = [
      ['salon', 'get_online_metrics'], ['salon', 'get_finance_metrics'], ['online', 'get_salon_metrics'], ['online', 'get_finance_metrics'], ['manager', 'get_finance_metrics'],
      // The Legal Team reads no money, salon, online or shared data: only tools that return none (its stored profile is refused otherwise).
      ['legal', 'get_finance_metrics'], ['legal', 'get_online_metrics'], ['legal', 'get_salon_metrics'], ['legal', 'get_company_overview'],
      ['legal', 'list_work_reports'], ['legal', 'recall_decisions'], ['legal', 'list_lessons'], ['legal', 'get_repair_tickets'], ['legal', 'get_waiting_conversations'],
    ];
    for (const [id, name] of walls) {
      const parsed = parseProfileRows([rowFor(id, { reads: [...files[id].reads, name] })], READ_TOOL_NAMES);
      expect(parsed.rows.size, `${id} ${name}`).toBe(0);
      expect(parsed.problems[0], `${id} ${name}`).toContain(`may never read "${name}"`);
    }
    expect(parseProfileRows([rowFor('owner', { reads: [...files.owner.reads] })], READ_TOOL_NAMES).rows.size).toBe(1);
    // A stored Legal Team profile that reads only what has no business data is used, and one tool of that kind more is fine.
    expect(parseProfileRows([rowFor('legal'), rowFor('legal', { reads: [...files.legal.reads, 'get_timeline'] })], READ_TOOL_NAMES)).toMatchObject({ problems: [] });
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

  it('a forced read waits for a read already under way and reads again, so a change just written is never missed', async () => {
    // A read that began before the change was saved holds the old rows. The caller that forces a read has just saved
    // something and must get it back, not the answer of the read that was already running.
    const gates: (() => void)[] = [];
    let rows: unknown[] = [rowFor('finance', { title: 'Before' })];
    let loads = 0;
    const source = createProfileSource({
      env: {}, now: () => new Date('2026-10-27T12:00:00Z'), onProblem: () => undefined,
      load: () => { loads += 1; const held = rows; return new Promise<unknown[]>((resolve) => gates.push(() => resolve(held))); },
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    const background = source.refresh();
    rows = [rowFor('finance', { title: 'After', version: 4 })];
    const forced = source.refresh({ force: true });
    const alsoForced = source.refresh({ force: true });
    expect(loads).toBe(1);
    gates[0]!(); // the read that was under way finishes, with the old rows
    await background;
    expect(source.profile('finance').title).toBe('Before');
    await settle();
    expect(loads).toBe(2); // one more read, shared by both forced callers
    gates[1]!();
    await Promise.all([forced, alsoForced]);
    expect(source.profile('finance')).toMatchObject({ title: 'After', version: 4 });
    expect(loads).toBe(2);
  });

  it('a forced read still reads again when the read under way fails', async () => {
    const attempts: ((rows: unknown[] | Error) => void)[] = [];
    const source = createProfileSource({
      env: {}, now: () => new Date('2026-10-27T12:00:00Z'), onProblem: () => undefined,
      load: () => new Promise<unknown[]>((resolve, reject) => attempts.push((r) => (r instanceof Error ? reject(r) : resolve(r)))),
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    const background = source.refresh();
    const failing = expect(background).rejects.toThrow('could not be read (down)');
    const forced = source.refresh({ force: true });
    attempts[0]!(new Error('down'));
    await failing;
    await settle();
    attempts[1]!([rowFor('finance', { title: 'Back' })]);
    await forced;
    expect(source.profile('finance').title).toBe('Back');
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

describe('a listener on every read', () => {
  function withListener(rows: unknown[], onLoaded: (p: Readonly<Record<AssistantId, { lessons: readonly unknown[]; source: string }>>) => void) {
    const state = { problems: [] as string[], t: Date.parse('2026-10-27T12:00:00Z') };
    const source = createProfileSource({
      env: {}, load: async () => rows, now: () => new Date(state.t), onProblem: (m) => state.problems.push(m), onLoaded,
    });
    return { source, state };
  }

  it('hears the profiles after each read, with the lessons of the stored rows', async () => {
    const seen: { finance: unknown[]; source: string }[] = [];
    const { source, state } = withListener([rowFor('finance', { lessons: [lesson] })], (p) => seen.push({ finance: [...p.finance.lessons], source: p.finance.source }));
    await source.refresh();
    expect(seen).toEqual([{ finance: [lesson], source: 'database' }]);
    state.t += 61_000;
    await source.refresh();
    expect(seen).toHaveLength(2); // a read inside the minute is served from the cache and the listener hears nothing
    await source.refresh();
    expect(seen).toHaveLength(2);
  });

  it('is reported and never stops the read when it throws', async () => {
    const { source, state } = withListener([rowFor('finance')], () => { throw new Error('the cache is full'); });
    const loaded = await source.refresh();
    expect(loaded.fromDatabase).toEqual(['finance']);
    expect(source.profile('finance').source).toBe('database');
    expect(state.problems).toEqual(['a profile listener failed (the cache is full)']);
  });

  it('hears nothing when the rows cannot be read', async () => {
    let heard = 0;
    const source = createProfileSource({ env: {}, load: async () => { throw new Error('down'); }, now: () => new Date(), onProblem: () => undefined, onLoaded: () => { heard += 1; } });
    await expect(source.refresh()).rejects.toThrow('the stored profiles could not be read (down)');
    expect(heard).toBe(0);
  });
});

describe('skillWithLessons', () => {
  it('is the skill itself when there are no lessons', () => {
    expect(skillWithLessons(files.finance)).toBe(files.finance.skill);
  });

  const entry = (n: number, by: 'owner' | 'manager') => ({ text: `Lesson ${String.fromCharCode(97 + n)} by the ${by}`, source: `rec-${n}`, adoptedAt: '2026-10-27T09:00:00Z', by });

  it('adds the newest ten lessons after the skill', () => {
    const many = Array.from({ length: 12 }, (_, i) => entry(i, 'owner'));
    const text = skillWithLessons({ skill: files.finance.skill, lessons: many });
    expect(text.startsWith(files.finance.skill)).toBe(true);
    expect(text).toContain('## Standing lessons');
    expect(text).not.toContain('Lesson a');
    expect(text).not.toContain('Lesson b');
    expect(text).toContain('- Lesson c');
    expect(text.endsWith('- Lesson l by the owner')).toBe(true);
  });

  it('shows what the owner adopted as his word: he adopted it, follow it', () => {
    const text = skillWithLessons({ skill: files.finance.skill, lessons: [entry(0, 'owner')] });
    expect(text).toBe(`${files.finance.skill}\n\n${OWNER_LESSONS_HEADING}\n- Lesson a by the owner`);
    expect(OWNER_LESSONS_HEADING).toBe('## Standing lessons\nThe owner adopted these for you. Follow them.');
    expect(text).not.toContain(MANAGER_LESSONS_HEADING);
  });

  it('shows what the HQ Manager applied by itself under its own heading, as a suggestion that ranks below the skill and the owner', () => {
    const text = skillWithLessons({ skill: files.finance.skill, lessons: [entry(0, 'manager')] });
    expect(text).toBe(`${files.finance.skill}\n\n${MANAGER_LESSONS_HEADING}\n- Lesson a by the manager`);
    expect(MANAGER_LESSONS_HEADING).toContain('The owner did not approve them');
    expect(MANAGER_LESSONS_HEADING).toContain("Your skill and the owner's instructions come first.");
    // Nothing the manager applied is said to be the owner's word.
    expect(text).not.toContain('The owner adopted these for you');
    expect(text).not.toContain('## Standing lessons');
  });

  it('keeps the two kinds apart when they are mixed, the owner\'s first, and counts the newest ten across both', () => {
    const mixed = [entry(0, 'owner'), entry(1, 'manager'), entry(2, 'owner'), entry(3, 'manager'), ...Array.from({ length: 8 }, (_, i) => entry(4 + i, i % 2 === 0 ? 'owner' : 'manager'))];
    const text = skillWithLessons({ skill: files.finance.skill, lessons: mixed });
    const ownerAt = text.indexOf(OWNER_LESSONS_HEADING);
    const managerAt = text.indexOf(MANAGER_LESSONS_HEADING);
    expect(ownerAt).toBeGreaterThan(0);
    expect(managerAt).toBeGreaterThan(ownerAt);
    expect(text.slice(ownerAt, managerAt)).not.toContain('by the manager');
    expect(text.slice(managerAt)).not.toContain('by the owner');
    expect(text).not.toContain('Lesson a '); // 12 lessons: the two oldest are not shown, whoever applied them
    expect(text).not.toContain('Lesson b ');
    expect((text.match(/^- Lesson /gm) ?? []).length).toBe(10);
  });

  it('counts a lesson with no record of who applied it as the manager\'s', () => {
    const { by: _by, ...bare } = entry(0, 'owner');
    const text = skillWithLessons({ skill: files.finance.skill, lessons: [bare as never] });
    expect(text).toContain(MANAGER_LESSONS_HEADING);
    expect(text).not.toContain(OWNER_LESSONS_HEADING);
  });
});
