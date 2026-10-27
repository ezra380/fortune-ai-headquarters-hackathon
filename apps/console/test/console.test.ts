import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRAIN_NOTE, DEPARTMENTS, SALON_MESSAGE } from '../src/departments.ts';
import type { RawDepartment, RawManager, RawWorkReport } from '../src/departments.ts';
import { createCloudLoader, readBrain } from '../src/loader.ts';
import { PAGE_HTML } from '../src/page.ts';
import { cleanText, clip, maskNumber, maskPhones, redactCodes } from '../src/scrub.ts';
import { startConsoleServer } from '../src/server.ts';
import { shapeDepartment } from '../src/shape.ts';
import type { ConsoleDeps, RunningConsole } from '../src/server.ts';

// No network, no database, no real brain: every data source here is a fake the test injects.

const NOW = new Date('2026-10-26T21:30:00.000Z');
const HASH = 'a'.repeat(64);

/** Finished-work reports as dirty as they can be: a code, a phone number and a key sit in the texts. */
function dirtyReports(): RawWorkReport[] {
  return [
    {
      task_id: '3f2a91bc-1111-4222-8333-444455556666',
      assistant_id: 'finance',
      task_kind: 'inbound_text',
      outcome: 'done',
      summary: 'Wrote three plans, then texted code 123456 to +15559876543 (key sb_secret_abc123)',
      usage: { modelCalls: 2, inputTokens: 900, outputTokens: 300, codeMode: { scripts: 1, toolCalls: 3, resultChars: 1200 } },
      suggestions: [
        { kind: 'speed', about: 'finance', text: 'Shorten the plan prompt; call 212-555-0100 or use code 654321' },
        { kind: 'cost', about: 'finance', text: 'Fewer plan rewrites' },
      ],
      input_tokens: 900,
      output_tokens: 300,
      model_calls: 2,
      started_at: '2026-10-26T20:15:10.000Z',
      ended_at: '2026-10-26T20:15:42.500Z',
    },
    {
      task_id: '12345678-aaaa-bbbb-cccc-dddddddddddd',
      assistant_id: 'finance',
      task_kind: 'mailbox',
      outcome: 'failed',
      summary: 'The finance view could not be read',
      usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0 },
      suggestions: [],
      input_tokens: 0,
      output_tokens: 0,
      model_calls: 0,
      started_at: '2026-10-26T20:10:00Z',
      ended_at: '2026-10-26T20:10:03Z',
    },
  ];
}

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
        input_tokens: 1234,
        output_tokens: 56,
      },
      { step: 'finance.route', outcome: 'ok', model: null, data_source: null, started_at: '2026-10-26T20:15:09.000Z', ended_at: '2026-10-26T20:15:09.100Z', detail: null, live: true, input_tokens: null, output_tokens: null },
    ],
    reports: dirtyReports(),
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
    expect(list.departments.map((d) => d.id)).toEqual(['owner', 'finance', 'online', 'manager', 'salon']);
    expect(list.departments.map((d) => d.name)).toEqual([
      'Owner HQ', 'Finance Department', 'Online Customer Service Department', 'HQ Manager', 'Salon Department (Cindy)',
    ]);
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
      ['approvals', 'assistant', 'counts', 'generatedAt', 'id', 'mailbox', 'memory', 'name', 'notes', 'outbox', 'placeholder', 'receipts', 'reports', 'tasks', 'timeline'],
    );
    expect(d.manager).toBeUndefined(); // only the HQ Manager tab has a manager block
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

    expect(d.receipts[0]).toMatchObject({ step: 'finance.plans', outcome: 'ok', durationMs: 2500, live: false, dataSource: 'zetaris:finance_mart', inputTokens: 1234, outputTokens: 56 });
    expect(d.receipts[0].detail.length).toBeLessThanOrEqual(200);
    expect(d.receipts[0].detail).toMatch(/…$/);
    expect(d.receipts[1]).toMatchObject({ step: 'finance.route', inputTokens: null, outputTokens: null }); // no model call, no tokens

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
    for (const name of ['Owner HQ', 'Finance Department', 'Online Customer Service Department', 'HQ Manager', 'Salon Department (Cindy)']) expect(r.text).toContain(name);
    // The tab order is the department order: Owner, Finance, Online, HQ Manager, Salon.
    const tabs = [...r.text.matchAll(/data-id="([a-z]+)"/g)].map((m) => m[1]);
    expect(tabs).toEqual(['owner', 'finance', 'online', 'manager', 'salon']);
    expect(r.text).toContain('Work reports: what each task did, how many model calls and tokens it used, and what it suggests.');
    for (const title of ['Usage, last 24 hours', 'Latest review', 'Standing lessons']) expect(r.text).toContain(title);
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
    expect([...tables].sort()).toEqual(['approvals', 'assistant_messages', 'assistants', 'outbox', 'receipts', 'tasks', 'work_reports']);
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
        memory: () => ({ recallDecisions: (q: string, n: number) => (q.includes('decision') && n === 10 ? [{ memory: { content: 'Decision: approved plan 2', tags: ['decision', 'approved'] }, relevance: 1 }] : []) }),
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

