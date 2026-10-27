// The Admin console: the owner's read-only view of every assistant department and of the company's divisions.
// Usage: npm run console   (http://127.0.0.1:5180, or CONSOLE_PORT)
//
// Read-only on purpose: GET and HEAD only, no form, no write call to any database. Local only: it
// listens on 127.0.0.1 and refuses any request whose Host header is not a loopback name (so a web
// page on another site cannot read it through DNS rebinding). The service key stays on this server.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { MANAGERS } from '@fahq/contracts';
import { renderWeeklyPacketPdf, renderWorkerReportPdf } from '@fahq/delivery';
import { DEPARTMENTS } from './departments.ts';
import type { DepartmentId, RawDepartment } from './departments.ts';
import type { BriefDivision, RawDivisions } from './divisions.ts';
import { isBriefDivision } from './divisions.ts';
import { createCloudLoader, createDivisionsLoader, createReportLoader, ReportUnreadable } from './loader.ts';
import type { LoadedReport } from './loader.ts';
import { headPageHtml, PAGE_CSP, PAGE_HTML } from './page.ts';
import { shapeDepartment, shapeDivisions } from './shape.ts';

export type ConsoleDeps = {
  /** Reads one department's data. */
  load: (department: DepartmentId) => Promise<RawDepartment>;
  /** Reads the Divisions view: the latest briefs, the reports, the data requests and the CEO digest. Given a division, it reads that one only (a head's own view). */
  loadDivisions: (only?: BriefDivision) => Promise<RawDivisions>;
  /** Reads the stored reports a PDF is made from. Without it, the PDF links answer 404. */
  loadReport?: (kind: 'weekly' | 'worker', id: string) => Promise<LoadedReport | null>;
  now: () => Date;
  /** Where plain one-line problems go. Defaults to stderr. Never receives data or secrets. */
  log?: (line: string) => void;
};

const LOAD_TIMEOUT_MS = 20_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
} as const;

function send(req: http.IncomingMessage, res: http.ServerResponse, status: number, type: string, body: string | Uint8Array, extra: Record<string, string> = {}) {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': String(bytes.length), ...extra });
  res.end(req.method === 'HEAD' ? undefined : bytes);
}

const json = (req: http.IncomingMessage, res: http.ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}) =>
  send(req, res, status, 'application/json; charset=utf-8', JSON.stringify(value), extra);

const hostName = (header: string | undefined): string => {
  const host = (header ?? '').trim().toLowerCase();
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0] ?? '';
};


/** The division a head's own view is for: undefined when none is named, null when what was named is not one of the three (or is named twice). */
function divisionParam(url: URL): BriefDivision | undefined | null {
  const named = url.searchParams.getAll('division');
  if (named.length === 0) return undefined;
  const [one] = named;
  return named.length === 1 && isBriefDivision(one) ? one : null;
}

