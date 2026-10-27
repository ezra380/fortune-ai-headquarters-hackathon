import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssistantId } from '@fahq/contracts';
import { issueDoorToken, loadProfiles, seedProfiles, tokenHash, type AssistantProfile } from '@fahq/profiles';
import { createBrainMcpServer, createCodeModeBrainServer, doorReads, type BrainMcpDeps } from '../src/index.ts';
import { createDoorClient } from '../src/door-client.ts';
import { openDoor, type DoorRequest } from '../src/door.ts';

// The doors against the real thing: the local Supabase stack (real Postgres, the real Data API with the real
// anon key), and serve.ts started as a program. Nothing is mocked except the brain and the business data, which
// these tests do not read. The tests write only door tokens and session reports, and delete them again; a
// profile version is append-only, so nothing here changes a profile.

const dbUrl = process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const isLocal = /@(127\.0\.0\.1|localhost|\[::1\]):/.test(dbUrl);
const root = path.resolve(import.meta.dirname, '../../..');
const pool = new pg.Pool({ connectionString: dbUrl, max: 4 });
let ready = false;
let keys: { url: string; anon: string } | null = null;
const madeTokens: string[] = [];

function localKeys(): { url: string; anon: string } | null {
  try {
    const out = execSync('npx supabase status -o env', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 });
    const get = (name: string) => out.match(new RegExp(`^${name}="?([^"\\n]*)"?$`, 'm'))?.[1];
    const url = get('API_URL');
    const anon = get('ANON_KEY');
    return url && anon ? { url, anon } : null;
  } catch {
    return null;
  }
}

beforeAll(async () => {
  if (!isLocal) return console.warn('SKIPPED door database tests: SUPABASE_DB_URL does not point at the local stack');
  try {
    ready = (await pool.query(`select to_regclass('public.door_tokens') as t`)).rows[0].t !== null;
  } catch {
    return console.warn('SKIPPED door database tests: no Postgres at the local address (run npm run db:start)');
  }
  if (!ready) return console.warn('SKIPPED door database tests: apply supabase/migrations/20261027100000_profiles.sql first');
  keys = localKeys();
  if (!keys) return console.warn('SKIPPED door database tests: `supabase status` did not answer');
  await seedProfiles(pool, {}); // an assistant with no row gets one; the others are left alone
}, 90_000);

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

// ---- Helpers ----------------------------------------------------------------------------------------------

async function newToken(assistant: AssistantId): Promise<{ token: string; id: string }> {
  const issued = await issueDoorToken(pool, assistant, 'doors db test');
  madeTokens.push(issued.id);
  return issued;
}
const envFor = (token: string) => ({ SUPABASE_URL: keys!.url, SUPABASE_ANON_KEY: keys!.anon, FAHQ_DOOR_TOKEN: token });
const request = (over: Partial<DoorRequest> = {}): DoorRequest => ({ plain: true, local: false, profile: undefined, tokenFile: undefined, ...over });
const reportsOf = async (tokenId: string) => (await pool.query('select * from public.session_reports where token_id = $1 order by created_at', [tokenId])).rows;
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? '';
const brain = { memory: () => ({ recallDecisions: () => [] }), record: { timeline: () => [] } } as unknown as Awaited<ReturnType<BrainMcpDeps['openBrain']>>;

/** A client of the door serve.ts would build for this token, over an in-memory pipe, named like an outside tool. */
async function connectDoor(token: string, clientName = 'claude-code', over: Partial<DoorRequest> = {}) {
  const door = await openDoor(request(over), envFor(token));
  const deps: BrainMcpDeps = { data: null, openBrain: async () => brain, now: () => new Date(), fileReport: door.fileReport };
  const server = over.plain === false ? await createCodeModeBrainServer(deps, {}, door.profile) : createBrainMcpServer(deps, door.profile);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: clientName, version: '1.0.0' });
  await client.connect(clientSide);
  return { client, door };
}
const toolNames = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).sort();