// ---- Work reports on every tab, and the HQ Manager tab -------------------------------------------------

const REPORT_BASE = {
  usage: {},
  suggestions: [],
  input_tokens: 0,
  output_tokens: 0,
  model_calls: 0,
  started_at: '2026-10-26T20:00:00Z',
  ended_at: '2026-10-26T20:00:01Z',
};

function dirtyManagerData(): RawManager {
  return {
    usageRows: [
      { assistant_id: 'finance', outcome: 'done', model_calls: 3, input_tokens: 4000, output_tokens: 900 },
      { assistant_id: 'finance', outcome: 'done', model_calls: 2, input_tokens: 1000, output_tokens: 100 },
      { assistant_id: 'finance', outcome: 'failed', model_calls: 1, input_tokens: 500, output_tokens: 0 },
      { assistant_id: 'owner', outcome: 'done', model_calls: 1, input_tokens: 300, output_tokens: 20 },
      { assistant_id: 'owner', outcome: 'retrying', model_calls: 1, input_tokens: 200, output_tokens: null },
      { assistant_id: 'manager', outcome: 'done', model_calls: 1, input_tokens: 2500, output_tokens: 400 },
    ],
    review: {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      covers_from: '2026-10-25T21:00:00Z',
      covers_to: '2026-10-26T21:00:00Z',
      report_count: 6,
      review: {
        summary: 'Finance spent most tokens; call +15559876543 about code 482915 (key sb_secret_abc123).',
        findings: [
          { assistant: 'finance', text: 'Plan prompts are long; ref 111111' },
          { assistant: 'owner', text: 'One retry on a text' },
        ],
        recommendations: [{ rank: 1, assistant: 'finance', change: 'ignored: the recommendations table is the source', why: 'ignored' }],
      },
      model: 'nvidia/nemotron-3-ultra-550b-a55b',
      created_at: '2026-10-26T21:05:00Z',
    },
    recommendations: [
      { rank: 3, assistant_id: 'online', change: 'Keep answers under 80 words', why: 'Shorter replies cost fewer tokens', status: 'expired', decided_at: null },
      {
        rank: 1,
        assistant_id: 'finance',
        change: 'Shorten the plan prompt. Call 212-555-0100 or use 654321',
        why: 'It is the biggest input',
        status: 'adopted',
        decided_at: '2026-10-26T21:20:00Z',
        decided_by: 'demo-p-owner',
      } as never,
      { rank: 2, assistant_id: 'owner', change: 'Ask one clarifying question before planning', why: 'Fewer retries', status: 'proposed', decided_at: null },
    ],
    lessons: [
      { assistant_id: 'finance', change: 'Older lesson', status: 'adopted', decided_at: '2026-10-24T10:00:00Z' },
      { assistant_id: 'finance', change: 'Newest lesson, code 135790', status: 'adopted', decided_at: '2026-10-26T21:20:00Z' },
      { assistant_id: 'owner', change: 'A proposal that slipped into the lessons', status: 'proposed', decided_at: null },
    ],
    unread: [],
  };
}

function managerRaw(manager: RawManager | undefined = dirtyManagerData()): RawDepartment {
  return {
    assistant: { display_name: 'HQ Manager', sms_from: null },
    counts: { openTasks: 0, proposals: 1, pendingApprovals: 1 },
    tasks: [],
    messages: [],
    approvals: [],
    outbox: [],
    receipts: [],
    reports: [
      ...dirtyReports(),
      { ...REPORT_BASE, task_id: 'abcd1234-0000-0000-0000-000000000000', assistant_id: 'owner', task_kind: 'inbound_text', outcome: 'retrying', summary: 'Waiting on the model' },
    ],
    ...(manager ? { manager } : {}),
    decisions: [],
    timeline: [],
    notes: [],
  };
}

const manyReports = (n: number): RawWorkReport[] =>
  Array.from({ length: n }, (_, i) => ({ ...REPORT_BASE, task_id: `0000${i}`, assistant_id: i % 2 ? 'owner' : 'finance', task_kind: 'mailbox', outcome: 'done', summary: `Report ${i}` }));

