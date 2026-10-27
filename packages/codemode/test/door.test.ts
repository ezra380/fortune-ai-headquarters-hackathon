import { describe, expect, it } from 'vitest';
import { AssistantId } from '@fahq/contracts';
import { loadProfiles } from '@fahq/profiles';
import { DoorError } from '../src/door-client.ts';
import { openDoor, parseDoorArgs, reportKey } from '../src/door.ts';

// Opening a door: the arguments, where the token comes from, which profile is served and how a report is keyed.
// A fake `fetch` stands in for the database.

const files = loadProfiles({});
const TOKEN = 'fahq_' + 'T'.repeat(43);
const jwt = (role: string) => ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ role })).toString('base64url'), 'signature'].join('.');
const ENV = { SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_ANON_KEY: jwt('anon'), FAHQ_DOOR_TOKEN: TOKEN };
const FILED = '0c1f6f0e-6f0e-4c1f-8f0e-0c1f6f0e0c1f';

const stored = (id: AssistantId, over: Record<string, unknown> = {}) => ({
  assistant: id, title: files[id].title, version: 6, skill: files[id].skill, reads: [...files[id].reads], models: files[id].models, lessons: [], ...over,
});
function database(profile: unknown, status = 200) {
  const calls: { fn: string; body: any }[] = [];
  const fetchFn = (async (url: URL | string, init: RequestInit) => {
    const fn = String(url).split('/').at(-1)!;
    const body = JSON.parse(String(init.body));
    calls.push({ fn, body });
    if (status !== 200) return new Response(JSON.stringify({ code: '28000', message: 'This token is not valid.' }), { status });
    return new Response(JSON.stringify(fn === 'door_profile' ? profile : { id: FILED, duplicate: false }), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, calls };
}
const message = async (work: Promise<unknown>) => ((await work.then(() => null, (e: unknown) => e)) as Error | null)?.message;

describe('parseDoorArgs', () => {
  it('reads --profile (both spellings), --plain, --local and --token-file', () => {
    expect(parseDoorArgs([])).toEqual({ plain: false, local: false, profile: undefined, tokenFile: undefined });
    expect(parseDoorArgs(['--profile', 'finance', '--plain'])).toEqual({ plain: true, local: false, profile: 'finance', tokenFile: undefined });
    expect(parseDoorArgs(['--profile=salon', '--token-file=/tmp/t'])).toEqual({ plain: false, local: false, profile: 'salon', tokenFile: '/tmp/t' });
    expect(parseDoorArgs(['--local', '--profile', 'manager'])).toEqual({ plain: false, local: true, profile: 'manager', tokenFile: undefined });
  });

  it('refuses a profile that does not exist, an option it does not know, a stray word, and --local with a token file', () => {
    expect(() => parseDoorArgs(['--profile', 'cindy'])).toThrow(`--profile must be one of ${AssistantId.options.join(', ')}.`);
    expect(() => parseDoorArgs(['--profile'])).toThrow(DoorError);
    expect(() => parseDoorArgs(['--frobnicate'])).toThrow(/Use --profile <id>, --token-file <path>, --local, --plain\./);
    expect(() => parseDoorArgs(['finance'])).toThrow(DoorError);
    expect(() => parseDoorArgs(['--local', '--token-file', 'x'])).toThrow(/cannot be combined with --token-file/);
  });
});

describe('openDoor --local', () => {
  it('serves the file profile (owner unless told otherwise), calls no database and has no report to file', async () => {
    const db = database(null);
    const owner = await openDoor({ plain: false, local: true, profile: undefined, tokenFile: undefined }, ENV, { fetch: db.fetchFn });
    expect(owner.profile).toEqual(files.owner);
    expect(owner.fileReport).toBeUndefined();
    expect(owner.summary).toBe('profile owner from the files (offline, no work report)');
    const salon = await openDoor({ plain: true, local: true, profile: 'salon', tokenFile: undefined }, {}, { fetch: db.fetchFn });
    expect(salon.profile.id).toBe('salon');
    expect(db.calls).toEqual([]);
  });
});

describe('openDoor with a token', () => {
  const request = (over = {}) => ({ plain: false, local: false, profile: undefined, tokenFile: undefined, ...over });

  it('reads the profile from the database through door_profile and serves it', async () => {
    const db = database(stored('finance', { title: 'Finance Desk', reads: ['recall_my_decisions'] }));
    const door = await openDoor(request({ profile: 'finance' }), ENV, { fetch: db.fetchFn });
    expect(door.profile).toMatchObject({ id: 'finance', title: 'Finance Desk', version: 6, source: 'database', reads: ['recall_my_decisions'] });
    expect(door.summary).toBe('profile finance version 6 from the database');
    expect(db.calls).toEqual([{ fn: 'door_profile', body: { p_token: TOKEN } }]);
  });

  it('serves the assistant the token belongs to when --profile is left out, and refuses a different one', async () => {
    const online = database(stored('online'));
    expect((await openDoor(request(), ENV, { fetch: online.fetchFn })).profile.id).toBe('online');
    expect(await message(openDoor(request({ profile: 'finance' }), ENV, { fetch: online.fetchFn }))).toBe(
      'This token belongs to the online assistant, not finance. Use the token issued for finance.',
    );
  });

  it('takes the token from --token-file before FAHQ_DOOR_TOKEN, and trims it', async () => {
    const other = 'fahq_' + 'U'.repeat(43);
    const db = database(stored('owner'));
    await openDoor(request({ tokenFile: '/secure/owner.token' }), ENV, { fetch: db.fetchFn, readFile: (file) => (file === '/secure/owner.token' ? `${other}\n` : '') });
    expect(db.calls[0]!.body.p_token).toBe(other);
    const { FAHQ_DOOR_TOKEN: _unused, ...withoutEnvToken } = ENV;
    await openDoor(request({ tokenFile: '/secure/owner.token' }), withoutEnvToken, { fetch: db.fetchFn, readFile: () => `  ${other}  ` });
    expect(db.calls[1]!.body.p_token).toBe(other);
  });

  it('says what is missing, never guessing: no token, an empty or unreadable file, no address or key', async () => {
    const db = database(stored('owner'));
    const { FAHQ_DOOR_TOKEN: _unused, ...noToken } = ENV;
    expect(await message(openDoor(request(), noToken, { fetch: db.fetchFn }))).toMatch(/No door token\. Set FAHQ_DOOR_TOKEN, or pass --token-file <path>.*--local serves the file profiles offline/);
    expect(await message(openDoor(request({ tokenFile: '/x' }), ENV, { fetch: db.fetchFn, readFile: () => '\n' }))).toMatch(/No door token.*The file was empty/);
    expect(await message(openDoor(request({ tokenFile: '/x' }), ENV, { fetch: db.fetchFn, readFile: () => { throw new Error('ENOENT'); } }))).toBe('The token file /x could not be read.');
    expect(await message(openDoor(request(), { ...ENV, SUPABASE_URL: '' }, { fetch: db.fetchFn }))).toMatch(/needs SUPABASE_URL and SUPABASE_ANON_KEY/);
    expect(await message(openDoor(request(), { ...ENV, SUPABASE_ANON_KEY: undefined }, { fetch: db.fetchFn }))).toMatch(/never the service key/);
    expect(await message(openDoor(request(), { ...ENV, SUPABASE_ANON_KEY: jwt('service_role') }, { fetch: db.fetchFn }))).toMatch(/is a service key/);
    expect(db.calls).toEqual([]); // none of these reached the database
  });

  it('fails plainly when the database refuses the token, and the sentence does not hold the token', async () => {
    const text = await message(openDoor(request(), ENV, { fetch: database(null, 403).fetchFn }));
    expect(text).toBe('The door refused this token: it is not valid, or it was revoked.');
    expect(text).not.toContain(TOKEN);
  });

  it('does not serve a stored profile that breaks a rule the worker applies', async () => {
    const broken = database(stored('salon', { reads: ['get_online_metrics'] }));
    expect(await message(openDoor(request(), ENV, { fetch: broken.fetchFn }))).toMatch(/stored profile of salon was refused.*never read "get_online_metrics".*will not serve it/);
    const unreadable = database({ assistant: 'salon' });
    expect(await message(openDoor(request(), ENV, { fetch: unreadable.fetchFn }))).toMatch(/cannot read/);
  });
});

describe('the report a door files', () => {
  const draft = { tool: 'claude-code', summary: 'Fixed the tests.', steps: [{ step: 'Ran them' }], suggestions: [{ text: 'Cache the metrics' }] };

  it('is stored under a key made of the session and what it says, so a retry is one report', async () => {
    const db = database(stored('finance'));
    const door = await openDoor({ plain: false, local: false, profile: undefined, tokenFile: undefined }, ENV, { fetch: db.fetchFn, sessionId: 'aaaaaaaaaaaa' });
    await door.fileReport!(draft);
    await door.fileReport!({ ...draft });
    await door.fileReport!({ ...draft, summary: 'Fixed the tests, then the lint.' });
    const [first, retry, other] = db.calls.slice(1).map((c) => c.body.p_report);
    expect(first.key).toMatch(/^aaaaaaaaaaaa:[0-9a-f]{32}$/);
    expect(retry.key).toBe(first.key);
    expect(other.key).not.toBe(first.key);
    expect(first).toEqual({ ...draft, key: first.key });
    expect(db.calls.slice(1).every((c) => c.fn === 'door_file_report' && c.body.p_token === TOKEN)).toBe(true);
  });

  it('differs between two sessions, and is a key the database accepts', () => {
    const a = reportKey('aaaaaaaaaaaa', draft);
    expect(reportKey('bbbbbbbbbbbb', draft)).not.toBe(a);
    expect(a).toMatch(/^[A-Za-z0-9._:-]{8,80}$/);
    expect(reportKey('aaaaaaaaaaaa', { ...draft, lessons: [{ text: 'x' }] })).not.toBe(a);
  });

  it('gives each session of the same process its own id when none is injected', async () => {
    const db = database(stored('online'));
    const open = () => openDoor({ plain: false, local: false, profile: undefined, tokenFile: undefined }, ENV, { fetch: db.fetchFn });
    const [one, two] = [await open(), await open()];
    await one.fileReport!(draft);
    await two.fileReport!(draft);
    const keys = db.calls.filter((c) => c.fn === 'door_file_report').map((c) => c.body.p_report.key);
    expect(keys[0]).not.toBe(keys[1]);
  });
});
