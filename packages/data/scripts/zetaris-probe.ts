// Slice 0 of the division data: a live test of the SQL shapes version 2 needs, before building on them.
// Usage: npx tsx packages/data/scripts/zetaris-probe.ts            (create, ask, report, then drop)
//        npx tsx packages/data/scripts/zetaris-probe.ts --keep     (leave the probe objects in place)
// It serves its own tiny synthetic source on a free port, so it never touches the live source server
// (18120) or any version 1 object: everything it creates is named fortune_demo_probe*, and it drops
// exactly those objects at the end. Credentials come from .env.local and are never printed.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createZetarisClient, zetarisConfigFromEnv } from '../src/zetaris-client.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const envFile = path.join(root, '.env.local');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const client = createZetarisClient(zetarisConfigFromEnv(process.env));
const keep = process.argv.includes('--keep');

// A Lightning database and a schemastore container share one namespace (case-insensitive): never give them one name.
const DB = 'FORTUNE_DEMO_PROBE_SRC';
const CONTAINER = 'fortune_demo_probe';
const MART = 'fortune_demo_probe_mart';

// Thirteen months, the last one month-to-date: the same shape as version 2's periods.
const MONTHS = ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
const PERIODS: [string, string, string][] = [
  ...MONTHS.map((m): [string, string, string] => [m, `${m}-01`, `${m}-${String(new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5)), 0)).getUTCDate()).padStart(2, '0')}`]),
  ['2026-10-mtd', '2026-10-01', '2026-10-26'],
];
const periodCase = (col: string) => `CASE ${PERIODS.map(([p, from, to]) => `WHEN ${col} BETWEEN '${from}' AND '${to}' THEN '${p}'`).join(' ')} END`;

// Invented rows: four orders a month (revenue rises by month), and a budget cap per channel per month.
const orders = PERIODS.flatMap(([, from], i) => [0, 1, 2, 3].map((k) => ({ order_id: `demo-po-p${i}${k}`, order_date: from, net_usd: 100 * (i + 1) + k })));
const budgets = PERIODS.flatMap(([, from], i) => ['google', 'meta', 'amazon'].map((channel) => ({ month_start: from, channel, cap_usd: 1000 + 10 * i, status: 'approved' })));
const ROUTES: Record<string, unknown[]> = { '/probe/orders': orders, '/probe/budgets': budgets };

