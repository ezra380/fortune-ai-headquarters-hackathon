// The Admin console: the owner's read-only view of every assistant department.
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
import { DEPARTMENTS } from './departments.ts';
import type { LiveDepartmentId, RawDepartment } from './departments.ts';
import { createCloudLoader } from './loader.ts';
import { PAGE_CSP, PAGE_HTML } from './page.ts';
import { placeholderView, shapeDepartment } from './shape.ts';

export type ConsoleDeps = {
  /** Reads one department's data. Called only for owner, finance and online; never for salon. */
  load: (department: LiveDepartmentId) => Promise<RawDepartment>;
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

function send(req: http.IncomingMessage, res: http.ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}) {
  const bytes = Buffer.from(body, 'utf8');
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': String(bytes.length), ...extra });
  res.end(req.method === 'HEAD' ? undefined : bytes);
}

const json = (req: http.IncomingMessage, res: http.ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}) =>
  send(req, res, status, 'application/json; charset=utf-8', JSON.stringify(value), extra);

const hostName = (header: string | undefined): string => {
  const host = (header ?? '').trim().toLowerCase();
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0] ?? '';
};

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

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!LOOPBACK_HOSTS.has(hostName(req.headers.host))) {
      return json(req, res, 421, { error: 'This console only answers on this computer (127.0.0.1).' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(req, res, 405, { error: 'This console is read-only. Only GET and HEAD are allowed.' }, { Allow: 'GET, HEAD' });
    }

    const { pathname } = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (pathname === '/') {
      return send(req, res, 200, 'text/html; charset=utf-8', PAGE_HTML, { 'Content-Security-Policy': PAGE_CSP });
    }
    if (pathname === '/health') {
      return json(req, res, 200, { ok: true, time: deps.now().toISOString() });
    }
    if (pathname === '/api/departments') {
      return json(req, res, 200, { departments: DEPARTMENTS.map((d) => ({ id: d.id, name: d.name, placeholder: d.placeholder })) });
    }

    const match = /^\/api\/department\/([a-z]{1,20})$/.exec(pathname);
    const info = match ? DEPARTMENTS.find((d) => d.id === match[1]) : undefined;
    if (!info) return json(req, res, 404, { error: 'Not found.' });

    // The salon tab is a placeholder: Cindy runs in her own app, so nothing is read for it.
    if (info.placeholder || info.id === 'salon') return json(req, res, 200, placeholderView(info));

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

  const running = await startConsoleServer({ load, now }, port);
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