describe('work reports on every live tab', () => {
  it('shows each department its own reports: outcome, summary, kind, model calls, tokens, seconds, suggestions', async () => {
    const c = await start();
    const d = JSON.parse((await request(c.port, { path: '/api/department/finance' })).text);
    expect(d.reports).toHaveLength(2);
    expect(d.reports[0]).toEqual({
      taskId: '3f2a-91bc',
      assistant: 'finance',
      taskKind: 'inbound_text',
      outcome: 'done',
      summary: expect.stringContaining('Wrote three plans'),
      modelCalls: 2,
      inputTokens: 900,
      outputTokens: 300,
      durationMs: 32500,
      endedAt: '2026-10-26T20:15:42.500Z',
      codeMode: { scripts: 1, toolCalls: 3, resultChars: 1200 },
      suggestions: [
        { kind: 'speed', about: 'finance', text: expect.stringContaining('Shorten the plan prompt') },
        { kind: 'cost', about: 'finance', text: 'Fewer plan rewrites' },
      ],
    });
    expect(d.reports[1]).toMatchObject({ taskId: '1234-5678', outcome: 'failed', modelCalls: 0, codeMode: null, suggestions: [] });
    expect(Object.keys(d.reports[0]).sort()).toEqual(
      ['assistant', 'codeMode', 'durationMs', 'endedAt', 'inputTokens', 'modelCalls', 'outcome', 'outputTokens', 'suggestions', 'summary', 'taskId', 'taskKind'],
    );
  });

  it('cuts a department to its latest 15 reports and the HQ Manager to 30', async () => {
    const c = await start({ load: async (id) => ({ ...(id === 'manager' ? managerRaw() : dirty()), reports: manyReports(50) }) });
    const finance = JSON.parse((await request(c.port, { path: '/api/department/finance' })).text);
    const manager = JSON.parse((await request(c.port, { path: '/api/department/manager' })).text);
    expect(finance.reports).toHaveLength(15);
    expect(manager.reports).toHaveLength(30);
    expect(new Set(manager.reports.map((r: { assistant: string }) => r.assistant))).toEqual(new Set(['finance', 'owner']));
  });
});

describe('the HQ Manager tab', () => {
  async function getManager(raw: RawDepartment = managerRaw()) {
    const load = vi.fn(async () => raw);
    const c = await start({ load });
    const r = await request(c.port, { path: '/api/department/manager' });
    return { c, load, r, d: JSON.parse(r.text) };
  }

  it('is a live tab with its own data, no texting number, and a manager block', async () => {
    const { load, r, d } = await getManager();
    expect(r.status).toBe(200);
    expect(load.mock.calls).toEqual([['manager']]);
    expect(d).toMatchObject({ id: 'manager', name: 'HQ Manager', placeholder: false });
    expect(d.assistant).toEqual({ displayName: 'HQ Manager', number: null });
    expect(Object.keys(d.manager).sort()).toEqual(['lessons', 'review', 'unread', 'usage']);
    expect(d.reports).toHaveLength(3);
    expect(d.reports.map((x: { assistant: string }) => x.assistant)).toEqual(['finance', 'finance', 'owner']); // all assistants
  });

  it('adds up the last 24 hours per assistant, listing every live assistant even at zero', async () => {
    const { d } = await getManager();
    const usage = d.manager.usage;
    expect(usage.windowHours).toBe(24);
    expect(usage.rows.map((x: { assistant: string }) => x.assistant)).toEqual(['owner', 'finance', 'online', 'manager']);
    const by = Object.fromEntries(usage.rows.map((x: { assistant: string }) => [x.assistant, x]));
    expect(by.finance).toEqual({ assistant: 'finance', tasks: 3, done: 2, failed: 1, retrying: 0, modelCalls: 6, inputTokens: 5500, outputTokens: 1000 });
    expect(by.owner).toEqual({ assistant: 'owner', tasks: 2, done: 1, failed: 0, retrying: 1, modelCalls: 2, inputTokens: 500, outputTokens: 20 });
    expect(by.online).toEqual({ assistant: 'online', tasks: 0, done: 0, failed: 0, retrying: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0 });
    expect(by.manager).toMatchObject({ tasks: 1, done: 1, failed: 0, modelCalls: 1, inputTokens: 2500, outputTokens: 400 });
    expect(usage.total).toEqual({ tasks: 6, done: 4, failed: 1, retrying: 1, modelCalls: 9, inputTokens: 8500, outputTokens: 1420 });
  });

  it('counts an unfamiliar assistant id in the total, after the four live rows', async () => {
    const data = dirtyManagerData();
    data.usageRows = [...(data.usageRows ?? []), { assistant_id: 'zeta', outcome: 'done', model_calls: 1, input_tokens: 10, output_tokens: 5 }];
    const { d } = await getManager(managerRaw(data));
    expect(d.manager.usage.rows.map((x: { assistant: string }) => x.assistant)).toEqual(['owner', 'finance', 'online', 'manager', 'zeta']);
    expect(d.manager.usage.total.tasks).toBe(7);
  });

  it('shows the latest review: when, covered window, summary, findings, and recommendations with their status', async () => {
    const { d } = await getManager();
    const review = d.manager.review;
    expect(review).toMatchObject({
      createdAt: '2026-10-26T21:05:00.000Z',
      coversFrom: '2026-10-25T21:00:00.000Z',
      coversTo: '2026-10-26T21:00:00.000Z',
      reportCount: 6,
      model: 'nvidia/nemotron-3-ultra-550b-a55b',
    });
    expect(review.summary).toContain('Finance spent most tokens');
    expect(review.findings).toEqual([
      { assistant: 'finance', text: 'Plan prompts are long; ref ••••••' },
      { assistant: 'owner', text: 'One retry on a text' },
    ]);
    // The recommendations table is the source (it holds the status), in rank order.
    expect(review.recommendations.map((x: { rank: number; assistant: string; status: string }) => [x.rank, x.assistant, x.status])).toEqual([
      [1, 'finance', 'adopted'],
      [2, 'owner', 'proposed'],
      [3, 'online', 'expired'],
    ]);
    expect(review.recommendations[0].decidedAt).toBe('2026-10-26T21:20:00.000Z');
    expect(review.recommendations[1].decidedAt).toBeNull();
    expect(Object.keys(review.recommendations[0]).sort()).toEqual(['assistant', 'change', 'decidedAt', 'rank', 'status', 'why']);
    expect(JSON.stringify(review)).not.toContain('ignored');
  });

  it('never shows who decided: only the status and when', async () => {
    const { r } = await getManager();
    expect(r.text).not.toMatch(/decided_by|decidedBy|demo-p-owner/);
  });

  it('lists the standing lessons: adopted ones only, newest first, whatever order the source used', async () => {
    const { d } = await getManager();
    expect(d.manager.lessons).toEqual([
      { assistant: 'finance', change: 'Newest lesson, code ••••••', adoptedAt: '2026-10-26T21:20:00.000Z' },
      { assistant: 'finance', change: 'Older lesson', adoptedAt: '2026-10-24T10:00:00.000Z' },
    ]);
  });

  it('is empty, not broken, before any review or lesson exists', async () => {
    const { d } = await getManager(managerRaw({ usageRows: [], review: null, recommendations: [], lessons: [], unread: [] }));
    expect(d.manager.review).toBeNull();
    expect(d.manager.lessons).toEqual([]);
    expect(d.manager.usage.total).toEqual({ tasks: 0, done: 0, failed: 0, retrying: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0 });
    expect(d.manager.unread).toEqual([]);
  });

  it('says a part could not be read instead of showing it as empty', () => {
    const info = DEPARTMENTS.find((x) => x.id === 'manager')!;
    const raw = managerRaw({ usageRows: null, review: null, recommendations: [], lessons: [], unread: ['usage', 'review', 'lessons'] });
    raw.notes = ['The last day of work reports could not be read right now (42P01).'];
    const view = shapeDepartment(raw, info, NOW);
    expect(view.manager).toEqual({ usage: null, review: null, lessons: [], unread: ['usage', 'review', 'lessons'] });
    expect(view.notes).toEqual(['The last day of work reports could not be read right now (42P01).']);
  });

  it('keeps tasks, receipts and texts like the other tabs, and the other tabs never get a manager block', async () => {
    const { d } = await getManager(managerRaw());
    for (const key of ['tasks', 'mailbox', 'approvals', 'outbox', 'receipts', 'memory', 'timeline', 'notes', 'counts']) expect(d, key).toHaveProperty(key);
    const c = await start();
    for (const id of ['owner', 'finance', 'online']) {
      expect(JSON.parse((await request(c.port, { path: `/api/department/${id}` })).text), id).not.toHaveProperty('manager');
    }
  });
});

