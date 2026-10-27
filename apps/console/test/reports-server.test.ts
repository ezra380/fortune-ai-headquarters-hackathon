import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWeeklyPacketPdf, renderWorkerReportPdf } from '@fahq/delivery';
import type { ConsoleDeps, RunningConsole } from '../src/server.ts';
import { startConsoleServer } from '../src/server.ts';
import { ReportUnreadable } from '../src/loader.ts';
import type { LoadedReport } from '../src/loader.ts';
import { PAGE_CSP, PAGE_HTML } from '../src/page.ts';
import { shapeDivisions } from '../src/shape.ts';
import { pdfText } from '../../../packages/delivery/test/pdf-text.ts';
import { everything, NOW, raw, weeklyReport, weeklyRowId, workerReport, workerRowId, WORKERS_OF } from './reports-fixtures.ts';

// The wave-2 routes of the console: a head's own view (?division=), and the PDF a report link opens. Every console rule still
// holds: GET and HEAD only, loopback only, nothing cached, nothing secret.

const running: RunningConsole[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.close();
});

const packet = (division: 'finance' | 'online' | 'salon'): LoadedReport => ({
  kind: 'weekly', division, weekly: weeklyReport(division), workers: WORKERS_OF[division].map((w) => workerReport(w)),
});
const single = (): LoadedReport => ({ kind: 'worker', division: 'finance', worker: workerReport('finance.meta') });

async function start(over: Partial<ConsoleDeps> = {}) {
  const deps: ConsoleDeps = {
    load: vi.fn(async () => { throw new Error('not used'); }),
    loadDivisions: vi.fn(async () => raw()),
    loadReport: vi.fn(async (kind: 'weekly' | 'worker') => (kind === 'weekly' ? packet('finance') : single())),
    now: () => NOW,
    log: () => {},
    ...over,
  };
  const c = await startConsoleServer(deps, 0);
  running.push(c);
  return { ...c, deps };
}

