import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRAIN_NOTE, DEPARTMENTS, SALON_MESSAGE } from '../src/departments.ts';
import type { RawDepartment } from '../src/departments.ts';
import { createCloudLoader, readBrain } from '../src/loader.ts';
import { cleanText, clip, maskNumber, maskPhones, redactCodes } from '../src/scrub.ts';
import { startConsoleServer } from '../src/server.ts';
import type { ConsoleDeps, RunningConsole } from '../src/server.ts';

// No network, no database, no real brain: every data source here is a fake the test injects.

const NOW = new Date('2026-10-26T21:30:00.000Z');
const HASH = 'a'.repeat(64);

/** A department's data as dirty as it can be: codes, phones, keys and hashes sit in every place a text can go. */
function dirty(): RawDepartment {
  return {
    assistant: { display_name: 'Finance assistant', sms_from: '+15551234514' },
    counts: { openTasks: 2, proposals: 1, pendingApprovals: 1 },
    tasks: [
      {
        id: '3f2a91bc-1111-4222-8333-444455556666',
        kind: 'inbound_text',
        status: 'failed',
        attempts: 3,
        last_error: 'Could not text +15559876543 about code 123456 (key sb_secret_abc123 / service_role)',
        created_at: '2026-10-26T20:15:03.123456+00:00',
      },
      {
        id: '12345678-aaaa-bbbb-cccc-dddddddddddd', // an all-digit start must not look like a code
        kind: 'mailbox',
        status: 'done',
        attempts: 1,
        last_error: null,
        created_at: '2026-10-26T20:10:00Z',
      },
    ],
    messages: [
      {
        from_assistant: 'finance',
        to_assistant: 'owner',
        kind: 'proposal',
        status: 'open',
        created_at: '2026-10-26T20:16:00Z',
        body: {
          plans: {
            plans: [
              { rank: 1, title: 'Raise the Mazali price 10%', summary: 'SECRET-SUMMARY 987654' },
              { rank: 2, title: 'Pause the weakest ad set' },
              { rank: 3, title: 'Text lapsed buyers (call 212-555-0100)' },
            ],
          },
          requestText: 'SECRET-BODY-MARKER please call (212) 555-0100',
        },
      },
      { from_assistant: 'owner', to_assistant: 'finance', kind: 'request', status: 'answered', created_at: '2026-10-26T20:15:30Z', body: { text: 'SECRET-REQUEST-TEXT' } },
    ],
    approvals: [
      {
        action: 'decide_plan',
        status: 'pending',
        expires_at: '2026-10-26T21:00:00Z', // already past at NOW
        decided_at: null,
        code_hash: HASH,
        code: '654321',
      } as never,
    ],
    outbox: [
      {
        channel: 'sms',
        status: 'sent',
        created_at: '2026-10-26T20:17:00Z',
        sent_at: '2026-10-26T20:17:05Z',
        last_error: null,
        body: 'Your finance assistant has 3 plans. Reply SEND 2 482915 to send one. Questions: 212-555-0100. Token eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature',
      },
    ],
    receipts: [
      {
        step: 'finance.plans',
        outcome: 'ok',
        model: 'nvidia/nemotron-3-ultra-550b-a55b',
        data_source: 'zetaris:finance_mart',
        started_at: '2026-10-26T20:15:10.000Z',
        ended_at: '2026-10-26T20:15:12.500Z',
        detail: `${'long detail '.repeat(40)} code 111111`,
        live: false,
      },
    ],
    decisions: [
      { content: 'Decision: demo-p-owner approved plan 2 "Pause the weakest ad set" (proposal 8f2c9d41-0000)', tags: ['decision', 'approved', 'proposal:8f2c9d41'] },
    ],
    timeline: [
      { id: 'evt-2', type: 'proposal.recorded', at: '2026-10-26T20:16:00Z' },
      { id: 'evt-1', type: 'request.recorded', at: null },
    ],
    notes: ['The mailbox could not be read right now (42P01).'],
  };
}

const running: RunningConsole[] = [];
async function start(overrides: Partial<ConsoleDeps> = {}) {
  const deps: ConsoleDeps = { load: vi.fn(async () => dirty()), now: () => NOW, log: () => {}, ...overrides };
  const r = await startConsoleServer(deps, 0);
  running.push(r);
  return { ...r, deps };
}
afterEach(async () => {
  while (running.length) await running.pop()!.close();
});