describe('scrubbing the reports and the manager', () => {
  it('lets no code, phone number, key or hash out of any report, review, lesson or suggestion', async () => {
    const c = await start({ load: async (id) => (id === 'manager' ? managerRaw() : dirty()) });
    for (const id of ['finance', 'manager']) {
      const r = await request(c.port, { path: `/api/department/${id}` });
      expect(r.status).toBe(200);
      expect(r.text, id).not.toMatch(/\d{6}/);
      expect(r.text, id).not.toMatch(/\+?1?[\s.(-]*\d{3}[\s.)-]*\d{3}[\s.-]*\d{4}/);
      for (const bad of SECRET_LOOKING) expect(r.text, id).not.toMatch(bad);
    }
    const d = JSON.parse((await request(c.port, { path: '/api/department/finance' })).text);
    expect(d.reports[0].summary).toContain('code ••••••');
    expect(d.reports[0].summary).toContain('…6543');
    expect(d.reports[0].summary).toContain('[hidden]');
    expect(d.reports[0].suggestions[0].text).toContain('…0100');
    expect(d.reports[0].suggestions[0].text).toContain('••••••');
    const m = JSON.parse((await request(c.port, { path: '/api/department/manager' })).text);
    expect(m.manager.review.summary).toContain('code ••••••');
    expect(m.manager.review.recommendations[0].change).toContain('…0100');
  });

  it('cuts every report, review and lesson text to its limit, after cleaning', async () => {
    const long = `${'word '.repeat(300)}999999`;
    const data = dirtyManagerData();
    data.review = { ...data.review!, review: { summary: long, findings: [{ assistant: 'owner', text: long }] } };
    data.recommendations = [{ rank: 1, assistant_id: 'owner', change: long, why: long, status: 'proposed', decided_at: null }];
    data.lessons = [{ assistant_id: 'owner', change: long, status: 'adopted', decided_at: '2026-10-26T21:20:00Z' }];
    const raw = managerRaw(data);
    raw.reports = [{ ...REPORT_BASE, assistant_id: 'owner', task_kind: 'mailbox', outcome: 'done', summary: long, suggestions: [{ kind: 'cost', about: 'owner', text: long }] }];
    const c = await start({ load: async () => raw });
    const d = JSON.parse((await request(c.port, { path: '/api/department/manager' })).text);
    expect(d.manager.review.summary.length).toBeLessThanOrEqual(500);
    expect(d.manager.review.findings[0].text.length).toBeLessThanOrEqual(300);
    expect(d.manager.review.recommendations[0].change.length).toBeLessThanOrEqual(300);
    expect(d.manager.review.recommendations[0].why.length).toBeLessThanOrEqual(300);
    expect(d.manager.lessons[0].change.length).toBeLessThanOrEqual(300);
    expect(d.reports[0].summary.length).toBeLessThanOrEqual(300);
    expect(d.reports[0].suggestions[0].text.length).toBeLessThanOrEqual(300);
    expect(JSON.stringify(d)).not.toMatch(/\d{6}/);
  });

  it('keeps at most five suggestions per report, six findings and three recommendations', async () => {
    const data = dirtyManagerData();
    data.review = {
      ...data.review!,
      review: { summary: 'ok', findings: Array.from({ length: 9 }, (_, i) => ({ assistant: 'owner', text: `Finding ${i}` })) },
    };
    data.recommendations = Array.from({ length: 8 }, (_, i) => ({ rank: i + 1, assistant_id: 'owner', change: `Change ${i}`, why: 'why', status: 'proposed', decided_at: null }));
    const raw = managerRaw(data);
    raw.reports = [{ ...REPORT_BASE, assistant_id: 'owner', task_kind: 'mailbox', outcome: 'done', summary: 's', suggestions: Array.from({ length: 9 }, (_, i) => ({ kind: 'cost', about: 'owner', text: `Idea ${i}` })) }];
    const c = await start({ load: async () => raw });
    const d = JSON.parse((await request(c.port, { path: '/api/department/manager' })).text);
    expect(d.manager.review.findings).toHaveLength(6);
    expect(d.manager.review.recommendations).toHaveLength(3);
    expect(d.reports[0].suggestions).toHaveLength(5);
  });
});