const server = http.createServer((req, res) => {
  const rows = ROUTES[new URL(req.url ?? '/', 'http://x').pathname];
  res.writeHead(rows ? 200 : 404, { 'Content-Type': 'application/json' }).end(JSON.stringify(rows ? { data: rows } : { error: 'not found' }));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
const port = (server.address() as AddressInfo).port;
await new Promise((resolve) => setTimeout(resolve, 3000)); // WSL's relay to host.docker.internal needs a moment
const base = `http://${process.env.FAHQ_SOURCE_HOST ?? 'host.docker.internal'}:${port}`;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const results: { test: string; ok: boolean; ms: number; detail: string }[] = [];

async function step(test: string, sql: string, check?: (rows: string[][]) => string | null): Promise<string[][] | null> {
  const t = Date.now();
  try {
    const rows = await client.run(sql, 500);
    const problem = check?.(rows) ?? null;
    results.push({ test, ok: !problem, ms: Date.now() - t, detail: problem ?? `${rows.length} rows${rows[0] ? `; first ${JSON.stringify(rows[0])}` : ''}` });
    return rows;
  } catch (e) {
    results.push({ test, ok: false, ms: Date.now() - t, detail: message(e) });
    return null;
  }
}

const rowsView = `${CONTAINER}.orders_rows`;
const grouped = `SELECT ${periodCase('order_date')} AS period, SUM(net_usd) AS rev FROM ${rowsView} WHERE order_date BETWEEN '2025-10-01' AND '2026-10-26' GROUP BY ${periodCase('order_date')}`;
const indexed = `SELECT period, rev, ROUND(rev / AVG(CASE WHEN period <> '2026-10-mtd' THEN rev END) OVER (), 4) AS idx FROM (${grouped}) g`;
const lagged = `SELECT period, rev, idx, LAG(idx, 12) OVER (ORDER BY period) AS last_year FROM (${indexed}) w`;
const ordersMetrics = `SELECT period, metric_id, value FROM (SELECT period, stack(3, 'p:rev', CAST(rev AS DOUBLE), 'p:idx', CAST(idx AS DOUBLE), 'p:last_year', CAST(last_year AS DOUBLE)) AS (metric_id, value) FROM (${lagged}) l) s WHERE value IS NOT NULL`;
const budgetMetrics = `SELECT period, metric_id, value FROM (SELECT period, stack(1, 'p:cap_google', CAST(cap AS DOUBLE)) AS (metric_id, value) FROM (SELECT ${periodCase('month_start')} AS period, SUM(CASE WHEN channel = 'google' AND status = 'approved' THEN cap_usd END) AS cap FROM ${CONTAINER}.budget_rows GROUP BY ${periodCase('month_start')}) b) s WHERE value IS NOT NULL`;
const derived = `SELECT period, metric_id, value FROM (SELECT period, stack(1, 'p:rev_per_cap', CAST(ROUND(rev / cap, 4) AS DOUBLE)) AS (metric_id, value) FROM (SELECT period, MAX(CASE WHEN metric_id = 'p:rev' THEN value END) AS rev, MAX(CASE WHEN metric_id = 'p:cap_google' THEN value END) AS cap FROM ${CONTAINER}.period_metrics GROUP BY period) w) s WHERE value IS NOT NULL`;

// What each answer must be, computed here from the same invented rows.
const revOf = (i: number) => 4 * 100 * (i + 1) + 6;
const mean12 = MONTHS.reduce((t, _, i) => t + revOf(i), 0) / 12;
const want = (p: string, id: string) => {
  const i = PERIODS.findIndex(([k]) => k === p);
  if (id === 'p:rev') return revOf(i);
  if (id === 'p:idx') return Math.round((revOf(i) / mean12) * 1e4) / 1e4;
  if (id === 'p:last_year') return i >= 12 ? Math.round((revOf(i - 12) / mean12) * 1e4) / 1e4 : undefined;
  if (id === 'p:cap_google') return 1000 + 10 * i;
  if (id === 'p:rev_per_cap') return Math.round((revOf(i) / (1000 + 10 * i)) * 1e4) / 1e4;
  return undefined;
};
const matches = (rows: string[][], ids: string[]) => {
  const got = new Map(rows.map(([p, id, v]) => [`${p}|${id}`, Number(v)]));
  for (const [p] of PERIODS) for (const id of ids) {
    const w = want(p, id);
    const g = got.get(`${p}|${id}`);
    if (w === undefined ? g !== undefined : g === undefined || Math.abs(g - w) > 1e-4) return `${p} ${id}: got ${g}, expected ${w}`;
  }
  return got.size === [...PERIODS].flatMap(([p]) => ids.map((id) => want(p, id))).filter((v) => v !== undefined).length ? null : `unexpected row count ${got.size}`;
};
// One period asked alone (the DataPort's question). A filter pushed below the window would change the
// season index (its average would cover one month), so the values are checked, not just the count.
const matchesPeriod = (p: string, ids: string[]) => (rows: string[][]) => {
  const expected = ids.filter((id) => want(p, id) !== undefined);
  for (const id of expected) {
    const g = rows.find((r) => r[0] === id)?.[1];
    if (g === undefined || Math.abs(Number(g) - want(p, id)!) > 1e-4) return `${p} ${id}: got ${g}, expected ${want(p, id)}`;
  }
  return rows.length === expected.length ? null : `${rows.length} rows, expected ${expected.length}`;
};

try {
  await step('create Lightning database', `CREATE LIGHTNING DATABASE ${DB} DESCRIBE BY "Fortune demo probe, synthetic"`);
  await step('create container (or find it from an earlier run)', `CREATE SCHEMASTORE CONTAINER ${CONTAINER}`);
  if (results.at(-1)?.detail.includes('already exists')) results.at(-1)!.ok = true;
  for (const [name, route] of [['orders', '/probe/orders'], ['budgets', '/probe/budgets']]) {
    await step(`create REST table ${name}`, `CREATE LIGHTNING REST TABLE ${name} FROM ${DB} REQUEST(endpoint "${base}${route}", method "get", response_type "json", http_encoding "URLENCODED") HEADER () BODY ()`);
  }
  await step('create row view orders_rows', `CREATE SCHEMASTORE VIEW orders_rows WITH CONTAINER ${CONTAINER} AS SELECT item.order_id, item.order_date, item.net_usd FROM ${DB.toLowerCase()}.orders LATERAL VIEW explode(data) AS item`);
  await step('create row view budget_rows', `CREATE SCHEMASTORE VIEW budget_rows WITH CONTAINER ${CONTAINER} AS SELECT item.month_start, item.channel, item.cap_usd, item.status FROM ${DB.toLowerCase()}.budgets LATERAL VIEW explode(data) AS item`);
  await step('rows arrive (52 orders)', `SELECT COUNT(*) FROM ${rowsView}`, (r) => (r[0]?.[0] === '52' ? null : `count ${r[0]?.[0]}`));

  await step('window: AVG() OVER () on a grouped REST view', indexed, (r) => (r.length === 13 ? null : `${r.length} rows`));
  await step('window: LAG(idx, 12) over the indexed rows', lagged, (r) => {
    const oct = r.find((x) => x[0] === '2026-10-mtd');
    const w = want('2026-10-mtd', 'p:last_year');
    return oct && Math.abs(Number(oct[3]) - w!) < 1e-4 ? null : `2026-10-mtd last_year ${oct?.[3]}, expected ${w}`;
  });
  await step('window + stack unpivot as a query', ordersMetrics, (r) => matches(r, ['p:rev', 'p:idx', 'p:last_year']));
  await step(
    'create period view: windowed source UNION ALL a second source',
    `CREATE SCHEMASTORE VIEW period_metrics WITH CONTAINER ${CONTAINER} AS ${ordersMetrics}\nUNION ALL\n${budgetMetrics}`,
  );
  await step('ask the period view', `SELECT period, metric_id, value FROM ${CONTAINER}.period_metrics`, (r) => matches(r, ['p:rev', 'p:idx', 'p:last_year', 'p:cap_google']));
  await step('ask the period view for one period', `SELECT metric_id, value FROM ${CONTAINER}.period_metrics WHERE period = '2026-10-mtd'`, matchesPeriod('2026-10-mtd', ['p:rev', 'p:idx', 'p:last_year', 'p:cap_google']));
  await step('create a view that reads the period view', `CREATE SCHEMASTORE VIEW derived_metrics WITH CONTAINER ${CONTAINER} AS ${derived}`);
  await step('ask the view that reads a view', `SELECT period, metric_id, value FROM ${CONTAINER}.derived_metrics`, (r) => matches(r, ['p:rev_per_cap']));
  await step(
    'join two different REST views in one statement',
    `SELECT b.month_start, b.cap_usd, o.n FROM ${CONTAINER}.budget_rows b JOIN (SELECT order_date, COUNT(*) AS n FROM ${rowsView} GROUP BY order_date) o ON o.order_date = b.month_start WHERE b.channel = 'meta'`,
    (r) => (r.length === 13 ? null : `${r.length} rows`),
  );
  await step(
    'DATEDIFF, unix_timestamp minutes, COUNT(DISTINCT)',
    `SELECT DATEDIFF('2026-10-26', '2026-10-01'), (unix_timestamp('2026-10-01 10:30:00') - unix_timestamp('2026-10-01 10:00:00')) / 60, COUNT(DISTINCT channel) FROM ${CONTAINER}.budget_rows`,
    (r) => (r[0]?.[0] === '25' && Number(r[0]?.[1]) === 30 && r[0]?.[2] === '3' ? null : JSON.stringify(r[0])),
  );

  await step('create mart', `CREATE DATAMART ${MART} DESCRIBE BY 'Fortune demo probe mart, synthetic'`);
  await step('mart table 1 (period view)', `ADD DATAMART TABLE period_metrics INTO ${MART} FROM ${CONTAINER}.period_metrics VSCHEMA (period period, metric_id metric_id, value value)`);
  await step('mart table 2 (the view that reads a view)', `ADD DATAMART TABLE derived_metrics INTO ${MART} FROM ${CONTAINER}.derived_metrics VSCHEMA (period period, metric_id metric_id, value value)`);
  await step('SHOW DATAMART TABLES', `SHOW DATAMART TABLES ${MART}`, (r) => (r.length >= 2 ? null : `${r.length} tables`));
  await step('ask mart table 1', `SELECT period, metric_id, value FROM ${MART}.period_metrics`, (r) => matches(r, ['p:rev', 'p:idx', 'p:last_year', 'p:cap_google']));
  await step('ask mart table 2', `SELECT period, metric_id, value FROM ${MART}.derived_metrics`, (r) => matches(r, ['p:rev_per_cap']));
  await step('ask mart table 1 for one period', `SELECT metric_id, value FROM ${MART}.period_metrics WHERE period = '2026-09'`, matchesPeriod('2026-09', ['p:rev', 'p:idx', 'p:last_year', 'p:cap_google']));
  await step('ask mart table 2 for one period', `SELECT metric_id, value FROM ${MART}.derived_metrics WHERE period = '2026-03'`, matchesPeriod('2026-03', ['p:rev_per_cap']));
} finally {
  if (!keep) {
    for (const [label, sql] of [
      ['drop mart', `DROP DATAMART ${MART}`],
      ['drop derived view', `DROP VIEW ${CONTAINER}.derived_metrics`],
      ['drop period view', `DROP VIEW ${CONTAINER}.period_metrics`],
      ['drop row view orders_rows', `DROP VIEW ${CONTAINER}.orders_rows`],
      ['drop row view budget_rows', `DROP VIEW ${CONTAINER}.budget_rows`],
      ['drop REST table orders', `DROP LIGHTNING DATABASE TABLE ${DB.toLowerCase()}.orders`],
      ['drop REST table budgets', `DROP LIGHTNING DATABASE TABLE ${DB.toLowerCase()}.budgets`],
      ['drop Lightning database', `DROP LIGHTNING DATABASE ${DB}`],
    ] as const) await step(label, sql);
    // There is no SQL to drop a schemastore container (DROP SCHEMASTORE CONTAINER and DROP CONTAINER are
    // both parse errors, seen live 2026-10-27), so the empty container fortune_demo_probe stays.
  }
  server.close();
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.test.padEnd(58)} ${String(r.ms).padStart(6)} ms  ${r.detail}`);
}
