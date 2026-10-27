import http from 'node:http';
import { generateBusiness, type SyntheticBusiness } from './synthetic.ts';

// The three separately owned "systems" Zetaris federates, served as read-only JSON APIs.
// Each response is {"data": [...]} because Zetaris REST tables are proven on wrapped arrays,
// not bare top-level arrays. Bound to 127.0.0.1; Zetaris reaches it via host.docker.internal.

export const SOURCE_ROUTES = {
  '/salon/appointments': (b: SyntheticBusiness) => b.salon.appointments,
  '/online/orders': (b: SyntheticBusiness) => b.online.orders,
  '/marketing/ads': (b: SyntheticBusiness) => b.marketing.ads,
  '/marketing/email': (b: SyntheticBusiness) => b.marketing.email,
} as const;

export function createSourceServer(business: SyntheticBusiness = generateBusiness()): http.Server {
  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, synthetic: true }));
      return;
    }
    const route = SOURCE_ROUTES[path as keyof typeof SOURCE_ROUTES];
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const body = JSON.stringify({ data: route(business) });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}

export const SOURCE_PORT_DEFAULT = 18120;

/**
 * Starts the source server unless one already answers on the port. Under WSL with Docker Desktop,
 * host.docker.internal reaches a WSL port only after WSL's localhost relay notices the new
 * listener (about a second; a REST table created sooner got "Connection refused"), so a fresh
 * start waits `settleMs` before returning.
 */
type Ensured = { started: boolean; close: () => Promise<void> };
const notStarted: Ensured = { started: false, close: async () => {} };

// Callers in one process share one start: three departments reading metrics at the same moment used to
// race, and the second listen failed with EADDRINUSE.
const starting = new Map<number, Promise<Ensured>>();

export function ensureSourceServer(port = SOURCE_PORT_DEFAULT, settleMs = 3000): Promise<Ensured> {
  const pending = starting.get(port);
  if (pending) return pending.then(() => notStarted);
  const run = start(port, settleMs).finally(() => starting.delete(port));
  starting.set(port, run);
  return run;
}

const answers = (port: number) =>
  fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.ok)
    .catch(() => false);

async function start(port: number, settleMs: number): Promise<Ensured> {
  if (await answers(port)) return notStarted;
  const server = createSourceServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
  } catch (error) {
    // Another process started one between the check and the listen: use it when it answers.
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE' && (await answers(port))) return notStarted;
    throw error;
  }
  // It serves while the process has other work, and never keeps a finished script alive on its own.
  server.unref();
  if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
  return { started: true, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