describe('bad jsonb is tolerated', () => {
  it('turns unreadable usage, suggestions, reviews and statuses into notes, and keeps everything else', async () => {
    const data: RawManager = {
      ...dirtyManagerData(),
      review: { ...dirtyManagerData().review!, review: 'this is not json' },
      recommendations: [{ rank: 1, assistant_id: 'finance', change: 'Do a thing', why: 'Because', status: 'sideways', decided_at: 'not a date' }],
    };
    const raw = managerRaw(data);
    raw.reports = [
      { ...REPORT_BASE, task_id: null, assistant_id: 'finance', task_kind: 'a', outcome: 'done', summary: 'usage is text', usage: 'oops', suggestions: { not: 'an array' }, input_tokens: null, output_tokens: null, model_calls: null, started_at: 'nope', ended_at: null as never },
      { ...REPORT_BASE, assistant_id: 'owner', task_kind: 'b', outcome: 'done', summary: 'partly bad', usage: { modelCalls: 4, inputTokens: 70, outputTokens: 8, codeMode: 'big' }, suggestions: [42, { kind: 'x' }, { kind: 'cost', about: 'owner', text: 'Keep this one' }], input_tokens: null, output_tokens: null, model_calls: null },
      { ...REPORT_BASE, assistant_id: 'online', task_kind: 'c', outcome: 'done', summary: 'json text', usage: '{"modelCalls":7,"inputTokens":5000,"outputTokens":3}', suggestions: '[{"kind":"data","about":"finance","text":"From JSON text"}]', input_tokens: null, output_tokens: null, model_calls: null },
    ];
    const c = await start({ load: async () => raw });
    const r = await request(c.port, { path: '/api/department/manager' });
    expect(r.status).toBe(200);
    const d = JSON.parse(r.text);

    expect(d.reports[0]).toMatchObject({ summary: 'usage is text', modelCalls: 0, inputTokens: 0, outputTokens: 0, durationMs: null, endedAt: null, codeMode: null, suggestions: [], taskId: '' });
    expect(d.reports[1]).toMatchObject({ modelCalls: 4, inputTokens: 70, outputTokens: 8, codeMode: null, suggestions: [{ kind: 'cost', about: 'owner', text: 'Keep this one' }] });
    expect(d.reports[2]).toMatchObject({ modelCalls: 7, inputTokens: 5000, outputTokens: 3, suggestions: [{ kind: 'data', about: 'finance', text: 'From JSON text' }] });

    expect(d.manager.review).toMatchObject({ summary: null, findings: [], reportCount: 6 });
    expect(d.manager.review.recommendations).toEqual([{ rank: 1, assistant: 'finance', change: 'Do a thing', why: 'Because', status: 'unknown', decidedAt: null }]);

    const notes = d.notes.join(' | ');
    expect(notes).toContain('usage details that could not be read');
    expect(notes).toContain('suggestions could not be read');
    expect(notes).toContain('latest review could not be read in full');
    expect(notes).toContain('status this console does not know');
    expect(d.notes.length).toBeLessThanOrEqual(8);
    expect(new Set(d.notes).size).toBe(d.notes.length); // one line per kind of problem, not one per report
  });

  it('reads a review whose findings are the wrong shape without losing its summary', async () => {
    const data = dirtyManagerData();
    data.review = { ...data.review!, review: { summary: 'Fine summary', findings: 'not a list' } };
    const c = await start({ load: async () => managerRaw(data) });
    const d = JSON.parse((await request(c.port, { path: '/api/department/manager' })).text);
    expect(d.manager.review).toMatchObject({ summary: 'Fine summary', findings: [] });
    expect(d.notes.join(' ')).toContain('findings in the latest review could not be read');

    data.review = { ...data.review!, review: { summary: 'Fine summary', findings: [null, 5, { assistant: 'owner' }, { assistant: 'owner', text: 'Good one' }] } };
    const again = JSON.parse((await request(c.port, { path: '/api/department/manager' })).text);
    expect(again.manager.review.findings).toEqual([{ assistant: 'owner', text: 'Good one' }]);
  });

  it('survives a review, usage list or report list that is missing or the wrong kind of thing', async () => {
    const info = DEPARTMENTS.find((x) => x.id === 'manager')!;
    const weird = { ...managerRaw(), reports: 'nope' as never, manager: { usageRows: 'nope' as never, review: { covers_from: 'x', covers_to: 'y', report_count: 'z' as never, review: 7, model: null, created_at: null as never }, recommendations: 'nope' as never, lessons: null as never, unread: 'nope' as never } };
    expect(() => shapeDepartment(weird, info, NOW)).not.toThrow();
    const view = shapeDepartment(weird, info, NOW);
    expect(view.reports).toEqual([]);
    expect(view.manager?.review).toMatchObject({ summary: null, findings: [], recommendations: [], reportCount: 0, createdAt: null });
    expect(view.manager?.lessons).toEqual([]);
    expect(view.manager?.usage?.total.tasks).toBe(0);
    const bare = managerRaw();
    delete bare.manager;
    delete bare.reports;
    expect(shapeDepartment(bare, info, NOW).manager?.usage?.total.tasks).toBe(0);
    expect(shapeDepartment(bare, info, NOW).reports).toEqual([]);
  });
});