type Reply = { status: number; headers: http.IncomingHttpHeaders; bytes: Buffer; text: string };
function request(port: number, opts: { method?: string; path: string; headers?: Record<string, string> }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes, text: bytes.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const weeklyPath = (id = weeklyRowId('finance')) => `/report/weekly/${id}.pdf`;
const workerPath = (id = workerRowId('finance.meta', '2026-10-27')) => `/report/worker/${id}.pdf`;

describe('a head\'s own view: /api/divisions?division=', () => {
  it('asks for that one division, and serves only it, with no CEO digest', async () => {
    const dirty = raw({ digest: { created_at: '2026-10-27T12:30:05Z', body: { type: 'ceo_digest', date: '2026-10-27', text: 'Company status: Salon is steady.', reports: [] } } });
    const c = await start({ loadDivisions: vi.fn(async () => dirty) });
    const res = await request(c.port, { path: '/api/divisions?division=finance' });
    expect(res.status).toBe(200);
    expect(c.deps.loadDivisions).toHaveBeenCalledTimes(1);
    expect(c.deps.loadDivisions).toHaveBeenCalledWith('finance');
    expect(JSON.parse(res.text)).toEqual(JSON.parse(JSON.stringify(shapeDivisions(dirty, NOW, 'finance'))));
    const body = JSON.parse(res.text);
    expect(body.only).toBe('finance');
    expect(body.divisions.map((d: { id: string }) => d.id)).toEqual(['finance']);
    expect(body.digest).toBeNull();
    expect(res.text).not.toMatch(/Cindy|Georgette|Company status/);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('asks for every division when no division is named, as before', async () => {
    const c = await start();
    const res = await request(c.port, { path: '/api/divisions' });
    expect(res.status).toBe(200);
    expect(c.deps.loadDivisions).toHaveBeenCalledWith(undefined);
    expect(JSON.parse(res.text).divisions).toHaveLength(3);
  });

  it('answers 404, without reading anything, for a division that is not one of the three, or named twice', async () => {
    const c = await start();
    for (const q of ['division=hq', 'division=owner', 'division=Finance', 'division=', 'division=finance&division=online', 'division=finance%00', 'division=%66inance%27']) {
      const res = await request(c.port, { path: `/api/divisions?${q}` });
      expect(res.status, q).toBe(404);
      expect(JSON.parse(res.text)).toEqual({ error: 'Not found.' });
    }
    expect(c.deps.loadDivisions).not.toHaveBeenCalled();
  });

  it('answers 502 in plain words when the head\'s division cannot be read, and logs only a code', async () => {
    const log = vi.fn();
    const c = await start({ loadDivisions: async () => { throw new Error('connect ECONNREFUSED sb_secret_x 482915'); }, log });
    const res = await request(c.port, { path: '/api/divisions?division=salon' });
    expect(res.status).toBe(502);
    expect(res.text).not.toMatch(/ECONNREFUSED|sb_secret|\d{6}/);
    expect(log).toHaveBeenCalledWith('console.load_failed department=divisions reason=error');
  });
});

describe('a head\'s own page: /?division=', () => {
  it('serves a page that holds that division only: no other tabs, and the Fortune Hub said in the footer', async () => {
    const c = await start();
    const res = await request(c.port, { path: '/?division=finance' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.text).toContain('<title>Fortune AI Headquarters · Finance division</title>');
    expect(res.text).toContain('<h1>Finance division</h1>');
    expect(res.text).toContain('A read-only view of this division only.');
    // The markup around the script and the style (the script itself is the owner's page's script, which names every tab).
    const markup = res.text.replace(/<script>[\s\S]*<\/script>/, '').replace(/<style>[\s\S]*<\/style>/, '');
    expect(markup).not.toContain('class="tab"');
    expect(markup).not.toMatch(/Owner HQ|HQ Manager|Online Customer Service|Salon Department|data-id=|<nav/);
    expect(res.text).toMatch(/<footer[^>]*>[\s\S]*Fortune Hub[\s\S]*<\/footer>/);
    expect(res.text).toContain("In production, each head's site is part of the Fortune Hub.");
    expect(c.deps.loadDivisions).not.toHaveBeenCalled();
  });

  it('is the same script and style as the owner\'s page, under the same policy, so nothing new is allowed', async () => {
    const c = await start();
    const head = await request(c.port, { path: '/?division=online' });
    const owner = await request(c.port, { path: '/' });
    expect(head.headers['content-security-policy']).toBe(PAGE_CSP);
    expect(owner.headers['content-security-policy']).toBe(PAGE_CSP);
    expect(owner.text).toBe(PAGE_HTML);
    const part = (html: string, tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(html)?.[1];
    expect(part(head.text, 'script')).toBe(part(PAGE_HTML, 'script'));
    expect(part(head.text, 'style')).toBe(part(PAGE_HTML, 'style'));
    expect(head.text).not.toMatch(/innerHTML|<script src|onclick=/);
  });

  it('names each head\'s own division, in the title and the heading', async () => {
    const c = await start();
    for (const [id, name] of [['finance', 'Finance'], ['online', 'Online'], ['salon', 'Salon']]) {
      const text = (await request(c.port, { path: `/?division=${id}` })).text;
      expect(text, id).toContain(`<title>Fortune AI Headquarters · ${name} division</title>`);
      expect(text, id).toContain(`<h1>${name} division</h1>`);
    }
  });

  it('answers 404 for a division that is not one of the three, and shows the owner\'s page when none is named', async () => {
    const c = await start();
    for (const q of ['division=hq', 'division=Finance', 'division=', 'division=finance&division=salon', 'division=<script>']) {
      const res = await request(c.port, { path: `/?${q}` });
      expect(res.status, q).toBe(404);
      expect(res.text).not.toContain('<script>');
    }
    expect((await request(c.port, { path: '/?other=1' })).text).toBe(PAGE_HTML);
  });
});

describe('the PDF a report link opens', () => {
  it('renders the weekly packet from the stored reports, on request, and nothing is kept', async () => {
    const c = await start();
    const res = await request(c.port, { path: weeklyPath() });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('inline; filename="finance-weekly-2026-10-26.pdf"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-length']).toBe(String(res.bytes.length));
    expect(res.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(c.deps.loadReport).toHaveBeenCalledWith('weekly', weeklyRowId('finance'));

    // The very packet the head gets by email and on paper.
    const ctx = { manager: 'George', head: 'Alan', divisionTitle: 'Finance' };
    const expected = await renderWeeklyPacketPdf(weeklyReport('finance'), WORKERS_OF.finance.map((w) => workerReport(w)), ctx);
    expect(Buffer.compare(res.bytes, Buffer.from(expected))).toBe(0);
    const words = await pdfText(res.bytes);
    expect(words).toContain("George's report to Alan");
    expect(words).toContain('Goal of the week');
  });

  it('renders one worker\'s report', async () => {
    const c = await start();
    const res = await request(c.port, { path: workerPath() });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('inline; filename="finance-meta-2026-10-26.pdf"');
    expect(c.deps.loadReport).toHaveBeenCalledWith('worker', workerRowId('finance.meta', '2026-10-27'));
    const expected = await renderWorkerReportPdf(workerReport('finance.meta'), { manager: 'George', head: 'Alan', divisionTitle: 'Finance' });
    expect(Buffer.compare(res.bytes, Buffer.from(expected))).toBe(0);
  });

  it('draws no phone number, address or code, even if a stored report held one', async () => {
    const dirty = workerReport('finance.meta', { headline: 'Call +15559876543 or mail ezra@example.com about code 482915' });
    const c = await start({ loadReport: async () => ({ kind: 'worker', division: 'finance', worker: dirty }) });
    const words = await pdfText((await request(c.port, { path: workerPath() })).bytes);
    expect(words).toContain('[phone]');
    expect(words).toContain('[email]');
    expect(words).toContain('[code]');
    expect(words).not.toMatch(/5559876543|ezra@example|482915/);
  });

  it('answers HEAD with the headers and no body', async () => {
    const c = await start();
    const res = await request(c.port, { method: 'HEAD', path: weeklyPath() });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.bytes.length).toBe(0);
  });

  it('opens a head\'s own report with ?division=, and refuses another division\'s as if it were not there', async () => {
    const c = await start();
    expect((await request(c.port, { path: `${weeklyPath()}?division=finance` })).status).toBe(200);
    for (const q of ['division=online', 'division=salon', 'division=hq', 'division=finance&division=online']) {
      const res = await request(c.port, { path: `${weeklyPath()}?${q}` });
      expect(res.status, q).toBe(404);
      expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(JSON.parse(res.text)).toEqual({ error: 'Not found.' });
    }
    expect((await request(c.port, { path: `${workerPath()}?division=online` })).status).toBe(404);
  });

  it('answers 404 for an id with no report, an id that is not an id, another kind, or a path that is not exactly a PDF link', async () => {
    const c = await start({ loadReport: vi.fn(async () => null) });
    expect((await request(c.port, { path: weeklyPath() })).status).toBe(404);
    expect(c.deps.loadReport).toHaveBeenCalledTimes(1);
    for (const p of [
      '/report/weekly/not-an-id.pdf', `/report/weekly/${weeklyRowId('finance')}`, `/report/weekly/${weeklyRowId('finance')}.pdf/`, `/report/weekly/${weeklyRowId('finance')}.PDF`,
      `/report/other/${weeklyRowId('finance')}.pdf`, `/report/weekly/..%2F${weeklyRowId('finance')}.pdf`, `/report/weekly/${weeklyRowId('finance')}.pdf%00`, '/report/', '/report',
    ]) {
      const res = await request(c.port, { path: p });
      expect(res.status, p).toBe(404);
    }
    expect(c.deps.loadReport).toHaveBeenCalledTimes(1);
  });

  it('answers 404 where no report source is connected', async () => {
    const c = await start({ loadReport: undefined });
    expect((await request(c.port, { path: weeklyPath() })).status).toBe(404);
  });

  it('answers 502 in plain words, without the cause, when the report cannot be read or made, and logs only a code', async () => {
    const log = vi.fn();
    const failing = await start({ loadReport: async () => { throw new Error('connect ECONNREFUSED with key sb_secret_xyz and code 482915'); }, log });
    let res = await request(failing.port, { path: weeklyPath() });
    expect(res.status).toBe(502);
    expect(JSON.parse(res.text).error).toBe('The report could not be read right now. Try again in a moment.');
    expect(res.text).not.toMatch(/sb_secret|ECONNREFUSED|\d{6}/);
    expect(log).toHaveBeenCalledWith('console.load_failed department=report reason=error');

    const wrongShape = await start({ loadReport: async () => { throw new ReportUnreadable(); }, log });
    res = await request(wrongShape.port, { path: weeklyPath() });
    expect(res.status).toBe(502);
    expect(JSON.parse(res.text).error).toBe('This report is not in the shape the system expects, so it cannot be shown.');
    expect(log).toHaveBeenCalledWith('console.load_failed department=report reason=unreadable');

    const unmade = await start({ loadReport: async () => ({ kind: 'weekly', division: 'finance', weekly: { ...weeklyReport('finance'), sections: undefined } as never, workers: [] }), log });
    res = await request(unmade.port, { path: weeklyPath() });
    expect(res.status).toBe(502);
    expect(JSON.parse(res.text).error).toBe('The report could not be made into a PDF right now.');
    expect(log).toHaveBeenCalledWith('console.load_failed department=report reason=render');
    for (const line of log.mock.calls.flat()) expect(String(line)).not.toMatch(/sb_secret|\d{6}|sections/);
  });

  it('is read only and local only like the rest of the console', async () => {
    const c = await start();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const p of [weeklyPath(), workerPath(), '/?division=finance', '/api/divisions?division=finance']) {
        const res = await request(c.port, { method, path: p });
        expect(res.status, `${method} ${p}`).toBe(405);
        expect(res.headers.allow).toBe('GET, HEAD');
      }
    }
    for (const p of [weeklyPath(), workerPath(), '/?division=finance', '/api/divisions?division=finance']) {
      expect((await request(c.port, { path: p, headers: { Host: 'evil.example.com' } })).status, p).toBe(421);
    }
    expect(c.deps.loadReport).not.toHaveBeenCalled();
    expect(c.deps.loadDivisions).not.toHaveBeenCalled();
    expect(c.server.address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
  });

  it('puts nothing of the stored row into the response headers', async () => {
    const c = await start();
    const res = await request(c.port, { path: weeklyPath() });
    expect(everything(res.headers)).not.toMatch(/b1b1b1b1|c2c2c2c2|sb_|service_role/);
  });
});