// ---- The profile, from the database --------------------------------------------------------------------------

describe('a door opened with a token', () => {
  it('serves the stored profile of the token\'s assistant, read through door_profile with the anon key', async ({ skip }) => {
    if (!ready || !keys) skip();
    const { token } = await newToken('finance');
    const door = await openDoor(request(), envFor(token));
    const row = (await pool.query(`select * from public.assistant_profiles where assistant_id = 'finance'`)).rows[0];
    expect(door.profile).toMatchObject({ id: 'finance', source: 'database', version: row.version, title: row.title, skill: row.skill, reads: row.reads });
    expect(door.summary).toBe(`profile finance version ${row.version} from the database`);
  });

  it('gives each token its own assistant, and refuses a --profile that is not that assistant', async ({ skip }) => {
    if (!ready || !keys) skip();
    const online = await newToken('online');
    const salon = await newToken('salon');
    expect((await openDoor(request(), envFor(online.token))).profile.id).toBe('online');
    expect((await openDoor(request({ profile: 'salon' }), envFor(salon.token))).profile.id).toBe('salon');
    await expect(openDoor(request({ profile: 'finance' }), envFor(online.token))).rejects.toThrow('This token belongs to the online assistant, not finance. Use the token issued for finance.');
  });

  it('offers exactly the stored reads the door can serve, and no write but file_work_report', async ({ skip }) => {
    if (!ready || !keys) skip();
    for (const assistant of ['finance', 'online', 'manager', 'legal'] as const) {
      const { token } = await newToken(assistant);
      const plain = await connectDoor(token);
      const stored = (await pool.query('select reads from public.assistant_profiles where assistant_id = $1', [assistant])).rows[0].reads as string[];
      expect(await toolNames(plain.client), assistant).toEqual([...doorReads(plain.door.profile), 'file_work_report'].sort());
      expect(doorReads(plain.door.profile).every((name) => stored.includes(name)), assistant).toBe(true);
      const code = await connectDoor(token, 'cursor', { plain: false });
      expect((await toolNames(code.client)).filter((n) => n !== 'code'), assistant).toEqual(['file_work_report']);
    }
  });

  it('serves a skill that lists the door\'s tools and tells the tool to file its report', async ({ skip }) => {
    if (!ready || !keys) skip();
    const { token } = await newToken('online');
    const { client } = await connectDoor(token);
    const prompt = ((await client.getPrompt({ name: 'skill' })).messages[0]!.content as { text: string }).text;
    expect(prompt).toContain('- `get_online_metrics`:');
    expect(prompt).not.toContain('get_salon_metrics');
    expect(prompt).not.toContain('get_finance_metrics');
    expect(prompt).toContain('call `file_work_report` once');
  });
});

describe('a token the database does not accept', () => {
  it('gets one sentence that says nothing about why, for an unknown token and a revoked one alike', async ({ skip }) => {
    if (!ready || !keys) skip();
    const unknown = 'fahq_' + 'Z'.repeat(43);
    const revoked = await newToken('finance');
    await pool.query('update public.door_tokens set revoked_at = now() where id = $1', [revoked.id]);
    const sentence = 'The door refused this token: it is not valid, or it was revoked.';
    await expect(openDoor(request(), envFor(unknown))).rejects.toThrow(sentence);
    await expect(openDoor(request(), envFor(revoked.token))).rejects.toThrow(sentence);
    for (const token of [unknown, revoked.token]) {
      const error = await openDoor(request(), envFor(token)).catch((e: Error) => e);
      expect((error as Error).message).not.toContain(token);
    }
  });

  it('cannot file a report once it is revoked, and nothing is stored', async ({ skip }) => {
    if (!ready || !keys) skip();
    const { token, id } = await newToken('finance');
    const { client } = await connectDoor(token);
    await pool.query('update public.door_tokens set revoked_at = now() where id = $1', [id]);
    const result = await client.callTool({ name: 'file_work_report', arguments: { summary: 'Too late.' } });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('The report was not filed. The door refused this token: it is not valid, or it was revoked.');
    expect(await reportsOf(id)).toEqual([]);
  });

  it('is turned away when the public key is the service key', async ({ skip }) => {
    if (!ready || !keys) skip();
    const { token } = await newToken('owner');
    const service = ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url'), 'x'].join('.');
    await expect(openDoor(request(), { ...envFor(token), SUPABASE_ANON_KEY: service })).rejects.toThrow(/is a service key/);
  });
});

