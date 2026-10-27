import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Metric, type Period } from '@fahq/contracts';
import { createZetarisDataPort } from '../src/index.ts';
import {
  CATALOG_V2, CATALOG_V2_BY_ID, DIVISIONS, MARTS_V2, attentionFor, divisionHashText, divisionIds, divisionQueries, divisionSlice, layerHashText,
  layerQueries, type Layer,
} from '../src/divisions.ts';
import {
  FINANCE_VIEW, FINANCE_VIEW_COLUMNS, MART, MART_TABLE, MART_VIEW, METRICS, METRIC_BY_ID, VERSIONS, computeAll, financeQuery, financeViewBody, martQuery,
  martSql,
} from '../src/finance-sql.ts';
import { computeLayers } from '../src/layers.ts';
import { createSourceServer } from '../src/source-server.ts';
import { generateBusiness, generateYear } from '../src/synthetic.ts';
import { createZetarisClient, zetarisConfigFromEnv } from '../src/zetaris-client.ts';

const KEY = 'test-api-key-never-logged';
const env = { ZETARIS_ORG_ID: '7', ZETARIS_API_KEY: KEY, ZETARIS_REST_URL: 'http://zetaris.test/api/v1.0/' } as NodeJS.ProcessEnv;

// Version 2's answers, as Zetaris would give them: a layer view's rows, or a division mart table's (its own
// ids only), for the period the statement asks.
const layers = computeLayers(generateYear());
function fromOracle(sql: string): string[][] {
  const [, table, period] = /FROM (\S+) WHERE period = '([^']+)'$/.exec(sql)!;
  const layer = /(period|derived|standing)_metrics$/.exec(table!)![1] as Layer;
  const values = layer === 'standing' ? layers.standing : layers[layer].get(period as Period)!;
  const division = /^fortune_demo_v2_([a-z]+)_mart\./.exec(table!)?.[1] as (typeof DIVISIONS)[number] | undefined;
  const ids = division ? divisionIds(division, layer) : [...values.keys()];
  return ids.filter((id) => values.has(id)).map((id) => [id, String(values.get(id))]);
}

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

  it("serves version 2 under /v2 and leaves version 1's routes as they were", async () => {
    const year = generateYear();
    const get = async (path: string) => ((await (await fetch(`${base}${path}`)).json()) as { data: unknown[] }).data;
    expect(await get('/v2/online/orders')).toHaveLength(year.online.orders.length);
    expect(await get('/v2/marketing/ads')).toHaveLength(year.marketing.ads.length);
    expect(await get('/v2/finance/budgets')).toEqual(year.finance.budgets);
    expect(JSON.stringify(await get('/marketing/ads'))).toBe(JSON.stringify(generateBusiness().marketing.ads));
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
    expect(VERSIONS[1].metrics).toHaveLength(33);
    for (const m of VERSIONS[1].metrics) expect(sql.split(`'${m.id}'`).length - 1).toBe(1);
    for (const m of METRICS.filter((d) => d.since === 2)) expect(sql).not.toContain(`'${m.id}'`);
    expect(sql).not.toContain(';');
    expect(sql).toContain("product_line IN ('fortune', 'mazali', 'tuni', 'accessories')");
    expect(sql).toContain('price_usd >= 0');
    // Each source view is scanned once (Spark rejects a self-union of an exploded view).
    for (const v of ['online_orders', 'salon_appointments', 'marketing_ads', 'marketing_email']) {
      expect(sql.split(`fortune_hq.${v} `).length - 1).toBe(1);
    }
    expect(() => financeQuery('2026-13' as never)).toThrow('unknown period');
    expect(() => financeQuery('2026-08')).toThrow('unknown period'); // version 1 serves two periods
  });

  it('version 2 lives in its own container: thirteen periods, twelve sources, every metric once', () => {
    const v2 = financeViewBody(2);
    expect(v2).not.toContain('fortune_hq.');
    for (const m of METRICS) expect(v2.split(`'${m.id}'`).length - 1).toBe(1);
    expect(VERSIONS[2].sources).toHaveLength(12);
    for (const v of ['online_orders', 'salon_appointments', 'marketing_ads', 'marketing_email', 'finance_budgets', 'support_messages', 'salon_repairs', 'finance_invoices']) {
      expect(v2.split(`fortune_hq_v2.${v} `).length - 1).toBe(1);
    }
    expect(v2).toContain("month_start BETWEEN '2025-10-01' AND '2026-10-26'");
    expect(v2).toContain("WHEN order_date BETWEEN '2026-02-01' AND '2026-02-28' THEN '2026-02'");
    expect(v2).toContain("channel = 'google' AND status = 'approved'");
    expect(v2).not.toContain(';');
    expect(financeQuery('2025-10', 2)).toBe("SELECT metric_id, value FROM fortune_hq_v2.period_metrics WHERE period = '2025-10'");
  });

  it('keeps the planted bad rows out of revenue and counts them as rejected', () => {
    const b = generateBusiness();
    const sept = computeAll(b, 1).get('2026-09')!;
    const oct = computeAll(b, 1).get('2026-10-mtd')!;
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

describe('Virtual Data Mart', () => {
  it('is named under fortune_demo and has one table over the governed view, without copying data', () => {
    expect(MART).toBe('fortune_demo_finance_mart');
    expect(MART_VIEW).toBe('fortune_demo_finance_mart.finance_metrics');
    const sql = martSql();
    expect(sql.create).toBe("CREATE DATAMART fortune_demo_finance_mart DESCRIBE BY 'Fortune demo finance mart, synthetic'");
    expect(sql.addTable).toBe(
      'ADD DATAMART TABLE finance_metrics INTO fortune_demo_finance_mart FROM fortune_hq.finance_metrics VSCHEMA (period period, metric_id metric_id, value value)',
    );
    expect(sql.drop).toBe('DROP DATAMART fortune_demo_finance_mart');
    expect(sql.addTable).toContain(`FROM ${FINANCE_VIEW} `);
    expect(sql.addTable).toContain(`TABLE ${MART_TABLE} INTO ${MART}`);
  });

  it('maps every column of the view, and each statement is one statement for the Zetaris client', () => {
    expect([...FINANCE_VIEW_COLUMNS]).toEqual(['period', 'metric_id', 'value']);
    for (const column of FINANCE_VIEW_COLUMNS) expect(martSql().addTable).toContain(`${column} ${column}`);
    for (const statement of Object.values(martSql())) {
      expect(statement).not.toContain(';');
      expect(statement.trim()).toBe(statement);
    }
  });

  it('asks the mart table the same question as the view, with a flat two-part name', () => {
    expect(martQuery('2026-09')).toBe("SELECT metric_id, value FROM fortune_demo_finance_mart.finance_metrics WHERE period = '2026-09'");
    expect(martQuery('2026-09').replace(MART_VIEW, FINANCE_VIEW)).toBe(financeQuery('2026-09'));
    expect(() => martQuery('2026-13' as never)).toThrow('unknown period');
  });

  it('is read through the same Zetaris client as the view: one statement, rows as strings', async () => {
    const oracle = computeAll(generateBusiness(), 1).get('2026-09')!;
    const z = fakeZetaris((sql) => {
      expect(sql).toBe(martQuery('2026-09'));
      return { body: { data: [...oracle].map(([id, v]) => [id, v]) } };
    });
    const rows = await createZetarisClient({ ...zetarisConfigFromEnv(env), fetch: z.fetchFn }).run(martQuery('2026-09'), 500);
    expect(rows).toHaveLength(oracle.size);
  });
});

describe('Zetaris DataPort', () => {
  const b = generateBusiness();
  const oracle = computeAll(b, 1).get('2026-09')!;
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
    // The catalog a read tool lists is exactly what the view returns, with the same labels.
    expect(port.catalog!.map((c) => c.id).sort()).toEqual(r.metrics.map((m) => m.id).sort());
    for (const m of r.metrics) {
      const { divisions, nouns, about } = METRIC_BY_ID.get(m.id)!;
      expect(port.catalog!.find((c) => c.id === m.id)).toEqual({
        id: m.id, label: m.label, unit: m.unit, business: m.business, divisions, layer: 'period', ...(nouns ? { nouns } : {}), ...(about ? { about } : {}),
      });
    }
    // A count carries the words that name what it counts, for the plan checker.
    expect(port.catalog!.find((c) => c.id === 'm:salon.no_shows.count')!.nouns).toEqual(['no-show', 'no-shows']);
    expect(port.periods).toEqual(['2026-09', '2026-10-mtd']);
    // Version 1's hash is computed exactly as at bb29578: its view body, then the query.
    expect(r.queryHash).toBe(createHash('sha256').update(`${financeViewBody(1)}\n--\n${financeQuery('2026-09')}`).digest('hex'));
    expect(port.getDivisionMetrics).toBeUndefined();
  });

  it('reads version 2 only when FAHQ_DATA_VERSION=2: all three layer views, unsliced, for any of its thirteen periods', async () => {
    const asked: string[] = [];
    const z = fakeZetaris((sql) => { asked.push(sql); return { body: { data: fromOracle(sql) } }; });
    const port = createZetarisDataPort({ ...env, FAHQ_DATA_VERSION: '2' }, { fetch: z.fetchFn, ensureSources: noSources });
    expect(port.periods).toHaveLength(13);
    expect(port.catalog!.map((c) => c.id)).toEqual(CATALOG_V2.map((m) => m.id));
    expect(port.catalog!.find((c) => c.id === 'm:online.budget.meta.room')!.layer).toBe('derived');
    const r = await port.getFinanceMetrics({ asOf: '2026-10-26T12:00:00.000Z', period: '2025-12' });
    expect(asked.sort()).toEqual(layerQueries('2025-12').map((q) => q.sql).sort());
    expect(r.view).toBe('fortune_hq_v2.period_metrics');
    expect(r.queryHash).toBe(createHash('sha256').update(layerHashText(layerQueries('2025-12'))).digest('hex'));
    const want = new Map([...layers.period.get('2025-12')!, ...layers.derived.get('2025-12')!, ...layers.standing]);
    expect(new Map(r.metrics.map((m) => [m.id, m.value]))).toEqual(want);
    expect(r.metrics.find((m) => m.id === 'm:online.budget.google.room')!.source.view).toBe('fortune_hq_v2.derived_metrics');
    expect(r.metrics.find((m) => m.id === 'm:online.budget.proposed.count')!.period).toBe('standing');
    expect(r.metrics.every((m) => m.source.queryHash === r.queryHash)).toBe(true);
    const v1 = await createZetarisDataPort(env, { fetch: z.fetchFn, ensureSources: noSources }).getFinanceMetrics({ asOf: '2026-10-26T12:00:00.000Z', period: '2025-12' }).catch((e: Error) => e.message);
    expect(v1).toBe('unknown period "2025-12"');
    expect(() => createZetarisDataPort({ ...env, FAHQ_DATA_VERSION: '3' })).toThrow('FAHQ_DATA_VERSION must be 1 or 2');
  });

  it('refuses under version 1 a metric only version 2 serves', async () => {
    const z = fakeZetaris(() => ({ body: { data: [...rows, ['m:online.ads.meta.spend', '10']] } }));
    const port = createZetarisDataPort(env, { fetch: z.fetchFn, ensureSources: noSources });
    await expect(port.getFinanceMetrics({ asOf: '2026-10-26T12:00:00.000Z', period: '2026-09' })).rejects.toThrow('does not know');
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

describe('division reads (version 2)', () => {
  const v2 = { ...env, FAHQ_DATA_VERSION: '2' } as NodeJS.ProcessEnv;
  const asOf = '2026-10-27T12:00:00.000Z';
  const noSources = async () => {};
  const portWith = (respond: (sql: string) => string[][]) => {
    const asked: string[] = [];
    const port = createZetarisDataPort(v2, { fetch: fakeZetaris((sql) => { asked.push(sql); return { body: { data: respond(sql) } }; }).fetchFn, ensureSources: noSources });
    return { port, asked };
  };

  it("reads each division from its own mart: three statements, its own ids only, standing numbers as of the data date", async () => {
    const hashes = new Set<string>();
    for (const division of DIVISIONS) {
      const { port, asked } = portWith(fromOracle);
      const r = await port.getDivisionMetrics!({ division, period: '2026-10-mtd', asOf });
      expect(asked.sort()).toEqual(divisionQueries(division, '2026-10-mtd').map((q) => q.sql).sort());
      expect(r.division).toBe(division);
      expect(r.view).toBe(MARTS_V2[division]);
      expect(new Map(r.metrics.map((m) => [m.id, m.value]))).toEqual(divisionSlice(layers, division, '2026-10-mtd'));
      expect(r.queryHash).toBe(createHash('sha256').update(divisionHashText(division, divisionQueries(division, '2026-10-mtd'))).digest('hex'));
      for (const m of r.metrics) {
        expect(() => Metric.parse(m)).not.toThrow();
        const layer = CATALOG_V2_BY_ID.get(m.id)!.layer;
        expect(m.source.view).toBe(`${MARTS_V2[division]}.${layer}_metrics`);
        expect(m.period).toBe(layer === 'standing' ? 'standing' : '2026-10-mtd');
        expect(m.source.queryHash).toBe(r.queryHash);
      }
      expect(r.attention).toEqual(attentionFor(r.metrics));
      hashes.add(r.queryHash);
      // The same question later has the same provenance.
      expect((await port.getDivisionMetrics!({ division, period: '2026-10-mtd', asOf: '2026-10-28T09:00:00.000Z' })).queryHash).toBe(r.queryHash);
    }
    expect(hashes.size).toBe(4);
  });

  it("reports the attention rules that fired, each on the division's own numbers: the waiting budget change for Finance, the late repairs for the Salon", async () => {
    const finance = await portWith(fromOracle).port.getDivisionMetrics!({ division: 'finance', period: '2026-10-mtd', asOf });
    expect(finance.attention).toContainEqual({ metricId: 'm:online.budget.proposed.count', level: 'act', rule: "A proposed ad budget change is waiting for the finance owner's decision." });
    const salon = await portWith(fromOracle).port.getDivisionMetrics!({ division: 'salon', period: '2026-10-mtd', asOf });
    expect(salon.attention).toEqual([{ metricId: 'm:salon.repairs.open_over_14d.count', level: 'act', rule: 'Repairs have been open longer than two weeks.' }]);
    for (const a of [...finance.attention, ...salon.attention]) expect(finance.metrics.concat(salon.metrics).some((m) => m.id === a.metricId)).toBe(true);
  });

  it('refuses a metric outside the division, a metric twice, an unknown division or period, and no rows at all', async () => {
    const leak = portWith((sql) => (sql.includes('salon_mart.period_metrics') ? [...fromOracle(sql), ['m:online.revenue.total', '1']] : fromOracle(sql)));
    await expect(leak.port.getDivisionMetrics!({ division: 'salon', period: '2026-09', asOf })).rejects.toThrow('does not know');
    const twice = portWith((sql) => (sql.includes('salon_mart.period_metrics') ? [...fromOracle(sql), ['m:salon.revenue.total', '1']] : fromOracle(sql)));
    await expect(twice.port.getDivisionMetrics!({ division: 'salon', period: '2026-09', asOf })).rejects.toThrow('twice');
    const { port, asked } = portWith(fromOracle);
    await expect(port.getDivisionMetrics!({ division: 'marketing' as never, period: '2026-09', asOf })).rejects.toThrow('unknown division "marketing"');
    await expect(port.getDivisionMetrics!({ division: 'salon', period: '2026-13', asOf })).rejects.toThrow('unknown period "2026-13"');
    expect(asked).toEqual([]);
    await expect(portWith(() => []).port.getDivisionMetrics!({ division: 'hq', period: '2026-09', asOf })).rejects.toThrow('no hq metrics');
  });
});
