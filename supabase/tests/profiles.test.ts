import { execSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssistantId, maskPhonesAndCodes } from '@fahq/contracts';
import { REDACT_SAMPLES } from '../../packages/contracts/test/redact-samples.ts';
import { READ_TOOL_NAMES, canonicalJson, createProfileSource, issueDoorToken, loadProfiles, managerNotes, newDoorToken, parseProfileRows, restoreProfileVersion, seedProfiles, tokenHash, withManagerNotes } from '@fahq/profiles';

// Profiles in the database, the two doors an outside tool may call, and what the public (anon) role can reach.
// Real Postgres and the real Data API (local Supabase: npm run db:start); nothing is mocked.
//  - The "doors" and "privileges" groups run against the shared local database. They write only tokens and
//    session reports (which they delete again) and read the five seeded profiles. A profile version is
//    append-only, so nothing here may add one to the shared database.
//  - The "profile writes" group builds a throwaway database from the real migration file, so it can commit
//    versions, race two writers and reseed as often as it likes.

const url = process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const isLocal = /@(127\.0\.0\.1|localhost|\[::1\]):/.test(url);
// The migrations that make the profile tables and doors, in order (the second one replaces two helper functions).
const MIGRATIONS = ['20261027100000_profiles.sql', '20261027100200_profiles_review.sql'].map((name) => path.resolve(import.meta.dirname, '../migrations', name));
const runMigrations = async (db: pg.Pool) => {
  for (const file of MIGRATIONS) await db.query(fs.readFileSync(file, 'utf8'));
};

const pool = new pg.Pool({ connectionString: url, max: 6 });
let ready = false;
let keys: { url: string; anon: string } | null = null;
const madeTokens: string[] = [];

function localKeys(): { url: string; anon: string } | null {
  try {
    const out = execSync('npx supabase status -o env', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 });
    const get = (name: string) => out.match(new RegExp(`^${name}="?([^"\\n]*)"?$`, 'm'))?.[1];
    const apiUrl = get('API_URL');
    const anon = get('ANON_KEY');
    return apiUrl && anon ? { url: apiUrl, anon } : null;
  } catch {
    return null;
  }
}

beforeAll(async () => {
  if (!isLocal) return console.warn('SKIPPED profile database tests: SUPABASE_DB_URL does not point at the local stack');
  try {
    ready = (await pool.query(`select to_regclass('public.assistant_profiles') as t`)).rows[0].t !== null;
  } catch {
    return console.warn(`SKIPPED profile database tests: no Postgres at ${url.replace(/:[^:@/]+@/, ':***@')} (run npm run db:start)`);
  }
  if (!ready) return console.warn('SKIPPED profile database tests: apply supabase/migrations/20261027100000_profiles.sql first');
  keys = localKeys();
  if (!keys) console.warn('SKIPPED the Data API checks: `supabase status` did not answer');
  await seedProfiles(pool, {}); // an assistant with no row gets one; the others are left alone
});

afterAll(async () => {
  try {
    if (madeTokens.length > 0) {
      await pool.query('delete from public.session_reports where token_id = any($1)', [madeTokens]);
      await pool.query('delete from public.door_tokens where id = any($1)', [madeTokens]);
    }
  } finally {
    await pool.end();
  }
});

// ---- Helpers -----------------------------------------------------------------------------------------

async function newToken(assistant: AssistantId): Promise<string> {
  const issued = await issueDoorToken(pool, assistant, 'profiles test');
  madeTokens.push(issued.id);
  return issued.token;
}
const tokenRowId = async (token: string) => (await pool.query('select id from public.door_tokens where token_hash = $1', [tokenHash(token)])).rows[0].id as string;