// ---- The report, in the database -------------------------------------------------------------------------------

describe('file_work_report at a door', () => {
  it('lands in session_reports under the token\'s assistant, named for the tool, with phone numbers and codes masked', async ({ skip }) => {
    if (!ready || !keys) skip();
    const { token, id } = await newToken('finance');
    const { client } = await connectDoor(token, 'cursor');
    const result = await client.callTool({
      name: 'file_work_report',
      arguments: {
        summary: 'Rang +1 555 010 1234 and (555) 010-1234 and 5550101234; the code was 482913. Revenue was 12400 against 18600.',
        steps: ['Texted 5550101234', 'Read the September metrics'],
        suggestions: ['Show the ad return beside revenue'],
        lessons: ['A code like 135790 never belongs in a report'],
      },
    });
    expect(result.isError).toBeFalsy();
    const answer = JSON.parse(text(result)) as { filed: boolean; id: string; duplicate: boolean };
    expect(answer).toMatchObject({ filed: true, duplicate: false });

    const rows = await reportsOf(id);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe(answer.id);
    expect(row).toMatchObject({ assistant_id: 'finance', token_id: id, tool: 'cursor', reviewed_at: null });
    expect(row.summary).toBe('Rang [phone] and [phone] and [phone]; the code was [code]. Revenue was 12400 against 18600.');
    expect(row.steps).toEqual([{ step: 'Texted [phone]' }, { step: 'Read the September metrics' }]);
    expect(row.suggestions).toEqual([{ text: 'Show the ad return beside revenue' }]);
    expect(row.lessons).toEqual([{ text: 'A code like [code] never belongs in a report' }]);
    const words = JSON.stringify([row.tool, row.summary, row.steps, row.suggestions, row.lessons]); // not the ids, which may hold any digits
    for (const secret of ['555', '482913', '135790']) expect(words, secret).not.toContain(secret);
    expect(row.dedupe_key).toMatch(/^[0-9a-f]{12}:[0-9a-f]{32}$/);
  });

  it('stores a retry once and answers it as a duplicate, and stores a different report as a second one', async ({ skip }) => {
    if (!ready || !keys) skip();
    const { token, id } = await newToken('online');
    const { client } = await connectDoor(token);
    const args = { summary: 'Checked the returns policy.', steps: ['Read the policy'] };
    const first = JSON.parse(text(await client.callTool({ name: 'file_work_report', arguments: args }))) as { id: string; duplicate: boolean };
    const retry = JSON.parse(text(await client.callTool({ name: 'file_work_report', arguments: { ...args } }))) as { id: string; duplicate: boolean };
    expect(first.duplicate).toBe(false);
    expect(retry).toEqual({ filed: true, id: first.id, duplicate: true });
    expect(await reportsOf(id)).toHaveLength(1);
    await client.callTool({ name: 'file_work_report', arguments: { summary: 'Checked the returns policy and the shipping page.' } });
    expect(await reportsOf(id)).toHaveLength(2);
  });

  it('keeps the same words filed in two separate sessions as two reports', async ({ skip }) => {
    if (!ready || !keys) skip();
    const { token, id } = await newToken('salon');
    const args = { summary: 'Walked through the booking numbers.' };
    for (let session = 0; session < 2; session++) {
      const { client } = await connectDoor(token, 'codex');
      await client.callTool({ name: 'file_work_report', arguments: args });
    }
    expect(await reportsOf(id)).toHaveLength(2);
  });

  it('files under the assistant of the token it holds, never another', async ({ skip }) => {
    if (!ready || !keys) skip();
    const online = await newToken('online');
    const salon = await newToken('salon');
    for (const [who, t] of [['online', online], ['salon', salon]] as const) {
      const { client } = await connectDoor(t.token, 'gemini-cli');
      await client.callTool({ name: 'file_work_report', arguments: { summary: `Work for ${who}.` } });
    }
    expect((await reportsOf(online.id)).map((r) => [r.assistant_id, r.summary])).toEqual([['online', 'Work for online.']]);
    expect((await reportsOf(salon.id)).map((r) => [r.assistant_id, r.summary])).toEqual([['salon', 'Work for salon.']]);
  });

  it('is checked by the database as well: a report over its limits is refused in plain words, whatever the tool let through', async ({ skip }) => {
    if (!ready || !keys) skip();
    const { token, id } = await newToken('manager');
    const client = createDoorClient({ url: keys!.url, anonKey: keys!.anon, token });
    const steps = Array.from({ length: 31 }, (_, i) => ({ step: `step ${i}` }));
    await expect(client.fileReport({ tool: 'claude-code', summary: 'Too many steps.', steps })).rejects.toThrow("The report's steps must be a list of at most 30 items.");
    await expect(client.fileReport({ tool: 'claude-code', summary: 'Bad key.', key: 'no good!' })).rejects.toThrow(/key/);
    expect(await reportsOf(id)).toEqual([]);
  });

  it('keeps the token itself out of every table', async ({ skip }) => {
    if (!ready || !keys) skip();
    const { token, id } = await newToken('owner');
    const { client } = await connectDoor(token);
    await client.callTool({ name: 'file_work_report', arguments: { summary: 'Opened the owner door.' } });
    const stored = (await pool.query('select to_jsonb(t) as j from public.door_tokens t where id = $1', [id])).rows[0].j;
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored.token_hash).toBe(tokenHash(token));
    expect(JSON.stringify(await reportsOf(id))).not.toContain(token);
  });
});

