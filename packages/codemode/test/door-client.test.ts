import { describe, expect, it } from 'vitest';
import { DoorError, createDoorClient, isServiceKey, type DoorClientConfig } from '../src/door-client.ts';

// The two calls an outside tool makes with the public anon key and its token. A fake `fetch` stands in for the
// database; the real one is covered in doors-db.test.ts.

const TOKEN = 'fahq_' + 'T'.repeat(43);
const ID = '0c1f6f0e-6f0e-4c1f-8f0e-0c1f6f0e0c1f';
const jwt = (role: string) => ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ role })).toString('base64url'), 'signature'].join('.');
const ANON = jwt('anon');

type Seen = { url: string; init: RequestInit };
function fakeFetch(answer: (seen: Seen) => Response | Promise<Response>) {
  const calls: Seen[] = [];
  const fetchFn = (async (url: URL | string, init: RequestInit) => {
    const seen = { url: String(url), init };
    calls.push(seen);
    return answer(seen);
  }) as typeof fetch;
  return { fetchFn, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const client = (fetchFn: typeof fetch, over: Partial<DoorClientConfig> = {}) => createDoorClient({ url: 'https://abc.supabase.co', anonKey: ANON, token: TOKEN, fetch: fetchFn, ...over });
const report = { tool: 'claude-code', summary: 'Checked the finance numbers.', key: 'abcd1234efgh' };

describe('the door client sends', () => {
  it('door_profile as a POST with the token in the body, the anon key in the headers, and nothing secret in the address', async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ assistant: 'finance' }));
    expect(await client(fetchFn).profile()).toEqual({ assistant: 'finance' });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://abc.supabase.co/rest/v1/rpc/door_profile');
    expect(url).not.toContain(TOKEN);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ p_token: TOKEN });
    expect(init.headers).toMatchObject({ apikey: ANON, authorization: `Bearer ${ANON}`, 'content-type': 'application/json' });
    expect(init.redirect).toBe('error'); // a redirect would carry the token to another address
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('door_file_report with the report beside the token, and returns the id and whether it was a duplicate', async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ id: ID, duplicate: false }));
    expect(await client(fetchFn).fileReport(report)).toEqual({ id: ID, duplicate: false });
    expect(calls[0]!.url).toBe('https://abc.supabase.co/rest/v1/rpc/door_file_report');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ p_token: TOKEN, p_report: report });
    const again = fakeFetch(() => json({ id: ID, duplicate: true }));
    expect(await client(again.fetchFn).fileReport(report)).toEqual({ id: ID, duplicate: true });
  });

  it('works with the local stack\'s plain http address', async () => {
    const { fetchFn, calls } = fakeFetch(() => json({}));
    await client(fetchFn, { url: 'http://127.0.0.1:54321' }).profile();
    expect(calls[0]!.url).toBe('http://127.0.0.1:54321/rest/v1/rpc/door_profile');
  });
});

