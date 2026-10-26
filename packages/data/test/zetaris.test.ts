import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Metric } from '@fahq/contracts';
import { createZetarisDataPort } from '../src/index.ts';
import { METRICS, computeFinanceMetricsLocally, financeQuery, financeViewBody } from '../src/finance-sql.ts';
import { createSourceServer } from '../src/source-server.ts';
import { generateBusiness } from '../src/synthetic.ts';
import { createZetarisClient, zetarisConfigFromEnv } from '../src/zetaris-client.ts';

const KEY = 'test-api-key-never-logged';
const env = { ZETARIS_ORG_ID: '7', ZETARIS_API_KEY: KEY, ZETARIS_REST_URL: 'http://zetaris.test/api/v1.0/' } as NodeJS.ProcessEnv;

type Call = { url: string; init: RequestInit };
function fakeZetaris(respond: (sql: string) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const sql = JSON.parse(String(init?.body)).sql as string;
    const r = respond(sql);
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe('source server', () => {
  const server = createSourceServer();
  let base = '';
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('serves each source wrapped as {"data": [...]}, read-only', async () => {
    const b = generateBusiness();
    const orders = (await (await fetch(`${base}/online/orders`)).json()) as { data: unknown[] };
    expect(orders.data).toHaveLength(b.online.orders.length);
    const appts = (await (await fetch(`${base}/salon/appointments`)).json()) as { data: unknown[] };
    expect(appts.data).toHaveLength(b.salon.appointments.length);
    expect((await fetch(`${base}/online/orders`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/customers`)).status).toBe(404);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});

describe('Zetaris client', () => {
  it('posts one statement to the documented SQL route with org and request headers', async () => {
    const z = fakeZetaris(() => ({ body: { data: [['a', 1, null]] } }));
    const client = createZetarisClient({ ...zetarisConfigFromEnv(env), fetch: z.fetchFn });
    expect(await client.run('SELECT 1;', 5)).toEqual([['a', '1', '']]);
    const call = z.calls[0]!;
    expect(call.url).toBe('http://zetaris.test/api/v1.0/sql-editor/sqls/run');
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers['X-Org-ID']).toBe('7');
    expect(headers['X-Request-ID']).toMatch(/^[0-9a-f-]{36}$/);
    const body = JSON.parse(String(call.init.body));
    expect(body).toMatchObject({ sql: 'SELECT 1', source: 'SqlEditor', limit: 5 });
    expect(body.queryId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses two statements and keeps the key out of errors', async () => {
    const z = fakeZetaris(() => ({ status: 400, body: { msg: 'Table not found' } }));
    const client = createZetarisClient({ ...zetarisConfigFromEnv(env), fetch: z.fetchFn });
    await expect(client.run('SELECT 1; DROP VIEW x')).rejects.toThrow('one statement per call');
    expect(z.calls).toHaveLength(0);
    const err = await client.run('SELECT nope').then(() => null, (e: Error) => e);
    expect(err?.message).toContain('HTTP 400');
    expect(err?.message).toContain('Table not found');
    expect(err?.message).not.toContain(KEY);
  });

  it('requires a numeric org id', () => {
    expect(() => zetarisConfigFromEnv({ ...env, ZETARIS_ORG_ID: 'abc' })).toThrow('numeric');
  });
});

describe('finance view', () => {
  const sql = financeViewBody();

  it('defines every metric once, with the data-quality rule and no statement breaks', () => {
    for (const m of METRICS) expect(sql.split(`'${m.id}'`).length - 1).toBe(1);
    expect(sql).not.toContain(';');
    expect(sql).toContain("product_line IN ('fortune', 'mazali', 'tuni', 'accessories')");
    expect(sql).toContain('price_usd >= 0');
    // Each source view is scanned once (Spark rejects a self-union of an exploded view).
    for (const v of ['online_orders', 'salon_appointments', 'marketing_ads', 'marketing_email']) {
      expect(sql.split(`fortune_hq.${v} `).length - 1).toBe(1);
    }
    expect(() => financeQuery('2026-13' as never)).toThrow('unknown period');
  });

  it('keeps the planted bad rows out of revenue and counts them as rejected', () => {
    const b = generateBusiness();
    const sept = computeFinanceMetricsLocally(b, '2026-09');
    const oct = computeFinanceMetricsLocally(b, '2026-10-mtd');
    expect(sept.get('m:online.dq.rejected_orders')).toBe(1); // demo-o-bad-negative, Sept 14
    expect(oct.get('m:online.dq.rejected_orders')).toBe(1); // demo-o-bad-line, Oct 3
    expect(sept.get('m:salon.dq.rejected_appointments')).toBe(1); // demo-a-bad-price, Sept 22
    expect(oct.get('m:salon.dq.rejected_appointments')).toBe(0);
    const goodSept = b.online.orders.filter((o) => o.order_date <= '2026-09-30' && !o.order_id.includes('bad'));
    const expected = Math.round(goodSept.reduce((t, o) => t + o.net_usd, 0) * 100) / 100;
    expect(sept.get('m:online.revenue.total')).toBeCloseTo(expected, 2);
    const lines = ['fortune', 'mazali', 'tuni', 'accessories'].map((l) => sept.get(`m:online.revenue.${l}`) ?? 0);
    expect(lines.reduce((a, c) => a + c, 0)).toBeCloseTo(expected, 1);
  });
});

describe('Zetaris DataPort', () => {
  const b = generateBusiness();
  const oracle = computeFinanceMetricsLocally(b, '2026-09');
  const rows = [...oracle].map(([id, v]) => [id, String(v)]);
  const noSources = async () => {};

  it('returns validated metrics with one query hash, from the governed view', async () => {
    const z = fakeZetaris((sql) => {
      expect(sql).toBe("SELECT metric_id, value FROM fortune_hq.finance_metrics WHERE period = '2026-09'");
      return { body: { data: rows } };
    });
    const port = createZetarisDataPort(env, { fetch: z.fetchFn, ensureSources: noSources });
    const r = await port.getFinanceMetrics({ asOf: '2026-10-26T12:00:00.000Z', period: '2026-09' });
    expect(r.view).toBe('fortune_hq.finance_metrics');
    expect(r.queryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.metrics).toHaveLength(oracle.size);
    for (const m of r.metrics) {
      expect(() => Metric.parse(m)).not.toThrow();
      expect(m.id.startsWith(`m:${m.business}.`)).toBe(true);
      expect(m.source.queryHash).toBe(r.queryHash);
      expect(m.value).toBe(oracle.get(m.id));
    }
    const again = await port.getFinanceMetrics({ asOf: '2026-10-27T12:00:00.000Z', period: '2026-09' });
    expect(again.queryHash).toBe(r.queryHash);
  });

  it('fails loudly on unknown metrics, bad values, no rows and unknown periods', async () => {
    const port = (data: unknown[]) =>
      createZetarisDataPort(env, { fetch: fakeZetaris(() => ({ body: { data } })).fetchFn, ensureSources: noSources });
    const ask = { asOf: '2026-10-26T12:00:00.000Z', period: '2026-09' };
    await expect(port([['m:online.made_up', '1']]).getFinanceMetrics(ask)).rejects.toThrow('does not know');
    await expect(port([['m:online.revenue.total', 'abc']]).getFinanceMetrics(ask)).rejects.toThrow('non-numeric');
    await expect(port([]).getFinanceMetrics(ask)).rejects.toThrow('no finance metrics');
    await expect(port(rows).getFinanceMetrics({ ...ask, period: '2025-01' })).rejects.toThrow('unknown period');
  });

  it('reports health without throwing', async () => {
    const down = createZetarisDataPort(env, {
      fetch: (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch,
      ensureSources: noSources,
    });
    const h = await down.health();
    expect(h.ok).toBe(false);
    expect(h.detail).not.toContain(KEY);
  });
});