describe('the cloud loader for work reports and the HQ Manager', () => {
  const REPORT_SELECT = 'task_id,assistant_id,task_kind,outcome,summary,usage,suggestions,input_tokens,output_tokens,model_calls,started_at,ended_at';
  const USAGE_SELECT = 'assistant_id,outcome,model_calls,input_tokens,output_tokens';
  const noBrain = () => ({ dataDir: path.join(tmp(), 'missing'), meterlessDir: path.join(tmp(), 'none') });
  const NOT_SAFE = /\*|code_hash|decided_by|digest|steps|review_key|run_id|payload|phone|idempotency|lease/;

  it('reads each department its own latest 15 reports, and the token columns of its receipts', async () => {
    const r = recorder((call) => (call.table === 'assistants' ? { data: { display_name: 'x', sms_from: null } } : { data: [], count: 0 }));
    const load = createCloudLoader({ db: r.db, now: () => NOW, brain: noBrain() });
    for (const id of ['owner', 'finance', 'online'] as const) {
      const before = r.calls.length;
      const raw = await load(id);
      expect(raw.reports).toEqual([]);
      expect(raw.manager).toBeUndefined();
      const mine = r.calls.slice(before);
      const reports = mine.filter((c) => c.table === 'work_reports');
      expect(reports).toHaveLength(1);
      expect(reports[0]!.select).toBe(REPORT_SELECT);
      expect(reports[0]!.ops).toContain(`eq(assistant_id,${id})`);
      expect(reports[0]!.ops).toContain('limit(15)');
      expect(reports[0]!.ops.some((op) => op.startsWith('order(ended_at'))).toBe(true);
      expect(mine.find((c) => c.table === 'receipts')!.select).toBe('step,outcome,model,data_source,started_at,ended_at,detail,live,input_tokens,output_tokens');
      expect(mine.some((c) => c.table === 'manager_reviews' || c.table === 'recommendations')).toBe(false);
    }
    for (const c of r.calls) expect(c.select, c.table).not.toMatch(NOT_SAFE);
  });

  it('reads the HQ Manager tab: all assistants\' latest 30, the last 24 hours, the latest review, its recommendations and the lessons', async () => {
    const usageRows = dirtyManagerData().usageRows!;
    const review = dirtyManagerData().review!;
    const recommendations = dirtyManagerData().recommendations;
    const lessons = dirtyManagerData().lessons;
    const reports = dirtyReports();
    const r = recorder((call) => {
      if (call.table === 'assistants') return { data: { display_name: 'HQ Manager', sms_from: null } };
      if (call.table === 'work_reports') return { data: call.select === USAGE_SELECT ? usageRows : reports };
      if (call.table === 'manager_reviews') return { data: [review] };
      if (call.table === 'recommendations') return { data: call.ops.some((op) => op.startsWith('eq(review_id,')) ? recommendations : lessons };
      return { data: [], count: 0 };
    });
    const raw = await createCloudLoader({ db: r.db, now: () => NOW, brain: noBrain() })('manager');

    const wr = r.calls.filter((c) => c.table === 'work_reports');
    expect(wr).toHaveLength(2);
    const list = wr.find((c) => c.select === REPORT_SELECT)!;
    expect(list.ops.some((op) => op.startsWith('eq(assistant_id'))).toBe(false); // all assistants
    expect(list.ops).toContain('limit(30)');
    const usage = wr.find((c) => c.select === USAGE_SELECT)!;
    expect(usage.ops).toContain(`gte(ended_at,2026-10-25T21:30:00.000Z)`); // the injected clock minus 24 hours
    expect(usage.ops).toContain('limit(500)');

    const reviews = r.calls.find((c) => c.table === 'manager_reviews')!;
    expect(reviews.select).toBe('id,covers_from,covers_to,report_count,review,model,created_at');
    expect(reviews.ops).toContain('limit(1)');
    const recs = r.calls.filter((c) => c.table === 'recommendations');
    expect(recs).toHaveLength(2);
    const forReview = recs.find((c) => c.ops.some((op) => op.startsWith('eq(review_id,')))!;
    expect(forReview.select).toBe('rank,assistant_id,change,why,status,decided_at');
    expect(forReview.ops).toContain(`eq(review_id,${review.id})`);
    expect(forReview.ops).toContain('limit(3)');
    const forLessons = recs.find((c) => c !== forReview)!;
    expect(forLessons.select).toBe('assistant_id,change,status,decided_at');
    expect(forLessons.ops).toContain('eq(status,adopted)');
    expect(forLessons.ops).toContain('limit(20)');
    for (const c of r.calls) expect(c.select, c.table).not.toMatch(NOT_SAFE);

    expect(raw.reports).toEqual(reports);
    expect(raw.manager).toEqual({ usageRows, review, recommendations, lessons, unread: [] });
  });

  it('names the parts it could not read, shows them unread rather than empty, and keeps the rest', async () => {
    const r = recorder((call) => {
      if (call.table === 'manager_reviews' || call.table === 'recommendations') return { data: null, error: { message: 'relation does not exist', code: '42P01' } };
      if (call.table === 'work_reports' && call.select === USAGE_SELECT) return { data: null, error: { message: 'boom', code: '57014' } };
      if (call.table === 'work_reports') return { data: dirtyReports() };
      return { data: [], count: 0 };
    });
    const raw = await createCloudLoader({ db: r.db, now: () => NOW, brain: noBrain() })('manager');
    expect(raw.manager).toEqual({ usageRows: null, review: null, recommendations: [], lessons: [], unread: ['usage', 'review', 'lessons'] });
    expect(raw.notes).toContain('The last day of work reports could not be read right now (57014).');
    expect(raw.notes).toContain('The latest review could not be read right now (42P01).');
    expect(raw.notes).toContain('The standing lessons could not be read right now (42P01).');
    expect(raw.reports).toHaveLength(2);
    expect(JSON.stringify(raw.notes)).not.toMatch(/relation does not exist|boom/);

    const view = shapeDepartment(raw, DEPARTMENTS.find((x) => x.id === 'manager')!, NOW);
    expect(view.manager).toMatchObject({ usage: null, review: null, lessons: [], unread: ['usage', 'review', 'lessons'] });
  });

  it('says so when the last day holds more reports than it adds up', async () => {
    const rows = Array.from({ length: 500 }, () => ({ assistant_id: 'finance', outcome: 'done', model_calls: 1, input_tokens: 1, output_tokens: 1 }));
    const r = recorder((call) => (call.table === 'work_reports' && call.select === USAGE_SELECT ? { data: rows } : { data: [], count: 0 }));
    const raw = await createCloudLoader({ db: r.db, now: () => NOW, brain: noBrain() })('manager');
    expect(raw.notes.some((n) => n.startsWith('More than 500 reports finished in the last 24 hours'))).toBe(true);
  });

  it('reads no review when there is none yet, and does not ask for recommendations', async () => {
    const r = recorder((call) => (call.table === 'manager_reviews' ? { data: [] } : { data: [], count: 0 }));
    const raw = await createCloudLoader({ db: r.db, now: () => NOW, brain: noBrain() })('manager');
    expect(raw.manager).toMatchObject({ review: null, recommendations: [], unread: [] });
    expect(r.calls.filter((c) => c.table === 'recommendations')).toHaveLength(1); // only the lessons read
  });
});