describe('the door client answers a failure with one plain sentence', () => {
  const failing = (status: number, body: unknown) => client(fakeFetch(() => json(body, status)).fetchFn);

  it('says the token was refused, and not why, for a 403 or the database\'s refusal code', async () => {
    const refused = 'The door refused this token: it is not valid, or it was revoked.';
    await expect(failing(403, { code: '28000', message: 'This token is not valid.' }).profile()).rejects.toThrow(refused);
    await expect(failing(403, null).fileReport(report)).rejects.toThrow(refused);
    await expect(failing(401, { code: '28000', message: 'x' }).profile()).rejects.toThrow(refused);
  });

  it('passes on the database\'s own sentence (a limit, a missing profile), shortened', async () => {
    await expect(failing(500, { code: '54000', message: 'This token has filed 60 reports in the last hour. Try again later.' }).fileReport(report)).rejects.toThrow('This token has filed 60 reports in the last hour. Try again later.');
    await expect(failing(404, { code: 'P0002', message: 'No profile is stored for this assistant yet.' }).profile()).rejects.toThrow('No profile is stored for this assistant yet.');
    const long = await failing(400, { message: 'x'.repeat(2000) }).profile().catch((e: Error) => e);
    expect((long as Error).message.length).toBeLessThanOrEqual(300);
  });

  it('names the status when the answer says nothing useful', async () => {
    await expect(failing(502, null).profile()).rejects.toThrow('The database answered 502.');
    const html = client(fakeFetch(() => new Response('<html>bad gateway</html>', { status: 502 })).fetchFn);
    await expect(html.fileReport(report)).rejects.toThrow('The database answered 502.');
  });

  it('says it could not reach the database, naming the host only', async () => {
    const down = client((async () => { throw new TypeError('fetch failed'); }) as typeof fetch);
    const error = await down.profile().catch((e: Error) => e);
    expect(error).toBeInstanceOf(DoorError);
    expect((error as Error).message).toBe('The door could not reach abc.supabase.co: the connection failed.');
    const slow = client((async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }) as typeof fetch);
    await expect(slow.profile()).rejects.toThrow('The door could not reach abc.supabase.co: it did not answer in time.');
  });

  it('rejects a filing answer that is not an id and a flag, and never repeats the token or the key', async () => {
    await expect(client(fakeFetch(() => json({ id: 'nope', duplicate: false })).fetchFn).fileReport(report)).rejects.toThrow(/not in the expected shape/);
    await expect(client(fakeFetch(() => json({ id: ID })).fetchFn).fileReport(report)).rejects.toThrow(/not in the expected shape/);
    for (const attempt of [failing(403, null).profile(), failing(500, null).profile(), client((async () => { throw new Error(`boom ${TOKEN}`); }) as typeof fetch).profile()]) {
      const message = ((await attempt.catch((e: Error) => e)) as Error).message;
      expect(message).not.toContain(TOKEN);
      expect(message).not.toContain(ANON);
    }
  });
});

describe('the door client refuses a bad setup before any call', () => {
  const never = fakeFetch(() => json({}));

  it('refuses an address that is not a web address', () => {
    expect(() => client(never.fetchFn, { url: 'not a url' })).toThrow('SUPABASE_URL is not a web address.');
    expect(() => client(never.fetchFn, { url: 'ftp://abc.supabase.co' })).toThrow(/must start with https:\/\//);
    expect(() => client(never.fetchFn, { url: '' })).toThrow(DoorError);
  });

  it('refuses a missing key and a service key: a door uses the public key only', () => {
    expect(() => client(never.fetchFn, { anonKey: '  ' })).toThrow('SUPABASE_ANON_KEY is empty.');
    expect(() => client(never.fetchFn, { anonKey: jwt('service_role') })).toThrow(/is a service key/);
    expect(() => client(never.fetchFn, { anonKey: 'sb_secret_abcdefghijklmnop' })).toThrow(/is a service key/);
    expect(() => client(never.fetchFn, { anonKey: 'sb_publishable_abcdefghijklmnop' })).not.toThrow();
    expect(() => client(never.fetchFn, { anonKey: jwt('authenticated') })).not.toThrow();
  });

  it('recognises a service key whatever else the token holds, and ignores text that is not a token', () => {
    expect(isServiceKey(jwt('service_role'))).toBe(true);
    expect(isServiceKey(jwt('anon'))).toBe(false);
    expect(isServiceKey('plain-text')).toBe(false);
    expect(isServiceKey('a.!!!.c')).toBe(false);
    expect(isServiceKey(`a.${Buffer.from('[1]').toString('base64url')}.c`)).toBe(false);
  });

  it('refuses a token that is not in the shape the database accepts', () => {
    for (const token of ['', 'short', 'x'.repeat(129), `${'a'.repeat(40)} `, `${'a'.repeat(40)}/`, `${'a'.repeat(40)}\n`]) {
      expect(() => client(never.fetchFn, { token }), JSON.stringify(token)).toThrow(/not in the shape the database accepts/);
    }
    expect(never.calls).toHaveLength(0);
  });
});