type Reply = { status: number; headers: http.IncomingHttpHeaders; text: string };
function request(port: number, opts: { method?: string; path: string; headers?: Record<string, string> }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const SECRET_LOOKING = [/service_role/i, /sb_secret/i, /sb_publishable/i, /eyJ/, /code_hash/i, /\b[0-9a-f]{40,}\b/i, /SUPABASE_/];

describe('read-only and local only', () => {
  it('answers every method except GET and HEAD with 405', async () => {
    const c = await start();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']) {
      for (const p of ['/', '/health', '/api/departments', '/api/department/finance', '/api/department/salon', '/nowhere']) {
        const r = await request(c.port, { method, path: p });
        expect(r.status, `${method} ${p}`).toBe(405);
        expect(r.headers.allow).toBe('GET, HEAD');
      }
    }
    expect(c.deps.load).not.toHaveBeenCalled();
  });

  it('listens on 127.0.0.1 only', async () => {
    const c = await start();
    const address = c.server.address();
    expect(address).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
    expect(c.url).toBe(`http://127.0.0.1:${c.port}`);
  });

  it('refuses a request whose Host is not a loopback name (DNS rebinding)', async () => {
    const c = await start();
    const r = await request(c.port, { path: '/api/department/finance', headers: { Host: 'evil.example.com' } });
    expect(r.status).toBe(421);
    expect(c.deps.load).not.toHaveBeenCalled();
    expect((await request(c.port, { path: '/health', headers: { Host: `localhost:${c.port}` } })).status).toBe(200);
  });

  it('answers HEAD with headers and no body, and sends no cache or sniffing headers away', async () => {
    const c = await start();
    const head = await request(c.port, { method: 'HEAD', path: '/health' });
    expect(head.status).toBe(200);
    expect(head.text).toBe('');
    expect(Number(head.headers['content-length'])).toBeGreaterThan(0);
    expect(head.headers['cache-control']).toBe('no-store');
    expect(head.headers['x-content-type-options']).toBe('nosniff');
    expect(head.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves /health, the department list and 404 for anything else', async () => {
    const c = await start();
    const health = await request(c.port, { path: '/health' });
    expect(JSON.parse(health.text)).toEqual({ ok: true, time: NOW.toISOString() });
    const list = JSON.parse((await request(c.port, { path: '/api/departments' })).text) as { departments: { id: string; name: string }[] };
    expect(list.departments.map((d) => d.id)).toEqual(['owner', 'finance', 'online', 'salon']);
    for (const p of ['/nope', '/api', '/api/department', '/api/department/', '/api/department/finance/extra', '/api/department/FINANCE', '/api/department/%2e%2e', '/health/']) {
      expect((await request(c.port, { path: p })).status, p).toBe(404);
    }
  });
});

describe('what a department may show', () => {
  it('never lets a code, a full phone number or a secret through, even when the data holds them', async () => {
    const c = await start();
    const r = await request(c.port, { path: '/api/department/finance' });
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(/\d{6}/);
    expect(r.text).not.toMatch(/\+1\d{10}/);
    expect(r.text).not.toMatch(/\+?1?[\s.(-]*\d{3}[\s.)-]*\d{3}[\s.-]*\d{4}/);
    for (const bad of SECRET_LOOKING) expect(r.text).not.toMatch(bad);
    // Whole bodies and unknown fields are dropped; only plan titles of a proposal come through.
    for (const marker of ['SECRET-BODY-MARKER', 'SECRET-SUMMARY', 'SECRET-REQUEST-TEXT', HASH.slice(0, 12)]) expect(r.text).not.toContain(marker);
    expect(c.deps.load).toHaveBeenCalledWith('finance');
  });

  it('shapes the data: masked number, short ids, plan titles only, expired approval, blanked outbox code', async () => {
    const c = await start();
    const d = JSON.parse((await request(c.port, { path: '/api/department/finance' })).text);
    expect(Object.keys(d).sort()).toEqual(
      ['approvals', 'assistant', 'counts', 'generatedAt', 'id', 'mailbox', 'memory', 'name', 'notes', 'outbox', 'placeholder', 'receipts', 'tasks', 'timeline'],
    );
    expect(d).toMatchObject({ id: 'finance', name: 'Finance Department', placeholder: false, generatedAt: NOW.toISOString() });
    expect(d.assistant).toEqual({ displayName: 'Finance assistant', number: '…4514' });
    expect(d.counts).toEqual({ openTasks: 2, proposals: 1, pendingApprovals: 1 });

    expect(d.tasks[0]).toMatchObject({ id: '3f2a-91bc', kind: 'inbound_text', status: 'failed', attempts: 3, createdAt: '2026-10-26T20:15:03.123Z' });
    expect(d.tasks[0].lastError).toContain('…6543');
    expect(d.tasks[1].id).toBe('1234-5678');

    expect(d.mailbox[0].planTitles).toEqual(['Raise the Mazali price 10%', 'Pause the weakest ad set', 'Text lapsed buyers (call …0100)']);
    expect(d.mailbox[1]).toMatchObject({ from: 'owner', to: 'finance', kind: 'request', planTitles: [] });
    expect(Object.keys(d.mailbox[0]).sort()).toEqual(['createdAt', 'from', 'kind', 'planTitles', 'status', 'to']);

    expect(d.approvals).toEqual([{ action: 'decide_plan', status: 'expired', expiresAt: '2026-10-26T21:00:00.000Z', decidedAt: null }]);

    expect(d.outbox[0].body).toContain('SEND 2 ••••••');
    expect(d.outbox[0].body).toContain('…0100');
    expect(d.outbox[0].body).toContain('[hidden]');

    expect(d.receipts[0]).toMatchObject({ step: 'finance.plans', outcome: 'ok', durationMs: 2500, live: false, dataSource: 'zetaris:finance_mart' });
    expect(d.receipts[0].detail.length).toBeLessThanOrEqual(200);
    expect(d.receipts[0].detail).toMatch(/…$/);

    expect(d.memory).toEqual([{ text: expect.stringContaining('approved plan 2'), tags: ['decision', 'approved', 'proposal:8f2c9d41'] }]);
    expect(d.timeline).toEqual([
      { id: 'evt-2', type: 'proposal.recorded', at: '2026-10-26T20:16:00.000Z' },
      { id: 'evt-1', type: 'request.recorded', at: null },
    ]);
    expect(d.notes).toEqual(['The mailbox could not be read right now (42P01).']);
  });

  it('keeps a pending approval pending while it has not expired, and an empty department stays empty', async () => {
    const data = dirty();
    data.approvals = [{ action: 'forward_plan', status: 'pending', expires_at: '2026-10-26T21:45:00Z', decided_at: null }];
    data.assistant = null;
    data.counts = { openTasks: null, proposals: null, pendingApprovals: null };
    data.tasks = [];
    data.messages = [];
    const c = await start({ load: async () => data });
    const d = JSON.parse((await request(c.port, { path: '/api/department/owner' })).text);
    expect(d.approvals[0].status).toBe('pending');
    expect(d.assistant).toBeNull();
    expect(d.counts).toEqual({ openTasks: null, proposals: null, pendingApprovals: null });
    expect(d.tasks).toEqual([]);
    expect(d.mailbox).toEqual([]);
  });

  it('serves owner and online the same way', async () => {
    const c = await start();
    for (const id of ['owner', 'online']) {
      const r = await request(c.port, { path: `/api/department/${id}` });
      expect(r.status).toBe(200);
      expect(JSON.parse(r.text).id).toBe(id);
    }
    expect(vi.mocked(c.deps.load).mock.calls.map((x) => x[0])).toEqual(['owner', 'online']);
  });

  it('returns the salon placeholder and never calls the data source for it', async () => {
    const c = await start();
    const r = await request(c.port, { path: '/api/department/salon' });
    expect(r.status).toBe(200);
    const d = JSON.parse(r.text);
    expect(d).toEqual({ id: 'salon', name: 'Salon Department (Cindy)', placeholder: true, message: SALON_MESSAGE });
    expect(d.message).toContain('Cindy runs in her own app.');
    expect(d.message).toContain('her family and personal data stay in her app');
    expect(c.deps.load).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown department without calling the data source', async () => {
    const c = await start();
    for (const id of ['hr', 'admin', 'x', 'finance2']) {
      const r = await request(c.port, { path: `/api/department/${id}` });
      expect(r.status, id).toBe(404);
    }
    expect(c.deps.load).not.toHaveBeenCalled();
  });

  it('answers 502 in plain words, without the cause, when the data source fails', async () => {
    const log = vi.fn();
    const c = await start({ load: async () => { throw new Error('connect ECONNREFUSED with key sb_secret_xyz and code 123456'); }, log });
    const r = await request(c.port, { path: '/api/department/finance' });
    expect(r.status).toBe(502);
    expect(JSON.parse(r.text).error).toBe('The Finance Department could not be read right now. Try again in a moment.');
    expect(r.text).not.toMatch(/sb_secret|ECONNREFUSED|\d{6}/);
    expect(log).toHaveBeenCalledWith('console.load_failed department=finance reason=error');
    for (const line of log.mock.calls.flat()) expect(String(line)).not.toMatch(/sb_secret|\d{6}/);
  });
});

describe('the page', () => {
  it('contains all four tab names, the heading, the fonts and the palette, and no secret-looking text', async () => {
    const c = await start();
    const r = await request(c.port, { path: '/' });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    for (const d of DEPARTMENTS) expect(r.text).toContain(d.name);
    for (const name of ['Owner HQ', 'Finance Department', 'Online Customer Service Department', 'Salon Department (Cindy)']) expect(r.text).toContain(name);
    expect(r.text).toContain('Fortune AI Headquarters · Admin');
    expect(r.text).toContain('Playfair Display');
    expect(r.text).toContain('Lato');
    for (const color of ['#1f1f1f', '#faf8f4', '#6b6b6b', '#e7e2d9']) expect(r.text).toContain(color);
    expect(r.text).toContain('width=device-width');
    for (const bad of SECRET_LOOKING) expect(r.text).not.toMatch(bad);
    expect(r.text).not.toMatch(/\d{6}/);
    expect(r.text).toContain('10000'); // refreshes every 10 seconds
    expect(c.deps.load).not.toHaveBeenCalled();
  });

  it('draws data only with textContent: no innerHTML, outerHTML, document.write, eval or inline handlers', async () => {
    const c = await start();
    const html = (await request(c.port, { path: '/' })).text;
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|\son[a-z]+=/);
  });

  it('has a Content-Security-Policy whose hashes match the inline script and style, and a script that compiles', async () => {
    const c = await start();
    const r = await request(c.port, { path: '/' });
    const csp = String(r.headers['content-security-policy']);
    const script = /<script>([\s\S]*?)<\/script>/.exec(r.text)?.[1] ?? '';
    const style = /<style>([\s\S]*?)<\/style>/.exec(r.text)?.[1] ?? '';
    const hash = (s: string) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;
    expect(script.length).toBeGreaterThan(500);
    expect(csp).toContain(`script-src ${hash(script)}`);
    expect(csp).toContain(`style-src ${hash(style)}`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(() => new vm.Script(script)).not.toThrow();
    expect(r.text.match(/<script/g)).toHaveLength(1);
  });
});

describe('scrubbing', () => {
  it('masks every common spelling of a phone number to its last four digits', () => {
    for (const phone of ['+15551234567', '15551234567', '5551234567', '(555) 123-4567', '555-123-4567', '555.123.4567', '+1 555 123 4567', '+1 (555) 123-4567']) {
      expect(maskPhones(`call ${phone} now`), phone).toBe('call …4567 now');
    }
    expect(maskNumber('+15551234514')).toBe('…4514');
    expect(maskNumber('')).toBeNull();
    expect(maskNumber(null)).toBeNull();
  });

  it('blanks runs of six or more digits and leaves short numbers alone', () => {
    expect(redactCodes('SEND 2 123456')).toBe('SEND 2 ••••••');
    expect(redactCodes('code123456!')).toBe('code••••••!');
    expect(redactCodes('1234567890')).toBe('••••••');
    expect(redactCodes('plan 2 of 3, $1,250, 12345')).toBe('plan 2 of 3, $1,250, 12345');
  });

  it('removes keys, tokens and hashes, and cleans before it cuts', () => {
    const dirtyText = `service_role sb_secret_x eyJabc.def.ghi code_hash ${'f'.repeat(64)} Bearer abcdefgh12345678`;
    const cleaned = cleanText(dirtyText);
    for (const bad of SECRET_LOOKING) expect(cleaned).not.toMatch(bad);
    expect(cleaned).not.toMatch(/Bearer\s+abc/);
    // A code at the cut line is blanked before the cut, so half of it never survives.
    expect(clip(cleanText(`${'x'.repeat(95)} 123456`), 98)).not.toMatch(/\d{3}/);
    expect(clip('short', 10)).toBe('short');
  });
});

// ---- The cloud loader, against a recording fake of the Supabase client ---------------------------

type Call = { table: string; select: string; options: unknown; ops: string[] };

function recorder(answer: (call: Call) => { data: unknown; error?: { message: string; code?: string } | null; count?: number | null }) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      const call: Call = { table, select: '', options: undefined, ops: [] };
      calls.push(call);
      const chain: unknown = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === 'then') {
              return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
                const a = answer(call);
                return Promise.resolve({ data: a.data, error: a.error ?? null, count: a.count ?? null }).then(resolve, reject);
              };
            }
            return (...args: unknown[]) => {
              if (prop === 'select') {
                call.select = String(args[0]);
                call.options = args[1];
              } else call.ops.push(`${prop}(${args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(',')})`);
              return chain;
            };
          },
        },
      );
      return chain;
    },
  };
  return { db: db as never, calls };
}

const tmpDirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fahq-console-test-'));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('the cloud loader', () => {
  const noBrain = () => ({ dataDir: path.join(tmp(), 'missing'), meterlessDir: path.join(tmp(), 'none') });

  it('reads only safe columns from the queue tables and never touches people, inbound texts or spending', async () => {
    const r = recorder((call) => {
      if (call.table === 'assistants') return { data: { display_name: 'Finance assistant', sms_from: '+15551234514' } };
      if (call.table === 'assistant_messages') return { data: [{ id: 'm1', from_assistant: 'finance', to_assistant: 'owner', kind: 'proposal', status: 'open', created_at: '2026-10-26T20:00:00Z', body: {} }], count: 7 };
      if (call.table === 'approvals') return { data: [{ action: 'decide_plan', status: 'pending', expires_at: '2026-10-26T22:00:00Z', decided_at: null }], count: 1 };
      return { data: [], count: 4 };
    });
    const load = createCloudLoader({ db: r.db, now: () => NOW, brain: noBrain() });
    for (const id of ['owner', 'finance', 'online'] as const) {
      const raw = await load(id);
      expect(raw.counts).toEqual({ openTasks: 4, proposals: 7, pendingApprovals: 1 });
      expect(raw.approvals).toHaveLength(1);
      expect(raw.notes).toEqual([BRAIN_NOTE]);
    }
    const tables = new Set(r.calls.map((c) => c.table));
    expect([...tables].sort()).toEqual(['approvals', 'assistant_messages', 'assistants', 'outbox', 'receipts', 'tasks']);
    for (const c of r.calls) {
      expect(c.select, c.table).not.toMatch(/\*|code_hash|payload|phone|idempotency|lease/);
      expect(c.select.length).toBeGreaterThan(0);
    }
    const approvalQueries = r.calls.filter((c) => c.table === 'approvals');
    expect(approvalQueries.length).toBeGreaterThan(0);
    expect(approvalQueries.every((c) => c.select === 'action,status,expires_at,decided_at' || c.select === 'id')).toBe(true);
    // The pending count asks for codes that have not lapsed, by the injected clock.
    expect(approvalQueries.some((c) => c.ops.some((op) => op === `gt(expires_at,${NOW.toISOString()})`))).toBe(true);
    // Small limits everywhere.
    for (const c of r.calls.filter((x) => (x.options as { head?: boolean } | undefined)?.head !== true)) {
      const limit = c.ops.find((op) => op.startsWith('limit('));
      if (c.table !== 'assistants') expect(Number(limit?.slice(6, -1)), `${c.table} limit`).toBeLessThanOrEqual(100);
    }
  });

  it('reports a failed read by name and code, shows its count as unknown, and keeps going', async () => {
    const r = recorder((call) => (call.table === 'tasks' ? { data: null, error: { message: 'relation does not exist', code: '42P01' } } : { data: [], count: 0 }));
    const raw = await createCloudLoader({ db: r.db, now: () => NOW, brain: noBrain() })('finance');
    expect(raw.notes).toContain('The task list could not be read right now (42P01).');
    expect(raw.notes).toContain('The open-task count could not be read right now (42P01).');
    expect(raw.counts.openTasks).toBeNull();
    expect(raw.counts.proposals).toBe(0);
    expect(raw.tasks).toEqual([]);
    expect(JSON.stringify(raw.notes)).not.toContain('relation does not exist');
  });

  it('never queries for a department that is not an assistant it serves', async () => {
    const r = recorder(() => ({ data: [] }));
    await expect(createCloudLoader({ db: r.db, now: () => NOW, brain: noBrain() })('salon' as never)).rejects.toThrow('unknown department');
    expect(r.calls).toHaveLength(0);
  });
});