type Reply = { status: number; body: any };
async function dataApi(pathAndQuery: string, init: { method?: string; body?: unknown } = {}): Promise<Reply> {
  const res = await fetch(`${keys!.url}/rest/v1/${pathAndQuery}`, {
    method: init.method ?? 'GET',
    headers: { apikey: keys!.anon, authorization: `Bearer ${keys!.anon}`, 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const rpc = (fn: 'door_profile' | 'door_file_report', body: unknown) => dataApi(`rpc/${fn}`, { method: 'POST', body });
const file = (token: string, report: Record<string, unknown>) => rpc('door_file_report', { p_token: token, p_report: report });
const base = (over: Record<string, unknown> = {}) => ({ tool: 'claude-code', summary: 'Checked the finance numbers.', ...over });

async function denied(client: pg.PoolClient, sql: string) {
  await client.query('savepoint refused');
  await expect(client.query(sql)).rejects.toThrow(/permission denied/);
  await client.query('rollback to savepoint refused');
}

async function asRole<T>(role: string, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${role}`);
    return await work(client);
  } finally {
    await client.query('rollback');
    client.release();
  }
}

// ---- The doors ------------------------------------------------------------------------------------------

describe('door_profile (called with the public anon key, through the Data API)', () => {
  it('gives a valid token the profile of its own assistant: skill, reads, models and lessons', async ({ skip }) => {
    if (!ready || !keys) skip();
    const token = await newToken('finance');
    const reply = await rpc('door_profile', { p_token: token });
    expect(reply.status).toBe(200);
    const row = (await pool.query(`select * from public.assistant_profiles where assistant_id = 'finance'`)).rows[0];
    expect(reply.body).toEqual({
      assistant: 'finance', title: row.title, version: row.version, skill: row.skill, reads: row.reads, models: row.models, lessons: row.lessons,
    });
    expect(reply.body.reads).toContain('get_finance_metrics');
    expect(JSON.stringify(reply.body)).not.toContain(token);
    expect(JSON.stringify(reply.body)).not.toContain(tokenHash(token));
  });

  it('gives each token only its own assistant, so the salon and the online store never see each other', async ({ skip }) => {
    if (!ready || !keys) skip();
    const salon = await rpc('door_profile', { p_token: await newToken('salon') });
    const online = await rpc('door_profile', { p_token: await newToken('online') });
    expect(salon.body.assistant).toBe('salon');
    expect(online.body.assistant).toBe('online');
    expect(salon.body.reads).toContain('get_salon_metrics');
    expect(salon.body.reads).not.toContain('get_online_metrics');
    expect(online.body.reads).toContain('get_online_metrics');
    expect(online.body.reads).not.toContain('get_salon_metrics');
  });

  it('refuses everything that is not a live token, with one answer that says nothing about why', async ({ skip }) => {
    if (!ready || !keys) skip();
    const revoked = await newToken('owner');
    await pool.query('update public.door_tokens set revoked_at = now() where id = $1', [await tokenRowId(revoked)]);
    const hash = tokenHash(await newToken('owner'));
    const refused = [null, '', 'nope', 'x'.repeat(31), 'x'.repeat(129), newDoorToken(), revoked, hash, `${newDoorToken()}' or '1'='1`];
    for (const candidate of refused) {
      const reply = await rpc('door_profile', { p_token: candidate });
      expect(reply.status, String(candidate)).toBe(403);
      expect(reply.body).toMatchObject({ code: '28000', message: 'This token is not valid.' });
      expect(reply.body.skill).toBeUndefined();
    }
    const missing = await rpc('door_profile', {});
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(missing.body.skill).toBeUndefined();
  });

  it('refuses a token sent in a URL (a GET), which the Data API runs read-only, and the same token works as a POST', async ({ skip }) => {
    if (!ready || !keys) skip();
    const token = await newToken('owner');
    const viaUrl = await dataApi(`rpc/door_profile?p_token=${token}`);
    expect(viaUrl.status).toBe(405);
    expect(viaUrl.body).toMatchObject({ code: '25006', message: 'Send the token in a POST body, never in a URL.' });
    expect(viaUrl.body.skill).toBeUndefined();
    expect((await rpc('door_profile', { p_token: token })).status).toBe(200);
  });

  it('says so plainly when a valid token has no stored profile yet, and never makes one up', async ({ skip }) => {
    if (!ready) skip();
    const token = await newToken('manager');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`delete from public.assistant_profiles where assistant_id = 'manager'`);
      await expect(client.query('select public.door_profile($1)', [token])).rejects.toThrow('No profile is stored for this assistant yet.');
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});

describe('door_file_report (called with the public anon key, through the Data API)', () => {
  it('stores a report under the assistant of the token', async ({ skip }) => {
    if (!ready || !keys) skip();
    const token = await newToken('salon');
    const reply = await file(token, base({
      steps: [{ step: 'read_metrics' }],
      suggestions: [{ text: 'Say which period a number is for.' }],
      lessons: [{ text: 'Ask which month before answering.' }],
    }));
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), duplicate: false });
    const row = (await pool.query('select * from public.session_reports where id = $1', [reply.body.id])).rows[0];
    expect(row).toMatchObject({
      token_id: await tokenRowId(token), assistant_id: 'salon', tool: 'claude-code', summary: 'Checked the finance numbers.', reviewed_at: null,
      steps: [{ step: 'read_metrics' }],
      suggestions: [{ text: 'Say which period a number is for.' }],
      lessons: [{ text: 'Ask which month before answering.' }],
    });
  });

  it('masks phone numbers and six-digit codes everywhere in the report, and leaves ordinary numbers alone', async ({ skip }) => {
    if (!ready || !keys) skip();
    const reply = await file(await newToken('finance'), {
      tool: 'cursor +15551234567',
      summary: 'Called +15551234567, (917) 555-0123, 917-555-0123 and 9175550123; the code was 123456 and SEND 2 482913. Cost $120000, 1,234,567 tokens, 12345 and 1234567.',
      steps: [{ step: 'texted 917.555.0123 code: 654321' }],
      suggestions: [{ text: 'Never repeat 111222 to anyone.' }],
      lessons: [{ text: 'Mask +1 555 123 4567 and 999888.' }],
    });
    expect(reply.status).toBe(200);
    const row = (await pool.query('select tool, summary, steps, suggestions, lessons from public.session_reports where id = $1', [reply.body.id])).rows[0];
    expect(row.tool).toBe('cursor [phone]');
    expect(row.summary).toBe('Called [phone], [phone], [phone] and [phone]; the code was [code] and SEND 2 [code]. Cost $120000, 1,234,567 tokens, 12345 and 1234567.');
    expect(row.steps).toEqual([{ step: 'texted [phone] code: [code]' }]);
    expect(row.suggestions).toEqual([{ text: 'Never repeat [code] to anyone.' }]);
    expect(row.lessons).toEqual([{ text: 'Mask [phone] and [code].' }]);
  });

  it('masks a phone number written without its brackets or dash, and a code written in two groups, in a report an outside tool files', async ({ skip }) => {
    if (!ready || !keys) skip();
    const reply = await file(await newToken('online'), {
      tool: 'codex',
      summary: 'Rang (718)555-1234, then 718 5551234 and call 718-5551234; the code was 482-913, then 482 913.',
      steps: [{ step: '1 718 555 1234' }],
      suggestions: [{ text: 'Ask for 718.555.1234 again.' }],
      lessons: [{ text: 'Never keep 7185551234.' }],
    });
    expect(reply.status).toBe(200);
    const row = (await pool.query('select summary, steps, suggestions, lessons from public.session_reports where id = $1', [reply.body.id])).rows[0];
    expect(row.summary).toBe('Rang [phone], then [phone] and call [phone]; the code was [code], then [code].');
    expect(row.steps).toEqual([{ step: '[phone]' }]);
    expect(row.suggestions).toEqual([{ text: 'Ask for [phone] again.' }]);
    expect(row.lessons).toEqual([{ text: 'Never keep [phone].' }]);
  });

  it('masks exactly what the lesson rules and the read tools mask: one list of strings through the database and through @fahq/contracts', async ({ skip }) => {
    if (!ready) skip();
    for (const [input, expected] of REDACT_SAMPLES) {
      const { rows } = await pool.query('select public.redact_text($1) as masked', [input]);
      expect(rows[0].masked, `the database on ${JSON.stringify(input)}`).toBe(expected);
      expect(maskPhonesAndCodes(input), `@fahq/contracts on ${JSON.stringify(input)}`).toBe(expected);
    }
  });

  it('stores a retried report once (same token, same key) and returns the first one', async ({ skip }) => {
    if (!ready || !keys) skip();
    const token = await newToken('online');
    const key = `retry-${randomBytes(6).toString('hex')}`;
    const first = await file(token, base({ key }));
    const second = await file(token, base({ key, summary: 'A retry with other words.' }));
    expect(first.body.duplicate).toBe(false);
    expect(second.body).toEqual({ id: first.body.id, duplicate: true });
    const { rows } = await pool.query('select summary from public.session_reports where token_id = $1', [await tokenRowId(token)]);
    expect(rows).toEqual([{ summary: 'Checked the finance numbers.' }]);
    // The same key under another token is another report.
    const other = await file(await newToken('online'), base({ key }));
    expect(other.body).toEqual({ id: expect.not.stringMatching(first.body.id), duplicate: false });
  });

  it.each([
    ['a report that is not an object', ['tool'], /must be a JSON object/],
    ['a missing tool', { summary: 'x' }, /needs a "tool"/],
    ['a tool of 61 characters', { tool: 'x'.repeat(61), summary: 'x' }, /needs a "tool" of 1 to 60/],
    ['a missing summary', { tool: 'x' }, /needs a "summary"/],
    ['a summary of 2001 characters', base({ summary: 'x'.repeat(2001) }), /"summary" of 1 to 2000/],
    ['a field the door does not know', base({ model: 'x' }), /field this door does not accept/],
    ['a key that is too short', base({ key: 'abc' }), /"key" must be 8 to 80/],
    ['a key that is not text', base({ key: 12345678 }), /"key" must be 8 to 80/],
    ['31 steps', base({ steps: Array.from({ length: 31 }, () => ({ step: 's' })) }), /steps must be a list of at most 30/],
    ['a step of 81 characters', base({ steps: [{ step: 'x'.repeat(81) }] }), /steps needs a "step" of 1 to 80/],
    ['a step that is only text', base({ steps: ['read'] }), /steps needs a "step"/],
    ['11 suggestions', base({ suggestions: Array.from({ length: 11 }, () => ({ text: 's' })) }), /suggestions must be a list of at most 10/],
    ['a suggestion of 301 characters', base({ suggestions: [{ text: 'x'.repeat(301) }] }), /suggestions needs a "text" of 1 to 300/],
    ['a lesson with no text', base({ lessons: [{ note: 'x' }] }), /lessons needs a "text"/],
    ['lessons that are not a list', base({ lessons: 'be kind' }), /lessons must be a list/],
    ['more than 32 KB', base({ steps: Array.from({ length: 30 }, () => ({ step: 's', detail: 'd'.repeat(1500) })) }), /larger than 32 KB/],
    // An item holds its one field and nothing else: another key would be stored, unmasked if it were a number.
    ['an extra key in a step', base({ steps: [{ step: 's', detail: 'x' }] }), /steps has a "step" and nothing else/],
    ['an extra key in a suggestion', base({ suggestions: [{ text: 's', kind: 'prompt' }] }), /suggestions has a "text" and nothing else/],
    ['a phone number written as a number in a lesson', base({ lessons: [{ text: 's', phone: 7185551234 }] }), /lessons has a "text" and nothing else/],
    ['an extra key in the second of two steps', base({ steps: [{ step: 'a' }, { step: 'b', detail: { deep: { deeper: 1 } } }] }), /steps has a "step" and nothing else/],
  ])('refuses %s with a plain sentence and stores nothing', async (_name, report, message) => {
    if (!ready || !keys) return;
    const token = await newToken('finance');
    const reply = await file(token, report as Record<string, unknown>);
    expect(reply.status).toBe(400);
    expect(reply.body.code).toBe('22023');
    expect(reply.body.message).toMatch(message);
    const { rows } = await pool.query('select count(*)::int as n from public.session_reports where token_id = $1', [await tokenRowId(token)]);
    expect(rows[0].n).toBe(0);
  });

  it('files nothing for a token that is not valid', async ({ skip }) => {
    if (!ready || !keys) skip();
    const before = (await pool.query('select count(*)::int as n from public.session_reports')).rows[0].n;
    const revoked = await newToken('owner');
    await pool.query('update public.door_tokens set revoked_at = now() where id = $1', [await tokenRowId(revoked)]);
    for (const candidate of [null, 'nope', newDoorToken(), revoked]) {
      const reply = await file(candidate as string, base());
      expect(reply.status).toBe(403);
      expect(reply.body.message).toBe('This token is not valid.');
    }
    expect((await pool.query('select count(*)::int as n from public.session_reports')).rows[0].n).toBe(before);
  });

  it('stops a token after 60 reports in an hour', async ({ skip }) => {
    if (!ready || !keys) skip();
    const token = await newToken('manager');
    const id = await tokenRowId(token);
    await pool.query(
      `insert into public.session_reports (token_id, assistant_id, tool, summary) select $1, 'manager', 'bulk', 'filler ' || g from generate_series(1, 60) g`,
      [id],
    );
    const reply = await file(token, base());
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(reply.body).toMatchObject({ code: '54000', message: 'This token has filed 60 reports in the last hour. Try again later.' });
    expect((await pool.query('select count(*)::int as n from public.session_reports where token_id = $1', [id])).rows[0].n).toBe(60);
    // An older hour does not count against it.
    await pool.query(`update public.session_reports set created_at = now() - interval '2 hours' where token_id = $1 and summary = 'filler 1'`, [id]);
    expect((await file(token, base())).status).toBe(200);
  });
});

describe('what the token table keeps', () => {
  it('stores only the SHA-256 of a token, and the database agrees with the hash the script computes', async ({ skip }) => {
    if (!ready) skip();
    const token = await newToken('owner');
    const cols = (await pool.query(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'door_tokens' order by 1`)).rows.map((r) => r.column_name);
    expect(cols).toEqual(['assistant_id', 'created_at', 'id', 'label', 'revoked_at', 'token_hash']);
    const { rows } = await pool.query(
      `select token_hash = encode(extensions.digest($1::text, 'sha256'), 'hex') as same, t::text like '%' || $1 || '%' as leaks
         from public.door_tokens t where t.id = $2`,
      [token, await tokenRowId(token)],
    );
    expect(rows[0]).toEqual({ same: true, leaks: false });
    expect((await pool.query(`select count(*)::int as n from public.door_tokens where token_hash !~ '^[0-9a-f]{64}$'`)).rows[0].n).toBe(0);
    await expect(pool.query(`insert into public.door_tokens (assistant_id, token_hash, label) values ('owner', $1, 'plain')`, [token])).rejects.toThrow(/violates check constraint/);
  });
});