// ---- The page, drawn for real against a tiny fake of the browser ---------------------------------------

class FakeEl {
  children: FakeEl[] = [];
  className = '';
  tabIndex = 0;
  own = '';
  private readonly attrs = new Map<string, string>();
  constructor(readonly tag: string) {}
  set textContent(v: string) {
    this.own = String(v);
    this.children = [];
  }
  get textContent(): string {
    return [this.own, ...this.children.map((c) => c.textContent)].filter((x) => x !== '').join('\n');
  }
  appendChild(c: FakeEl): FakeEl {
    this.children.push(c);
    return c;
  }
  replaceChildren(...items: FakeEl[]): void {
    this.own = '';
    this.children = items.flatMap((i) => (i.tag === '#fragment' ? i.children : [i]));
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  addEventListener(): void {}
  focus(): void {}
}

/** Runs the page's own script with a fake document, the way the browser would, and returns the text it drew. */
async function drawTab(id: string, payload: unknown): Promise<string> {
  const script = /<script>([\s\S]*?)<\/script>/.exec(PAGE_HTML)?.[1] ?? '';
  const tabs = DEPARTMENTS.map((d) => {
    const el = new FakeEl('button');
    el.setAttribute('data-id', d.id);
    return el;
  });
  const panel = new FakeEl('main');
  const byId: Record<string, FakeEl> = { panel, updated: new FakeEl('span'), foot: new FakeEl('footer') };
  const sandbox = {
    document: {
      querySelectorAll: () => tabs,
      getElementById: (k: string) => byId[k],
      createElement: (t: string) => new FakeEl(t),
      createTextNode: (t: string) => {
        const e = new FakeEl('#text');
        e.textContent = t;
        return e;
      },
      createDocumentFragment: () => new FakeEl('#fragment'),
      addEventListener: () => {},
      hidden: false,
    },
    location: { hash: `#${id}` },
    history: { replaceState: () => {} },
    fetch: async () => ({ ok: true, json: async () => payload }),
    setInterval: () => 0,
  };
  vm.runInNewContext(script, sandbox);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return panel.textContent;
}

describe('the page draws the new sections', () => {
  const read = async (id: string, load: ConsoleDeps['load']) => {
    const c = await start({ load });
    return JSON.parse((await request(c.port, { path: `/api/department/${id}` })).text);
  };

  it('draws the HQ Manager tab: usage, latest review with statuses, standing lessons, work reports', async () => {
    const shown = await drawTab('manager', await read('manager', async () => managerRaw()));
    for (const part of [
      'Usage, last 24 hours', 'All assistants', `${(5500).toLocaleString()} tokens in`, '3 tasks', '2 done', '1 failed', '1 retrying',
      'Latest review', 'Finance spent most tokens', 'Plan prompts are long', 'Shorten the plan prompt', 'Why: It is the biggest input',
      'adopted', 'proposed', 'expired', 'Not adopted yet', 'Expired without being adopted',
      'Standing lessons', 'Newest lesson', 'Older lesson',
      'Work reports: what each task did, how many model calls and tokens it used, and what it suggests.', 'The latest 30, across all assistants.',
      'Finance: inbound text', '2 model calls', '900 in / 300 out tokens', 'Code Mode: 1 script, 3 lookups',
      'Suggests (speed, Finance)', 'has no number; it reaches the owner through Owner HQ',
    ]) expect(shown, part).toContain(part);
    expect(shown).not.toMatch(/undefined|NaN|\[object/);
    expect(shown).not.toMatch(/\d{6}/);
  });

  it('draws work reports and token counts on a department tab, with no manager sections', async () => {
    const shown = await drawTab('finance', await read('finance', async () => dirty()));
    for (const part of ['Work reports', 'The latest 15 for this assistant.', 'Wrote three plans', '2 model calls', 'Suggests (cost, Finance): Fewer plan rewrites', `${(1234).toLocaleString()} in / 56 out tokens`]) {
      expect(shown, part).toContain(part);
    }
    for (const part of ['Latest review', 'Standing lessons', 'Usage, last 24 hours']) expect(shown, part).not.toContain(part);
    expect(shown).not.toMatch(/undefined|NaN|\[object/);
  });

  it('draws "could not be read" for an unread part and "none yet" for an empty one', async () => {
    const unread = await drawTab('manager', await read('manager', async () => managerRaw({ usageRows: null, review: null, recommendations: [], lessons: [], unread: ['usage', 'review', 'lessons'] })));
    expect(unread).toContain('The last 24 hours of work reports could not be read right now.');
    expect(unread).toContain('The latest review could not be read right now.');
    expect(unread).toContain('The standing lessons could not be read right now.');
    const empty = await drawTab('manager', await read('manager', async () => managerRaw({ usageRows: [], review: null, recommendations: [], lessons: [], unread: [] })));
    expect(empty).toContain('No review yet.');
    expect(empty).toContain('None yet. A recommendation becomes a standing lesson only after the owner adopts it with a code.');
  });
});