// ---- The brain reader ------------------------------------------------------------------------------

describe('the brain reader', () => {
  it('says "not available yet" when the brain folder is missing, and creates nothing', async () => {
    const base = tmp();
    const dataDir = path.join(base, '.local', 'brain');
    const view = await readBrain('finance', { dataDir, meterlessDir: path.join(base, 'meterless') });
    expect(view).toEqual({ available: false, decisions: [], timeline: [] });
    expect(fs.existsSync(dataDir)).toBe(false);
    expect(fs.readdirSync(base)).toEqual([]);
  });

  it('says "not available yet" when the files exist but the engines or files cannot be read', async () => {
    const dataDir = tmp();
    fs.writeFileSync(path.join(dataDir, 'x.json'), '{}');
    const view = await readBrain('owner', { dataDir, meterlessDir: path.join(tmp(), 'no-engines') });
    expect(view.available).toBe(false);
    const broken = await readBrain('owner', { dataDir, meterlessDir: '/x', open: async () => { throw new Error('unreadable'); } });
    expect(broken).toEqual({ available: false, decisions: [], timeline: [] });
  });

  it('reads a private copy, leaves the worker\'s files exactly as they were, and removes the copy', async () => {
    const dataDir = tmp();
    fs.mkdirSync(path.join(dataDir, 'world'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'world', 'events.json'), '{"keep":"me"}');
    const before = fs.readdirSync(dataDir, { recursive: true }).map(String).sort();

    const seen: { dataDir: string; actor: string; copied: string }[] = [];
    const open = (async (opts: { dataDir: string; actor: string }) => {
      seen.push({ dataDir: opts.dataDir, actor: opts.actor, copied: fs.readFileSync(path.join(opts.dataDir, 'world', 'events.json'), 'utf8') });
      // A recall writes to the memory folder; that must land in the copy, not in the original.
      fs.mkdirSync(path.join(opts.dataDir, 'memory', 'finance'), { recursive: true });
      fs.writeFileSync(path.join(opts.dataDir, 'memory', 'finance', 'state.json'), '{}');
      return {
        memory: () => ({ recallDecisions: (q: string, n: number) => (q.includes('decision') && n === 10 ? [{ memory: { content: 'Decision: approved plan 2', tags: ['decision', 'approved'] }, score: 1 }] : []) }),
        record: { timeline: (n: number) => (n === 30 ? [{ id: 'e1', type: 'request', at: '2026-10-26T20:00:00Z' }, { id: 'e2', type: 'proposal' }] : []) },
      };
    }) as never;

    const view = await readBrain('finance', { dataDir, meterlessDir: '/unused', open });
    expect(view.available).toBe(true);
    expect(view.decisions).toEqual([{ content: 'Decision: approved plan 2', tags: ['decision', 'approved'] }]);
    expect(view.timeline).toEqual([{ id: 'e2', type: 'proposal', at: null }, { id: 'e1', type: 'request', at: '2026-10-26T20:00:00Z' }]); // newest first

    expect(seen).toHaveLength(1);
    expect(seen[0]!.actor).toBe('console-reader');
    expect(seen[0]!.dataDir).not.toBe(dataDir);
    expect(seen[0]!.copied).toBe('{"keep":"me"}');
    expect(fs.existsSync(seen[0]!.dataDir)).toBe(false); // the copy is gone
    expect(fs.readdirSync(dataDir, { recursive: true }).map(String).sort()).toEqual(before); // nothing added to the original
    expect(fs.readFileSync(path.join(dataDir, 'world', 'events.json'), 'utf8')).toBe('{"keep":"me"}');
  });
});