// ---- The Legal Team's door -------------------------------------------------------------------------------------

describe('the Legal Team door', () => {
  const legalWords = {
    summary: 'Read a vendor agreement. Auto-renewal with a long notice window, overall call Yellow. Rang +1 718 555 0100, reply 482913. Notices go to legal@vendor.example.',
    steps: ['Read every clause', 'Marked the renewal clause Yellow'],
    suggestions: ['Ask for a 30 day notice window'],
    lessons: ['Check the notice window before the renewal date'],
  };

  it('serves the stored Legal Team profile, offers the one read the door can serve and file_work_report, and no business data', async ({ skip }) => {
    if (!ready || !keys) skip();
    const { token } = await newToken('legal');
    const { client, door } = await connectDoor(token);
    const row = (await pool.query(`select * from public.assistant_profiles where assistant_id = 'legal'`)).rows[0];
    expect(door.profile).toMatchObject({ id: 'legal', source: 'database', version: row.version, title: 'Legal Team', serves: null, reads: ['recall_my_decisions', 'my_lessons'] });
    expect(door.summary).toBe(`profile legal version ${row.version} from the database`);
    // my_lessons is read inside the worker; the door serves recall_my_decisions, and nothing that holds the company's numbers.
    expect(await toolNames(client)).toEqual(['file_work_report', 'recall_my_decisions']);
    const prompt = ((await client.getPrompt({ name: 'skill' })).messages[0]!.content as { text: string }).text;
    expect(prompt).toContain('- `recall_my_decisions`:');
    expect(prompt).not.toMatch(/my_lessons|get_finance_metrics|get_online_metrics|get_salon_metrics|get_company_overview/);
    for (const word of ['Green', 'Yellow', 'Red', 'licensed attorney', '`legal:contract-review`', '`/legal:review-contract`', '`saas-msa-review`', 'call `file_work_report` once']) expect(prompt, word).toContain(word);
    expect(prompt).not.toMatch(/compliance-check|legal-response/); // names the plugins do not have
    // Code Mode: one `code` tool for the reads (the sandbox sees the reads only) beside the report tool.
    const code = await connectDoor(token, 'cursor', { plain: false });
    expect((await toolNames(code.client)).filter((n) => n !== 'file_work_report')).toEqual(['code']);
  });

  it('files a Legal Team report under legal, masked, once per retry, and a legal token cannot file under another assistant', async ({ skip }) => {
    if (!ready || !keys) skip();
    const { token, id } = await newToken('legal');
    const { client } = await connectDoor(token, 'claude-code');
    const first = JSON.parse(text(await client.callTool({ name: 'file_work_report', arguments: legalWords }))) as { filed: boolean; id: string; duplicate: boolean };
    expect(first).toMatchObject({ filed: true, duplicate: false });
    const retry = JSON.parse(text(await client.callTool({ name: 'file_work_report', arguments: { ...legalWords } }))) as { id: string; duplicate: boolean };
    expect(retry).toMatchObject({ id: first.id, duplicate: true });
    const rows = await reportsOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ assistant_id: 'legal', token_id: id, tool: 'claude-code', reviewed_at: null });
    expect(rows[0].summary).toBe('Read a vendor agreement. Auto-renewal with a long notice window, overall call Yellow. Rang [phone], reply [code]. Notices go to [email].');
    expect(rows[0].summary).not.toMatch(/@|vendor\.example/); // a contract's notice address is a party's contact detail and never reaches the manager's digest
    expect(rows[0].lessons).toEqual([{ text: 'Check the notice window before the renewal date' }]);
    expect((await pool.query(`select count(*)::int as n from public.session_reports where assistant_id <> 'legal' and token_id = $1`, [id])).rows[0].n).toBe(0);
  });
});

