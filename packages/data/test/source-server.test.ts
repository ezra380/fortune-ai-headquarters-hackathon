import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureSourceServer } from '../src/source-server.ts';

// Each test takes its own free port; nothing here touches the real source port (18120).
async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

describe('ensureSourceServer', () => {
  it('starts one server for callers that arrive at the same moment (no EADDRINUSE)', async () => {
    const port = await freePort();
    const results = await Promise.all([1, 2, 3].map(() => ensureSourceServer(port, 0)));
    results.forEach((r) => closers.push(r.close));
    expect(results.filter((r) => r.started)).toHaveLength(1);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.ok).toBe(true);
  });

  it('uses a server that already answers instead of starting another', async () => {
    const port = await freePort();
    const first = await ensureSourceServer(port, 0);
    closers.push(first.close);
    const again = await ensureSourceServer(port, 0);
    expect(first.started).toBe(true);
    expect(again.started).toBe(false);
  });

  it('still refuses a port held by something that is not a source server', async () => {
    const port = await freePort();
    const other = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
    await new Promise<void>((resolve) => other.listen(port, '127.0.0.1', () => resolve()));
    closers.push(() => new Promise((resolve) => other.close(() => resolve())));
    await expect(ensureSourceServer(port, 0)).rejects.toThrow(/EADDRINUSE/);
  });
});