// ---- What the public role can reach ---------------------------------------------------------------------

describe('the public (anon) and signed-in (authenticated) roles', () => {
  it('hold no privilege on any table, today or on a table made later', async ({ skip }) => {
    if (!ready) skip();
    const grants = await pool.query(`select grantee, table_name from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated')`);
    expect(grants.rows).toEqual([]);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('create table public.zz_later_table (id integer)');
      const { rows } = await client.query(
        `select has_table_privilege('anon', 'public.zz_later_table', 'select') as anon,
                has_table_privilege('authenticated', 'public.zz_later_table', 'select') as authenticated,
                has_table_privilege('service_role', 'public.zz_later_table', 'select') as service`,
      );
      expect(rows[0]).toEqual({ anon: false, authenticated: false, service: true });
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  it.each(['anon', 'authenticated'])('%s cannot read, insert, change, delete or empty any table in the database', async (role) => {
    if (!ready) return;
    const found = (await pool.query(
      `select t.table_name, c.column_name from information_schema.tables t
         join information_schema.columns c on c.table_schema = t.table_schema and c.table_name = t.table_name and c.ordinal_position = 1
        where t.table_schema = 'public' and t.table_type = 'BASE TABLE' order by 1`,
    )).rows as { table_name: string; column_name: string }[];
    const tables = found.map((r) => r.table_name);
    for (const needed of ['assistant_profiles', 'assistant_profile_versions', 'door_tokens', 'session_reports', 'tasks', 'people', 'outbox']) expect(tables).toContain(needed);
    await asRole(role, async (client) => {
      for (const { table_name: table, column_name: column } of found) {
        await denied(client, `select 1 from public.${table} limit 1`);
        await denied(client, `insert into public.${table} default values`);
        await denied(client, `update public.${table} set "${column}" = default where false`);
        await denied(client, `delete from public.${table} where false`);
        await denied(client, `truncate public.${table}`);
      }
    });
  });

  it('are refused by the Data API too: no rows come back from any new table, and nothing can be inserted', async ({ skip }) => {
    if (!ready || !keys) skip();
    for (const table of ['assistant_profiles', 'assistant_profile_versions', 'door_tokens', 'session_reports']) {
      const read = await dataApi(`${table}?limit=1`);
      expect([401, 403, 404], `${table} read`).toContain(read.status);
      expect(Array.isArray(read.body), `${table} read`).toBe(false);
      const write = await dataApi(table, { method: 'POST', body: {} });
      expect([401, 403, 404], `${table} insert`).toContain(write.status);
    }
  });

  it('can run exactly the two doors and no other function in the schema', async ({ skip }) => {
    if (!ready) skip();
    const callable = async (role: string) => (await pool.query(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and has_function_privilege($1, p.oid, 'execute') order by 1`,
      [role],
    )).rows.map((r) => r.proname as string);
    expect(await callable('anon')).toEqual(['door_file_report', 'door_profile']);
    expect(await callable('authenticated')).toEqual([]);
    // The door functions run as their owner (so RLS never blocks them) and cannot be pointed at another schema.
    const doors = await pool.query(`select proname, prosecdef, proconfig from pg_proc where proname in ('door_profile', 'door_file_report', 'door_token') order by 1`);
    for (const door of doors.rows) {
      expect(door.prosecdef, door.proname).toBe(true);
      expect(door.proconfig, door.proname).toEqual(['search_path=""']);
    }
  });
});

// ---- Versions are append-only ---------------------------------------------------------------------------

describe('assistant_profile_versions', () => {
  it('refuses update, delete and truncate, even from the table owner', async ({ skip }) => {
    if (!ready) skip();
    const client = await pool.connect();
    try {
      for (const sql of [
        `update public.assistant_profile_versions set reason = 'edited'`,
        `delete from public.assistant_profile_versions`,
        `truncate public.assistant_profile_versions`,
      ]) {
        await client.query('begin');
        await expect(client.query(sql), sql).rejects.toThrow('assistant_profile_versions is append-only');
        await client.query('rollback');
      }
    } finally {
      client.release();
    }
    expect((await pool.query('select count(*)::int as n from public.assistant_profile_versions')).rows[0].n).toBeGreaterThanOrEqual(5);
  });

  it('is closed to the service role as well: it can read and add, never change or remove', async ({ skip }) => {
    if (!ready) skip();
    await asRole('service_role', async (client) => {
      await client.query('select 1 from public.assistant_profile_versions limit 1');
      await denied(client, `update public.assistant_profile_versions set reason = 'edited'`);
      await denied(client, 'delete from public.assistant_profile_versions');
      await denied(client, 'truncate public.assistant_profile_versions');
    });
  });
});

// ---- Writing and seeding profiles, in a throwaway database made from the real migration -----------------

describe('profile writes (a throwaway database built from the real migration file)', () => {
  let admin: pg.Pool;
  let scratch: pg.Pool;
  let scratchName = '';

  beforeAll(async () => {
    if (!isLocal) return;
    try {
      admin = new pg.Pool({ connectionString: url, max: 1 });
      scratchName = `profiles_scratch_${randomBytes(4).toString('hex')}`; // made here, never taken from input
      await admin.query(`create database ${scratchName}`);
      const target = new URL(url);
      target.pathname = `/${scratchName}`;
      scratch = new pg.Pool({ connectionString: target.toString(), max: 4 });
      // Only what the migration expects to find already there (including Supabase's default grants to the Data API
      // roles, which the migration takes back); the migration file itself runs unchanged.
      await scratch.query(`
        create schema extensions;
        create extension pgcrypto with schema extensions;
        alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
        create type public.assistant_id as enum ('owner', 'finance', 'salon', 'online', 'manager', 'legal');
        create table public.assistants (id public.assistant_id primary key);
        insert into public.assistants values ('owner'), ('finance'), ('salon'), ('online'), ('manager'), ('legal');`);
      await runMigrations(scratch);
    } catch (error) {
      console.warn(`SKIPPED the profile write tests: could not build a scratch database (${error instanceof Error ? error.message : 'unknown'})`);
      scratchName = '';
    }
  });

  afterAll(async () => {
    await scratch?.end().catch(() => undefined);
    if (scratchName) await admin.query(`drop database ${scratchName} with (force)`).catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  const files = loadProfiles({});
  const save = (id: string, expected: number | null, over: { title?: string; lessons?: unknown[]; by?: string } = {}, db: pg.Pool = scratch) =>
    db.query(
      `select public.save_assistant_profile($1::public.assistant_id, $2::integer, $3, $4, $5::text[], $6::jsonb, $7::jsonb, $8, 'a test', '{"kind":"test"}'::jsonb) as v`,
      [id, expected, over.title ?? `Title for ${id}`, files.finance.skill, ['my_lessons'], JSON.stringify(files.finance.models), JSON.stringify(over.lessons ?? []), over.by ?? 'manager'],
    ).then((r) => r.rows[0].v as number | null);
  const versionsOf = async (id: string) => (await scratch.query('select version, made_by, reason, snapshot from public.assistant_profile_versions where assistant_id = $1 order by version', [id])).rows;

  it('creates a profile once, then only changes it from the version the writer last saw', async ({ skip }) => {
    if (!scratchName) skip();
    expect(await save('owner', null, { by: 'seed' })).toBe(1);
    expect(await save('owner', null)).toBeNull(); // already there
    expect(await save('owner', 7)).toBeNull(); // not at that version
    expect(await save('owner', 1, { title: 'Second' })).toBe(2);
    expect(await save('owner', 1, { title: 'Stale' })).toBeNull(); // another writer got to version 2 first
    expect(await save('owner', 2, { title: 'Third', by: 'owner' })).toBe(3);
    const row = (await scratch.query(`select version, title, updated_by from public.assistant_profiles where assistant_id = 'owner'`)).rows[0];
    expect(row).toEqual({ version: 3, title: 'Third', updated_by: 'owner' });
    const versions = await versionsOf('owner');
    expect(versions.map((v) => [v.version, v.made_by])).toEqual([[1, 'seed'], [2, 'manager'], [3, 'owner']]);
    expect(versions.map((v) => v.snapshot.title)).toEqual(['Title for owner', 'Second', 'Third']);
    expect(versions[2].snapshot).toEqual({ title: 'Third', skill: files.finance.skill, reads: ['my_lessons'], models: JSON.parse(JSON.stringify(files.finance.models)), lessons: [] });
  });

  it('refuses a writer that is not seed, manager or owner, and a profile that breaks the table limits', async ({ skip }) => {
    if (!scratchName) skip();
    await expect(save('finance', null, { by: 'anyone' })).rejects.toThrow(/updated_by_check/);
    await expect(save('finance', null, { title: '' })).rejects.toThrow(/title_check/);
    await expect(scratch.query(`select public.save_assistant_profile('finance', null, 't', 'short', '{}', '{}', '[]', 'seed', 'r')`)).rejects.toThrow(/skill_check/);
    await expect(scratch.query(`select public.save_assistant_profile('finance', null, 't', repeat('x', 50), '{"Bad Name"}', '{}', '[]', 'seed', 'r')`)).rejects.toThrow(/reads_check/);
    expect((await scratch.query(`select count(*)::int as n from public.assistant_profiles where assistant_id = 'finance'`)).rows[0].n).toBe(0);
    expect(await versionsOf('finance')).toEqual([]);
  });

  it('gives exactly one of two writers racing from the same version the next version', async ({ skip }) => {
    if (!scratchName) skip();
    expect(await save('online', null, { by: 'seed' })).toBe(1);
    const [a, b] = await Promise.all([save('online', 1, { title: 'Writer A' }), save('online', 1, { title: 'Writer B' })]);
    expect([a, b].filter((v) => v === 2)).toHaveLength(1);
    expect([a, b].filter((v) => v === null)).toHaveLength(1);
    const versions = await versionsOf('online');
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    const row = (await scratch.query(`select version, title from public.assistant_profiles where assistant_id = 'online'`)).rows[0];
    expect(row.version).toBe(2);
    expect(row.title).toBe(versions[1].snapshot.title);
  });

  it('gives exactly one of two writers racing to create the same profile its first version', async ({ skip }) => {
    if (!scratchName) skip();
    const results = await Promise.all([save('salon', null), save('salon', null), save('salon', null)]);
    expect(results.filter((v) => v === 1)).toHaveLength(1);
    expect(results.filter((v) => v === null)).toHaveLength(2);
    expect((await versionsOf('salon')).map((v) => v.version)).toEqual([1]);
  });

  it('numbers versions from the history, so a profile removed and made again never reuses a number', async ({ skip }) => {
    if (!scratchName) skip();
    expect(await save('manager', null, { by: 'seed' })).toBe(1);
    expect(await save('manager', 1)).toBe(2);
    await scratch.query(`delete from public.assistant_profiles where assistant_id = 'manager'`); // the history stays
    expect(await save('manager', null, { by: 'owner' })).toBe(3);
    expect((await versionsOf('manager')).map((v) => v.version)).toEqual([1, 2, 3]);
  });

  it('can be called by the service role (the worker) and by nobody else', async ({ skip }) => {
    if (!scratchName) skip();
    const call = (role: string) => `set local role ${role}; select public.save_assistant_profile('finance', null, 'T', repeat('x', 50), '{}', '{}', '[]', 'owner', 'r')`;
    const client = await scratch.connect();
    try {
      for (const role of ['anon', 'authenticated']) {
        await client.query('begin');
        await expect(client.query(call(role)), role).rejects.toThrow(/permission denied for function save_assistant_profile/);
        await client.query('rollback');
      }
      await client.query('begin');
      const results = await client.query(call('service_role'));
      expect((results as unknown as { rows: Record<string, unknown>[] }[])[1]!.rows[0]!.save_assistant_profile).toBe(1);
      await client.query('rollback');
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });

  it('masks every string and key in a JSON value, in order, and leaves numbers, booleans and nulls alone', async ({ skip }) => {
    if (!scratchName) skip();
    const input = { 'call +15551234567': [3, 'b 123456', null, true, { '917-555-0123': 1.5, keep: 'ok 12345' }], list: ['a', 'b', 'c'] };
    const { rows } = await scratch.query('select public.redact_json($1::jsonb) as v', [JSON.stringify(input)]);
    expect(rows[0].v).toEqual({ 'call [phone]': [3, 'b [code]', null, true, { '[phone]': 1.5, keep: 'ok 12345' }], list: ['a', 'b', 'c'] });
    expect((await scratch.query(`select public.redact_json('"plain"') as v, public.redact_json('[]') as e, public.redact_json('{}') as o`)).rows[0]).toEqual({ v: 'plain', e: [], o: {} });
    // Nesting deeper than six levels is refused (no door item can nest at all any more, but the function still guards itself).
    await expect(scratch.query(`select public.redact_json('{"a":{"b":{"c":{"d":{"e":{"f":{"g":"deep"}}}}}}}'::jsonb)`)).rejects.toThrow('nested too deeply');
  });

  it('refuses a list item with a key but its own field, and accepts one with only its field', async ({ skip }) => {
    if (!scratchName) skip();
    const check = (list: unknown) => scratch.query(`select public.door_check_list($1::jsonb, 'steps', 30, 'step', 80)`, [JSON.stringify(list)]);
    await expect(check([{ step: 'a' }, { step: 'b' }])).resolves.toBeDefined();
    await expect(check([])).resolves.toBeDefined();
    await expect(check([{ step: 'a', detail: 'x' }])).rejects.toThrow('Every item in the report\'s steps has a "step" and nothing else.');
    await expect(check([{ step: 'a', step2: 'x' }])).rejects.toThrow('has a "step" and nothing else');
    await expect(check([{ step: 'a' }, 'b'])).rejects.toThrow('needs a "step" of 1 to 80 characters'); // not an object: the older check still comes first
  });

  it('masks a phone number or code the same in the scratch database made from the migration files as on the stack', async ({ skip }) => {
    if (!scratchName) skip();
    for (const [input, expected] of REDACT_SAMPLES) {
      expect((await scratch.query('select public.redact_text($1) as masked', [input])).rows[0].masked, JSON.stringify(input)).toBe(expected);
    }
  });

  it('keeps the history append-only on a database that has committed versions', async ({ skip }) => {
    if (!scratchName) skip();
    await expect(scratch.query(`update public.assistant_profile_versions set reason = 'edited'`)).rejects.toThrow('append-only');
    await expect(scratch.query('delete from public.assistant_profile_versions')).rejects.toThrow('append-only');
    await expect(scratch.query('truncate public.assistant_profile_versions')).rejects.toThrow('append-only');
    expect((await scratch.query('select count(*)::int as n from public.assistant_profile_versions')).rows[0].n).toBeGreaterThan(5);
  });
});

describe('seeding profiles (a second throwaway database)', () => {
  let admin: pg.Pool;
  let scratch: pg.Pool;
  let scratchName = '';

  beforeAll(async () => {
    if (!isLocal) return;
    try {
      admin = new pg.Pool({ connectionString: url, max: 1 });
      scratchName = `profiles_seed_${randomBytes(4).toString('hex')}`;
      await admin.query(`create database ${scratchName}`);
      const target = new URL(url);
      target.pathname = `/${scratchName}`;
      scratch = new pg.Pool({ connectionString: target.toString(), max: 2 });
      await scratch.query(`
        create schema extensions;
        create extension pgcrypto with schema extensions;
        alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
        create type public.assistant_id as enum ('owner', 'finance', 'salon', 'online', 'manager', 'legal');
        create table public.assistants (id public.assistant_id primary key);
        insert into public.assistants values ('owner'), ('finance'), ('salon'), ('online'), ('manager'), ('legal');`);
      await runMigrations(scratch);
    } catch (error) {
      console.warn(`SKIPPED the seed tests: could not build a scratch database (${error instanceof Error ? error.message : 'unknown'})`);
      scratchName = '';
    }
  });

  afterAll(async () => {
    await scratch?.end().catch(() => undefined);
    if (scratchName) await admin.query(`drop database ${scratchName} with (force)`).catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  const files = loadProfiles({});
  const stored = async () => (await scratch.query('select * from public.assistant_profiles order by assistant_id')).rows;
  const versionCount = async () => (await scratch.query('select count(*)::int as n from public.assistant_profile_versions')).rows[0].n as number;

  it('stores the five file profiles once, each with a version made by "seed"', async ({ skip }) => {
    if (!scratchName) skip();
    const first = await seedProfiles(scratch, {});
    expect(first.map((r) => [r.assistant, r.action, r.version, r.differsFromFiles])).toEqual(
      AssistantId.options.map((id) => [id, 'created', 1, false]),
    );
    const versions = (await scratch.query(`select assistant_id, version, made_by, reason, snapshot from public.assistant_profile_versions order by assistant_id`)).rows;
    expect(versions).toHaveLength(5);
    for (const v of versions) {
      const p = files[v.assistant_id as AssistantId];
      expect(v.made_by).toBe('seed');
      expect(v.reason).toBe('seeded from the files (skills and model defaults)');
      expect(canonicalJson(v.snapshot)).toBe(canonicalJson({ title: p.title, skill: p.skill, reads: [...p.reads], models: p.models, lessons: [] }));
    }
    // What was stored is what the worker will read back.
    const parsed = parseProfileRows(await stored(), READ_TOOL_NAMES);
    expect(parsed.problems).toEqual([]);
    expect([...parsed.rows.keys()].sort()).toEqual([...AssistantId.options].sort());
  });

  it('is idempotent: running it again changes nothing', async ({ skip }) => {
    if (!scratchName) skip();
    await seedProfiles(scratch, {});
    const before = JSON.stringify(await stored());
    const versions = await versionCount();
    const again = await seedProfiles(scratch, {});
    expect(again.map((r) => [r.assistant, r.action, r.version])).toEqual(AssistantId.options.map((id) => [id, 'kept', 1]));
    expect(JSON.stringify(await stored())).toBe(before);
    expect(await versionCount()).toBe(versions);
  });

  it('leaves a profile the manager or the owner changed alone, and says it differs from the files', async ({ skip }) => {
    if (!scratchName) skip();
    await seedProfiles(scratch, {});
    const lesson = { text: 'Say which business a number is about.', source: 'rec-1', adoptedAt: '2026-10-27T09:00:00Z' };
    const f = files.salon;
    await scratch.query(
      `select public.save_assistant_profile('salon', 1, 'Salon (edited)', $1, $2::text[], $3::jsonb, $4::jsonb, 'owner', 'adopted lesson', '{"kind":"lesson"}')`,
      [f.skill + '\nExtra rule.', [...f.reads], JSON.stringify(f.models), JSON.stringify([lesson])],
    );
    const results = await seedProfiles(scratch, {});
    const salon = results.find((r) => r.assistant === 'salon')!;
    expect(salon).toEqual({ assistant: 'salon', action: 'kept', version: 2, differsFromFiles: true });
    expect(results.filter((r) => r.differsFromFiles).map((r) => r.assistant)).toEqual(['salon']);
    expect((await scratch.query(`select title from public.assistant_profiles where assistant_id = 'salon'`)).rows[0].title).toBe('Salon (edited)');
  });

  it('--force puts the files back as a new version and keeps the lessons a person adopted', async ({ skip }) => {
    if (!scratchName) skip();
    await seedProfiles(scratch, {});
    const before = await versionCount();
    const results = await seedProfiles(scratch, {}, { force: true });
    expect(results.every((r) => r.action === 'reseeded' && !r.differsFromFiles)).toBe(true);
    expect(await versionCount()).toBe(before + 5);
    const salon = (await scratch.query(`select version, title, skill, lessons from public.assistant_profiles where assistant_id = 'salon'`)).rows[0];
    expect(salon.title).toBe(files.salon.title);
    expect(salon.skill).toBe(files.salon.skill);
    expect(salon.lessons).toEqual([{ text: 'Say which business a number is about.', source: 'rec-1', adoptedAt: '2026-10-27T09:00:00Z' }]);
    const last = (await scratch.query(`select made_by, reason, change from public.assistant_profile_versions where assistant_id = 'salon' and version = $1`, [salon.version])).rows[0];
    expect(last).toEqual({ made_by: 'seed', reason: 'reseeded from the files (--force)', change: { kind: 'reseed', from: salon.version - 1 } });
  });

  it('feeds the worker profile source: every assistant from its row, and the files for a row that is missing', async ({ skip }) => {
    if (!scratchName) skip();
    await seedProfiles(scratch, {});
    const source = () => createProfileSource({ env: {}, load: async () => (await scratch.query('select * from public.assistant_profiles')).rows, now: () => new Date(), onProblem: () => undefined });
    const all = source();
    const loaded = await all.refresh();
    expect(loaded.fromDatabase.sort()).toEqual([...AssistantId.options].sort());
    expect(loaded.problems).toEqual([]);
    for (const id of AssistantId.options) {
      expect(all.profile(id)).toMatchObject({ source: 'database', skill: files[id].skill, reads: [...files[id].reads], title: files[id].title, lessons: expect.any(Array) });
      expect(all.profile(id).models).toEqual(files[id].models);
    }
    await scratch.query(`delete from public.assistant_profiles where assistant_id = 'salon'`);
    const partial = source();
    const result = await partial.refresh();
    expect(result.fromFiles).toEqual(['salon']);
    expect(partial.profile('salon')).toEqual(files.salon);
    expect(partial.profile('finance').source).toBe('database');
  });

  it('runs as the two scripts: seed-profiles.ts, then issue-door-token.ts writing a token that opens the door', async ({ skip }) => {
    if (!scratchName) skip();
    const target = new URL(url);
    target.pathname = `/${scratchName}`;
    const repo = path.resolve(import.meta.dirname, '../..');
    const run = (script: string, args: string[]) => spawnSync('npx', ['tsx', script, ...args, '--db', target.toString()], { cwd: repo, encoding: 'utf8', timeout: 60_000 });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fahq-door-'));
    try {
      const seeded = run('scripts/seed-profiles.ts', []);
      expect(seeded.status, seeded.stderr).toBe(0);
      expect(seeded.stdout.trim().split('\n').map((l) => l.split(/\s+/)[0])).toEqual([...AssistantId.options]);
      expect(seeded.stderr).toContain(`seeding ${target.hostname}:${target.port}/${scratchName}`);
      expect(seeded.stderr).not.toContain(target.password); // the address is shown without its password

      const issued = run('scripts/issue-door-token.ts', ['finance', 'Claude Code on the laptop', '--dir', dir]);
      expect(issued.status, issued.stderr).toBe(0);
      const tokenFile = path.join(dir, 'finance.token');
      expect(issued.stdout).toBe(`${tokenFile}\n`); // the path, and nothing else
      const token = fs.readFileSync(tokenFile, 'utf8').trim();
      expect(token).toMatch(/^fahq_[A-Za-z0-9_-]{43}$/);
      expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
      expect(issued.stdout + issued.stderr).not.toContain(token);

      const rows = (await scratch.query(`select assistant_id, label, token_hash, revoked_at from public.door_tokens`)).rows;
      expect(rows).toEqual([{ assistant_id: 'finance', label: 'Claude Code on the laptop', token_hash: tokenHash(token), revoked_at: null }]);
      const opened = (await scratch.query('select public.door_profile($1) as profile', [token])).rows[0].profile;
      expect(opened.assistant).toBe('finance');
      expect(opened.reads).toEqual([...files.finance.reads]);

      const again = run('scripts/issue-door-token.ts', ['finance', '--dir', dir]);
      expect(again.status).toBe(2);
      expect(again.stderr).toContain('already exists');
      expect((await scratch.query('select count(*)::int as n from public.door_tokens')).rows[0].n).toBe(1);
      const replaced = run('scripts/issue-door-token.ts', ['finance', '--dir', dir, '--replace']);
      expect(replaced.status, replaced.stderr).toBe(0);
      expect((await scratch.query('select count(*)::int as n from public.door_tokens')).rows[0].n).toBe(2);
      expect(fs.readFileSync(tokenFile, 'utf8').trim()).not.toBe(token);

      expect(run('scripts/issue-door-token.ts', ['nobody', '--dir', dir]).status).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('--force also keeps the notes the HQ Manager added at the end of a skill (they are the manager\'s decision, not the files\')', async ({ skip }) => {
    if (!scratchName) skip();
    await seedProfiles(scratch, {});
    const row = (await scratch.query(`select version, skill, reads, models, lessons from public.assistant_profiles where assistant_id = 'finance'`)).rows[0];
    await scratch.query(
      `select public.save_assistant_profile('finance', $1, 'Finance Department', $2, $3::text[], $4::jsonb, $5::jsonb, 'manager', 'a skill note', '{"kind":"skill_note"}')`,
      [row.version, withManagerNotes(row.skill, ['Name the month.', 'Say the return with the spend.']), row.reads, JSON.stringify(row.models), JSON.stringify(row.lessons)],
    );
    const before = await versionCount();
    const results = await seedProfiles(scratch, {}, { force: true });
    expect(await versionCount()).toBe(before + 5);
    const finance = (await scratch.query(`select skill from public.assistant_profiles where assistant_id = 'finance'`)).rows[0];
    expect(finance.skill).toBe(withManagerNotes(files.finance.skill, ['Name the month.', 'Say the return with the spend.']));
    expect(managerNotes(finance.skill)).toEqual(['Name the month.', 'Say the return with the spend.']);
    expect(results.find((r) => r.assistant === 'finance')).toMatchObject({ action: 'reseeded', differsFromFiles: true }); // it says the row has more than the files
    expect(results.filter((r) => r.assistant !== 'finance').every((r) => !r.differsFromFiles)).toBe(true);
    // The version before the reseed is still in the history, notes and all: the manager's notes can be read back from there too.
    const history = (await scratch.query(`select snapshot from public.assistant_profile_versions where assistant_id = 'finance' order by version`)).rows;
    expect(history.some((h) => managerNotes(h.snapshot.skill).length === 2)).toBe(true);
    // And a reseed from the files of a profile with no notes writes none.
    expect(managerNotes((await scratch.query(`select skill from public.assistant_profiles where assistant_id = 'online'`)).rows[0].skill)).toEqual([]);
  });

  // ---- Putting an earlier version back ---------------------------------------------------------------------

  const onlineRow = async () => (await scratch.query(`select version, title, skill, reads, models, lessons from public.assistant_profiles where assistant_id = 'online'`)).rows[0];
  const saveOnline = (expected: number, over: { skill?: string; reads?: string[]; lessons?: unknown[]; by?: string; reason?: string }) =>
    scratch.query(
      `select public.save_assistant_profile('online', $1::integer, 'Online Customer Service', $2, $3::text[], $4::jsonb, $5::jsonb, $6, $7, '{"kind":"test"}') as v`,
      [expected, over.skill ?? files.online.skill, over.reads ?? [...files.online.reads], JSON.stringify(files.online.models), JSON.stringify(over.lessons ?? []), over.by ?? 'manager', over.reason ?? 'a test change'],
    ).then((r) => r.rows[0].v as number | null);

  it('puts an earlier version back as a new version: the change is undone, and nothing in the history is touched', async ({ skip }) => {
    if (!scratchName) skip();
    await seedProfiles(scratch, {});
    const before = await onlineRow();
    const lesson = { text: 'Say which month.', source: 'rec-9', adoptedAt: '2026-10-27T09:00:00Z' };
    const changed = await saveOnline(before.version, { skill: withManagerNotes(before.skill, ['Name the month.']), reads: [...before.reads, 'usage_summary'], lessons: [lesson], by: 'manager' });
    expect(changed).toBe(before.version + 1);
    const history = async () => (await scratch.query(`select version, made_by, reason, change, snapshot from public.assistant_profile_versions where assistant_id = 'online' order by version`)).rows;
    const kept = await history();

    const done = await restoreProfileVersion(scratch, 'online', before.version, { now: new Date('2026-10-27T15:00:00Z') });
    expect(done).toEqual({ assistant: 'online', restored: before.version, replaced: before.version + 1, version: before.version + 2 });
    const now = await onlineRow();
    expect(now).toMatchObject({ version: before.version + 2, title: before.title, skill: before.skill, reads: before.reads, lessons: before.lessons });
    expect(canonicalJson(now.models)).toBe(canonicalJson(before.models));
    const after = await history();
    expect(after).toHaveLength(kept.length + 1);
    expect(after.slice(0, kept.length)).toEqual(kept); // every earlier version is exactly as it was, the manager's change included
    expect(after.at(-1)).toMatchObject({ version: before.version + 2, made_by: 'owner', reason: `put back version ${before.version}`, change: { kind: 'restore', restored: before.version, from: before.version + 1 } });
    expect(managerNotes(after[kept.length - 1].snapshot.skill)).toEqual(['Name the month.']);
    // ...so the undo can be undone: the manager's version can be put back in the same way.
    const redo = await restoreProfileVersion(scratch, 'online', before.version + 1);
    expect(redo.version).toBe(before.version + 3);
    expect(managerNotes((await onlineRow()).skill)).toEqual(['Name the month.']);
  });

  it('refuses, in plain words and writing nothing, a version that is not there, one that is not a version number, and a profile that is not stored', async ({ skip }) => {
    if (!scratchName) skip();
    await seedProfiles(scratch, {});
    const before = await versionCount();
    await expect(restoreProfileVersion(scratch, 'online', 9999)).rejects.toThrow('the online profile has no version 9999');
    for (const bad of [0, -1, 1.5, Number.NaN]) await expect(restoreProfileVersion(scratch, 'online', bad)).rejects.toThrow('the version to put back must be a whole number from 1');
    await expect(restoreProfileVersion(scratch, 'nobody' as never, 1)).rejects.toThrow('"nobody" is not an assistant');
    await scratch.query(`delete from public.assistant_profiles where assistant_id = 'salon'`);
    await expect(restoreProfileVersion(scratch, 'salon', 1)).rejects.toThrow('the salon profile is not stored, so there is nothing to put back');
    await seedProfiles(scratch, {}); // salon again
    expect(await versionCount()).toBe(before + 1);
  });

  it('refuses a version the rules would not accept today (a read tool that no longer exists), and one changed while it was being put back', async ({ skip }) => {
    if (!scratchName) skip();
    const row = await onlineRow();
    const gone = await saveOnline(row.version, { reads: ['get_online_metrics', 'a_tool_that_was_removed'], reason: 'an old profile' });
    const fine = await saveOnline(gone!, {});
    await expect(restoreProfileVersion(scratch, 'online', gone!)).rejects.toThrow(`version ${gone} of the online profile would not be accepted today: it reads "a_tool_that_was_removed", which is not a read tool`);
    expect((await onlineRow()).version).toBe(fine);

    // Another writer saves between the moment the current version is read and the moment the old one is written back.
    const racing = {
      query: async (text: string, params?: unknown[]) => {
        const result = await scratch.query(text, params);
        if (text.startsWith('select version from public.assistant_profiles')) await saveOnline(result.rows[0]!.version as number, { reason: 'someone else, at the same moment' });
        return result;
      },
    };
    const versions = await versionCount();
    await expect(restoreProfileVersion(racing, 'online', row.version)).rejects.toThrow(`the online profile changed while version ${row.version} was being put back; run it again`);
    expect(await versionCount()).toBe(versions + 1); // only the other writer's version
  });

  it('runs as revert-profile.ts: --list shows who made each version and why, and a number puts that version back', async ({ skip }) => {
    if (!scratchName) skip();
    const target = new URL(url);
    target.pathname = `/${scratchName}`;
    const repo = path.resolve(import.meta.dirname, '../..');
    const run = (args: string[]) => spawnSync('npx', ['tsx', 'scripts/revert-profile.ts', ...args, '--db', target.toString()], { cwd: repo, encoding: 'utf8', timeout: 60_000 });
    const listed = run(['finance', '--list']);
    expect(listed.status, listed.stderr).toBe(0);
    const lines = listed.stdout.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^ {2}1 {2}seed {5}\d{4}-\d\d-\d\dT.*seeded from the files/);
    const noted = lines.find((l) => /manager {2}.* a skill note$/.test(l));
    expect(noted).toBeDefined();
    expect(listed.stderr).not.toContain(target.password);

    const noteVersion = Number(noted!.trim().split(/\s+/)[0]);
    const back = run(['finance', String(noteVersion)]);
    expect(back.status, back.stderr).toBe(0);
    expect(back.stdout).toMatch(new RegExp(`^finance version ${noteVersion} is back as version \\d+ \\(it replaced version \\d+\\)\\n$`));
    expect(managerNotes((await scratch.query(`select skill from public.assistant_profiles where assistant_id = 'finance'`)).rows[0].skill)).toEqual(['Name the month.', 'Say the return with the spend.']);

    const missing = run(['finance', '9999']);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('the finance profile has no version 9999. Nothing was written.');
    expect(run(['nobody', '1']).status).toBe(2);
    expect(run(['finance']).status).toBe(2);
  }, 120_000);

  it('--force keeps the read tools and the model of each job whose latest change the owner made with his code, and puts the files back everywhere else', async ({ skip }) => {
    if (!scratchName) skip();
    const ownerRow = async () => (await scratch.query(`select version, title, skill, reads, models, lessons from public.assistant_profiles where assistant_id = 'owner'`)).rows[0];
    const saveOwner = (expected: number, over: { title: string; reads: string[]; models: unknown; by: string; reason: string }, row: { skill: string; lessons: unknown }) =>
      scratch.query(
        `select public.save_assistant_profile('owner', $1::integer, $2, $3, $4::text[], $5::jsonb, $6::jsonb, $7, $8, '{"kind":"test"}') as v`,
        [expected, over.title, row.skill, over.reads, JSON.stringify(over.models), JSON.stringify(row.lessons), over.by, over.reason],
      ).then((r) => r.rows[0].v as number);

    const start = await ownerRow();
    // The owner approves a change of read tools and of one model with his code (a version made by 'owner').
    const reads = [...start.reads.filter((name: string) => name !== 'get_timeline'), 'my_lessons'];
    const approved = { ...start.models, answer: { ...start.models.answer, model: 'owner/approved-answer-model' } };
    const v1 = await saveOwner(start.version, { title: start.title, reads, models: approved, by: 'owner', reason: 'adopted a data access' }, start);
    // Then the manager changes the title and another model by itself: not the owner's decision.
    const managed = { ...approved, code: { ...approved.code, model: 'manager/changed-code-model' } };
    const v2 = await saveOwner(v1, { title: 'Owner HQ (edited)', reads, models: managed, by: 'manager', reason: 'a note' }, start);
    expect(v2).toBeGreaterThan(v1);

    const results = await seedProfiles(scratch, {}, { force: true });
    const owner = results.find((r) => r.assistant === 'owner')!;
    expect(owner).toMatchObject({ action: 'reseeded', differsFromFiles: true, keptFromOwner: ['reads', 'model answer'] });
    const after = await ownerRow();
    expect(after.reads).toEqual(reads); // the owner's read tools survive the reseed
    expect(after.models.answer.model).toBe('owner/approved-answer-model');
    expect(after.models.code).toEqual(files.owner.models.code); // the manager's model does not: it was never the owner's word
    expect(after.models.route).toEqual(files.owner.models.route);
    expect(after.title).toBe(files.owner.title);
    expect(after.skill).toBe(files.owner.skill);
    // The version says what was kept, and nothing else is affected.
    const last = (await scratch.query(`select made_by, change from public.assistant_profile_versions where assistant_id = 'owner' and version = $1`, [after.version])).rows[0];
    expect(last).toEqual({ made_by: 'seed', change: { kind: 'reseed', from: v2, keptFromOwner: ['reads', 'model answer'] } });
    expect(results.filter((r) => r.assistant !== 'owner').every((r) => r.keptFromOwner === undefined)).toBe(true);

    // The reseed itself does not make the seed the last to touch them: a second reseed keeps them again.
    expect((await seedProfiles(scratch, {}, { force: true })).find((r) => r.assistant === 'owner')).toMatchObject({ keptFromOwner: ['reads', 'model answer'] });
    expect((await ownerRow()).reads).toEqual(reads);
    // The history has the owner's version and the files' version both, so either can be put back.
    const history = (await scratch.query(`select version, made_by from public.assistant_profile_versions where assistant_id = 'owner' and version in ($1, $2)`, [v1, v2])).rows;
    expect(history.map((h) => h.made_by).sort()).toEqual(['manager', 'owner']);
  });

  it('runs --force as seed-profiles.ts and says which choices of the owner it kept', async ({ skip }) => {
    if (!scratchName) skip();
    const target = new URL(url);
    target.pathname = `/${scratchName}`;
    const repo = path.resolve(import.meta.dirname, '../..');
    const run = spawnSync('npx', ['tsx', 'scripts/seed-profiles.ts', '--force', '--db', target.toString()], { cwd: repo, encoding: 'utf8', timeout: 60_000 });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/^owner {4}reseeded \(version \d+\); kept what the owner approved: reads, model answer$/m);
    expect(run.stdout).toMatch(/^finance {2}reseeded \(version \d+\)$/m);
    expect(run.stderr).not.toContain(target.password);
  }, 120_000);
});