/** Exactly a report's PDF link: a well-formed id and nothing else. */
const REPORT_PATH = /^\/report\/(weekly|worker)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.pdf$/;

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createConsoleServer(deps: ConsoleDeps): http.Server {
  const log = deps.log ?? ((line: string) => console.error(line));

  /**
   * A report as a PDF, made on request from the stored report and sent without being kept. The same pages the head gets by email
   * and on paper. A head's own link (?division=) opens a report of that division only; another division's is "not found".
   */
  async function reportPdf(req: http.IncomingMessage, res: http.ServerResponse, kind: 'weekly' | 'worker', id: string, only: BriefDivision | undefined): Promise<void> {
    let doc: LoadedReport | null;
    try {
      doc = await withTimeout(deps.loadReport!(kind, id), LOAD_TIMEOUT_MS);
    } catch (error) {
      const reason = error instanceof ReportUnreadable ? 'unreadable' : error instanceof Error && error.message === 'timed out' ? 'timeout' : 'error';
      log(`console.load_failed department=report reason=${reason}`);
      return json(req, res, 502, {
        error: reason === 'unreadable' ? 'This report is not in the shape the system expects, so it cannot be shown.' : 'The report could not be read right now. Try again in a moment.',
      });
    }
    if (!doc || (only !== undefined && doc.division !== only)) return json(req, res, 404, { error: 'Not found.' });

    const manager = MANAGERS[doc.division];
    const ctx = { manager: manager.manager, head: manager.head, divisionTitle: manager.title };
    let pdf: Uint8Array;
    try {
      pdf = doc.kind === 'weekly' ? await renderWeeklyPacketPdf(doc.weekly, doc.workers, ctx) : await renderWorkerReportPdf(doc.worker, ctx);
    } catch {
      log('console.load_failed department=report reason=render');
      return json(req, res, 502, { error: 'The report could not be made into a PDF right now.' });
    }
    // Both parts of the name are checked values (a division, a worker id, a date), so the name is always plain.
    const name = doc.kind === 'weekly' ? `${doc.division}-weekly-${doc.weekly.weekOf}.pdf` : `${doc.worker.workerId.replace('.', '-')}-${doc.worker.day}.pdf`;
    return send(req, res, 200, 'application/pdf', pdf, { 'Content-Disposition': `inline; filename="${name}"`, 'Content-Security-Policy': "default-src 'none'" });
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!LOOPBACK_HOSTS.has(hostName(req.headers.host))) {
      return json(req, res, 421, { error: 'This console only answers on this computer (127.0.0.1).' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(req, res, 405, { error: 'This console is read-only. Only GET and HEAD are allowed.' }, { Allow: 'GET, HEAD' });
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const { pathname } = url;
    // ?division=<finance|online|salon> is a head's own view: that division only. Anything else named there is not found.
    const only = divisionParam(url);

    if (pathname === '/') {
      if (only === null) return json(req, res, 404, { error: 'Not found.' });
      return send(req, res, 200, 'text/html; charset=utf-8', only ? headPageHtml(only) : PAGE_HTML, { 'Content-Security-Policy': PAGE_CSP });
    }
    if (pathname === '/health') {
      return json(req, res, 200, { ok: true, time: deps.now().toISOString() });
    }
    if (pathname === '/api/departments') {
      return json(req, res, 200, { departments: DEPARTMENTS.map((d) => ({ id: d.id, name: d.name })) });
    }
    if (pathname === '/api/divisions') {
      if (only === null) return json(req, res, 404, { error: 'Not found.' });
      let raw: RawDivisions;
      try {
        raw = await withTimeout(deps.loadDivisions(only), LOAD_TIMEOUT_MS);
      } catch (error) {
        log(`console.load_failed department=divisions reason=${error instanceof Error && error.message === 'timed out' ? 'timeout' : 'error'}`);
        return json(req, res, 502, { error: 'The divisions could not be read right now. Try again in a moment.' });
      }
      return json(req, res, 200, shapeDivisions(raw, deps.now(), only));
    }

    const report = REPORT_PATH.exec(pathname);
    if (report) {
      if (only === null || !deps.loadReport) return json(req, res, 404, { error: 'Not found.' });
      return reportPdf(req, res, report[1] as 'weekly' | 'worker', report[2] as string, only);
    }

    const match = /^\/api\/department\/([a-z]{1,20})$/.exec(pathname);
    const info = match ? DEPARTMENTS.find((d) => d.id === match[1]) : undefined;
    if (!info) return json(req, res, 404, { error: 'Not found.' });

    let raw: RawDepartment;
    try {
      raw = await withTimeout(deps.load(info.id), LOAD_TIMEOUT_MS);
    } catch (error) {
      log(`console.load_failed department=${info.id} reason=${error instanceof Error && error.message === 'timed out' ? 'timeout' : 'error'}`);
      return json(req, res, 502, { error: `The ${info.name} could not be read right now. Try again in a moment.` });
    }
    return json(req, res, 200, shapeDepartment(raw, info, deps.now()));
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      log(`console.request_failed reason=${error instanceof Error ? error.name : 'error'}`);
      if (!res.headersSent) json(req, res, 500, { error: 'Something went wrong in the console.' });
      else res.end();
    });
  });
}

export type RunningConsole = { server: http.Server; port: number; url: string; close: () => Promise<void> };

/** Starts the console on 127.0.0.1 (port 0 picks a free port). */
export async function startConsoleServer(deps: ConsoleDeps, port = 5180): Promise<RunningConsole> {
  const server = createConsoleServer(deps);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const actual = (server.address() as AddressInfo).port;
  return {
    server,
    port: actual,
    url: `http://127.0.0.1:${actual}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ---- Run as a program: npm run console -------------------------------------------------------

async function main(): Promise<void> {
  const root = path.resolve(import.meta.dirname, '../../..');
  const envFile = path.join(root, '.env.local');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const env = process.env;

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('console: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local (npm run db:status shows the local values).');
    process.exit(1);
  }
  const port = Number(env.CONSOLE_PORT ?? 5180);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('console: CONSOLE_PORT must be a whole number between 1 and 65535.');
    process.exit(1);
  }

  const now = () => new Date();
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const load = createCloudLoader({
    db,
    now,
    brain: {
      dataDir: path.join(root, '.local/brain'),
      meterlessDir: path.resolve(root, env.METERLESS_DIR ?? '.local/meterless'),
      tmpRoot: os.tmpdir(),
    },
  });

  const loadDivisions = createDivisionsLoader({ db, now });
  const loadReport = createReportLoader({ db });

  const running = await startConsoleServer({ load, loadDivisions, loadReport, now }, port);
  console.error(`console: read-only Admin console at ${running.url}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void running.close().then(() => process.exit(0));
    });
  }
}

/** True only when this file is the program being run (not when a test or another module imports it). */
function runAsProgram(): boolean {
  try {
    const entry = process.argv[1];
    return Boolean(entry) && import.meta.url === pathToFileURL(fs.realpathSync(entry as string)).href;
  } catch {
    return false;
  }
}

if (runAsProgram()) {
  main().catch((error: unknown) => {
    console.error(`console: could not start (${error instanceof Error ? error.message : 'unknown'})`);
    process.exit(1);
  });
}