// ---- serve.ts, started as a program ---------------------------------------------------------------------------

describe('serve.ts', () => {
  const tsx = path.join(root, 'node_modules/.bin/tsx');
  const serve = path.join(root, 'packages/codemode/src/serve.ts');
  // The door serves the STORED profile's reads: the shared database may hold an older version than this branch's files
  // (lane D2 adds reads; the merge reseeds the profiles and compares with the file profile again). Drift the other way
  // fails loud: a stored profile may lag the files, never serve a read this branch's files do not name.
  const storedDoorTools = async (assistant: AssistantId) => {
    const reads = (await pool.query('select reads from public.assistant_profiles where assistant_id = $1', [assistant])).rows[0].reads as AssistantProfile['reads'];
    const stored = ['file_work_report', ...doorReads({ ...loadProfiles({})[assistant], reads })].sort();
    const files = ['file_work_report', ...doorReads(loadProfiles({})[assistant])];
    for (const t of stored) expect(files, `the stored ${assistant} profile serves ${t}, which this branch's files do not: reseed profiles`).toContain(t);
    return stored;
  };
  const run = (args: string[], env: Record<string, string>) =>
    spawnSync(tsx, [serve, ...args], { cwd: root, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }, encoding: 'utf8', timeout: 30_000, input: '' });

  it('starts a door on a stored profile with FAHQ_DOOR_TOKEN, serves it over stdio and files a report', async ({ skip }) => {
    if (!ready || !keys) skip();
    const { token, id } = await newToken('finance');
    const transport = new StdioClientTransport({ command: tsx, args: [serve, '--profile', 'finance', '--plain'], cwd: root, env: envFor(token), stderr: 'pipe' });
    let log = '';
    transport.stderr?.on('data', (chunk) => (log += String(chunk)));
    const client = new Client({ name: 'codex', version: '1.0.0' });
    try {
      await client.connect(transport);
      const row = (await pool.query(`select version from public.assistant_profiles where assistant_id = 'finance'`)).rows[0];
      expect(log).toContain(`fortune-brain MCP ready (plain tools, profile finance version ${row.version} from the database)`);
      expect(await toolNames(client)).toEqual(await storedDoorTools('finance'));
      const prompt = ((await client.getPrompt({ name: 'skill' })).messages[0]!.content as { text: string }).text;
      expect(prompt).toContain('call `file_work_report` once');
      const done = await client.callTool({ name: 'file_work_report', arguments: { summary: 'Started the finance door from serve.ts, called 5550101234.' } });
      expect(done.isError).toBeFalsy();
      const rows = await reportsOf(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ assistant_id: 'finance', tool: 'codex', summary: 'Started the finance door from serve.ts, called [phone].' });
      expect(log).not.toContain(token);
    } finally {
      await client.close();
    }
  }, 60_000);

  it('starts the Legal Team door the way a Claude Code session on a staff laptop would, and its report reaches session_reports under legal', async ({ skip }) => {
    if (!ready || !keys) skip();
    const { token, id } = await newToken('legal');
    const transport = new StdioClientTransport({ command: tsx, args: [serve, '--profile', 'legal'], cwd: root, env: envFor(token), stderr: 'pipe' });
    let log = '';
    transport.stderr?.on('data', (chunk) => (log += String(chunk)));
    const client = new Client({ name: 'claude-code', version: '1.0.0' });
    try {
      await client.connect(transport);
      expect(log).toMatch(/fortune-brain MCP ready \(Code Mode, profile legal version \d+ from the database\)/);
      expect(await toolNames(client)).toEqual(['code', 'file_work_report']);
      const done = await client.callTool({ name: 'file_work_report', arguments: { summary: 'Read the marketplace terms: two Red clauses, one Yellow. Called 5550101234.', lessons: ['Read the fee-change clause first'] } });
      expect(done.isError).toBeFalsy();
      const rows = await reportsOf(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ assistant_id: 'legal', tool: 'claude-code', summary: 'Read the marketplace terms: two Red clauses, one Yellow. Called [phone].' });
      expect(log).not.toContain(token);
    } finally {
      await client.close();
    }
  }, 60_000);

  it('reads the token from --token-file', async ({ skip }) => {
    if (!ready || !keys) skip();
    const { token } = await newToken('online');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'door-'));
    const file = path.join(dir, 'online.token');
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
    const transport = new StdioClientTransport({ command: tsx, args: [serve, '--token-file', file, '--plain'], cwd: root, env: { SUPABASE_URL: keys!.url, SUPABASE_ANON_KEY: keys!.anon }, stderr: 'pipe' });
    const client = new Client({ name: 'cursor', version: '1.0.0' });
    try {
      await client.connect(transport);
      expect(await toolNames(client)).toEqual(await storedDoorTools('online'));
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses a token the database does not accept: exit 2, one plain sentence, no token in it', async ({ skip }) => {
    if (!ready || !keys) skip();
    const token = 'fahq_' + 'Y'.repeat(43);
    const result = run(['--profile', 'finance', '--plain'], envFor(token));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('fortune-brain: The door refused this token: it is not valid, or it was revoked.');
    expect(result.stdout).toBe('');
    expect(result.stderr + result.stdout).not.toContain(token);
  }, 60_000);

  it('says what is missing when there is no token, and points at --local', () => {
    const result = run(['--profile', 'finance'], {});
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/fortune-brain: No door token\. Set FAHQ_DOOR_TOKEN, or pass --token-file <path>.*--local/);
  }, 60_000);

  it('serves the file profile offline with --local: the reads, no report', async () => {
    const transport = new StdioClientTransport({ command: tsx, args: [serve, '--local', '--profile', 'online', '--plain'], cwd: root, env: {}, stderr: 'pipe' });
    const client = new Client({ name: 'claude-code', version: '1.0.0' });
    try {
      await client.connect(transport);
      expect(await toolNames(client)).toEqual([...doorReads('online')].sort());
      const prompt = ((await client.getPrompt({ name: 'skill' })).messages[0]!.content as { text: string }).text;
      expect(prompt).not.toContain('file_work_report');
      expect(prompt).toContain('This door has no database to file a work report in.');
    } finally {
      await client.close();
    }
  }, 60_000);
});
