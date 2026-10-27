// Creates the Zetaris objects the finance assistant reads, then proves them.
// Usage: npx tsx scripts/zetaris-setup.ts               (create what is missing, then verify)
//        npx tsx scripts/zetaris-setup.ts --recreate    (drop and rebuild the tables and views first)
//        npx tsx scripts/zetaris-setup.ts --verify-only
//        npx tsx scripts/zetaris-setup.ts --v2 [--recreate | --verify-only]
//          (version 2 only: its own tables, views, container and four division marts beside version 1's,
//          served on its own port; --recreate there drops and rebuilds version 2's objects and never
//          touches version 1's. Its proof asks every layer view, every mart table and the DataPort's own
//          reads, and checks that version 1's mart is listed exactly as before)
// Three Lightning databases stand for three separately owned systems (salon bookings, the online
// store, marketing), each a REST source served by packages/data's synthetic source server. Zetaris
// reaches that server at host.docker.internal. The governed view fortune_hq.finance_metrics is also
// published as a Virtual Data Mart (fortune_demo_finance_mart.finance_metrics, no copy of the data).
// Credentials come from .env.local and are never printed.
import fs from 'node:fs';
import path from 'node:path';
import {
  CONTAINER, FINANCE_VIEW, MART, MART_TABLE, MART_VIEW, METRIC_BY_ID, PERIOD_VIEW_V2, computeAll, financeQuery, financeViewBody,
  martQuery, martSql,
} from '../packages/data/src/finance-sql.ts';
import type { Division, RowRead } from '@fahq/contracts';
import { CATALOG_V2_BY_ID, DIVISIONS, LAYERS, divisionIds, divisionSlice, seriesOf, type Layer } from '../packages/data/src/divisions.ts';
import { oracleRows } from '../packages/data/src/rows.ts';
import { createZetarisDataPort } from '../packages/data/src/index.ts';
import { DERIVED_VIEW_V2, STANDING_PERIOD, STANDING_VIEW_V2, computeLayers, type Layers } from '../packages/data/src/layers.ts';
import { SOURCE_PORT_DEFAULT, ensureSourceServer } from '../packages/data/src/source-server.ts';
import { generateBusiness, generateYear, type Period } from '../packages/data/src/synthetic.ts';
import { createZetarisClient, zetarisConfigFromEnv } from '../packages/data/src/zetaris-client.ts';
import { SOURCE_PORT_V2_DEFAULT, v2CreateStatements, v2DropStatements, v2Marts } from '../packages/data/src/zetaris-objects.ts';

const root = path.resolve(import.meta.dirname, '..');
const envFile = path.join(root, '.env.local');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const env = process.env;
const args = new Set(process.argv.slice(2));

const v2 = args.has('--v2');
const port = Number(v2 ? (env.FAHQ_SOURCE_PORT_V2 ?? SOURCE_PORT_V2_DEFAULT) : (env.FAHQ_SOURCE_PORT ?? SOURCE_PORT_DEFAULT));
const sourceBase = `http://${env.FAHQ_SOURCE_HOST ?? 'host.docker.internal'}:${port}`;

// Zetaris descriptions allow only letters, digits, spaces and _ . - ,
const DATABASES = [
  { db: 'FORTUNE_DEMO_SALON', about: 'Fortune demo salon bookings, synthetic', tables: [{ name: 'appointments', path: '/salon/appointments' }] },
  { db: 'FORTUNE_DEMO_ONLINE', about: 'Fortune demo online store orders, synthetic', tables: [{ name: 'orders', path: '/online/orders' }] },
  {
    db: 'FORTUNE_DEMO_MARKETING', about: 'Fortune demo ads and email results, synthetic',
    tables: [{ name: 'ads', path: '/marketing/ads' }, { name: 'email', path: '/marketing/email' }],
  },
] as const;

const VIEWS = [
  { name: 'salon_appointments', from: 'fortune_demo_salon.appointments', cols: ['appointment_id', 'appointment_date', 'service', 'stylist_id', 'price_usd', 'duration_min', 'status'] },
  { name: 'online_orders', from: 'fortune_demo_online.orders', cols: ['order_id', 'order_date', 'product_line', 'channel', 'units', 'gross_usd', 'discount_usd', 'net_usd', 'cost_usd'] },
  { name: 'marketing_ads', from: 'fortune_demo_marketing.ads', cols: ['ad_id', 'ad_date', 'channel', 'keyword', 'spend_usd', 'clicks', 'conversions', 'revenue_usd'] },
  { name: 'marketing_email', from: 'fortune_demo_marketing.email', cols: ['email_id', 'send_date', 'kind', 'name', 'sends', 'opens', 'clicks', 'revenue_usd'] },
] as const;

const client = createZetarisClient(zetarisConfigFromEnv(env));
const sources = await ensureSourceServer(port);
console.log(`sources: ${sources.started ? 'started' : 'already running'} on 127.0.0.1:${port}; Zetaris reads ${sourceBase}`);

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function create(label: string, sql: string) {
  const t = Date.now();
  try {
    await client.run(sql);
    console.log(`created  ${label} (${Date.now() - t} ms)`);
  } catch (e) {
    if (/already exist/i.test(message(e))) console.log(`exists   ${label}`);
    else throw new Error(`${label}: ${message(e)}`);
  }
}

async function drop(label: string, sql: string) {
  try {
    await client.run(sql);
    console.log(`dropped  ${label}`);
  } catch (e) {
    if (/not (found|exist)|not_found|does not exist|doesn't exist|no such|cannot (be )?find|cannot be found/i.test(message(e))) console.log(`absent   ${label}`);
    else throw new Error(`${label}: ${message(e)}`);
  }
}

/** Creates the data mart and its one table when they are not there yet (SHOW first, so a re-run changes nothing). */
async function ensureMart() {
  const sql = martSql();
  const marts = await client.run('SHOW DATAMARTS', 200);
  if (marts.some((row) => row.some((cell) => cell.toLowerCase() === MART))) console.log(`exists   mart ${MART}`);
  else await create(`mart ${MART}`, sql.create);
  const tables = await client.run(`SHOW DATAMART TABLES ${MART}`, 200);
  if (tables.some((row) => row.some((cell) => cell.toLowerCase() === MART_TABLE || cell.toLowerCase() === MART_VIEW))) {
    console.log(`exists   ${MART_VIEW}`);
  } else {
    await create(MART_VIEW, sql.addTable);
  }
}

/** Version 1: creates what is missing (or rebuilds it with --recreate), then its mart. */
async function buildV1() {
  if (args.has('--recreate')) {
    await drop(`mart ${MART}`, martSql().drop);
    await drop(FINANCE_VIEW, `DROP VIEW ${FINANCE_VIEW}`);
    for (const v of VIEWS) await drop(`${CONTAINER}.${v.name}`, `DROP VIEW ${CONTAINER}.${v.name}`);
    for (const d of DATABASES) for (const t of d.tables) await drop(`${d.db.toLowerCase()}.${t.name}`, `DROP LIGHTNING DATABASE TABLE ${d.db.toLowerCase()}.${t.name}`);
  }
  for (const d of DATABASES) await create(d.db, `CREATE LIGHTNING DATABASE ${d.db} DESCRIBE BY "${d.about}"`);
  await create(`container ${CONTAINER}`, `CREATE SCHEMASTORE CONTAINER ${CONTAINER}`);
  for (const d of DATABASES) {
    for (const t of d.tables) {
      await create(
        `${d.db.toLowerCase()}.${t.name}`,
        `CREATE LIGHTNING REST TABLE ${t.name} FROM ${d.db} REQUEST(endpoint "${sourceBase}${t.path}", method "get", response_type "json", http_encoding "URLENCODED") HEADER () BODY ()`,
      );
    }
  }
  for (const v of VIEWS) {
    await create(
      `${CONTAINER}.${v.name}`,
      `CREATE SCHEMASTORE VIEW ${v.name} WITH CONTAINER ${CONTAINER} AS SELECT ${v.cols.map((c) => `item.${c}`).join(', ')} FROM ${v.from} LATERAL VIEW explode(data) AS item`,
    );
  }
  await create(FINANCE_VIEW, `CREATE SCHEMASTORE VIEW finance_metrics WITH CONTAINER ${CONTAINER} AS ${financeViewBody()}`);
  await ensureMart();
}

/** Version 2's division marts and their tables, adding whatever SHOW does not list (an add that fails stops the setup). */
async function ensureMartsV2() {
  const marts = (await client.run('SHOW DATAMARTS', 500)).flat().map((c) => c.toLowerCase());
  for (const m of v2Marts()) {
    if (marts.includes(m.mart)) console.log(`exists   mart ${m.mart}`);
    else await create(`mart ${m.mart}`, m.create);
    const listed = (await client.run(`SHOW DATAMART TABLES ${m.mart}`, 200)).flat().map((c) => c.toLowerCase());
    for (const t of m.tables) {
      const label = `${m.mart}.${t.table}`;
      if (listed.includes(t.table) || listed.includes(label)) { console.log(`exists   ${label}`); continue; }
      const started = Date.now();
      await client.run(t.sql).catch((e) => { throw new Error(`${label}: ${message(e)}`); });
      console.log(`created  ${label} (${Date.now() - started} ms)`);
    }
  }
}

/** Version 2: only version 2's own objects, beside version 1's (zetaris-objects.ts names nothing of version 1). */
async function buildV2() {
  if (args.has('--recreate')) for (const s of v2DropStatements()) await drop(s.label, s.sql);
  for (const s of v2CreateStatements(sourceBase)) await create(s.label, s.sql);
  await ensureMartsV2();
}

/** What Zetaris lists of version 1's mart (metadata only; reading its data would call the live worker's source server). */
async function v1MartListing(): Promise<string> {
  const marts = (await client.run('SHOW DATAMARTS', 500)).filter((row) => row.some((c) => c.toLowerCase() === MART));
  const tables = await client.run(`SHOW DATAMART TABLES ${MART}`, 200).catch((e) => [[`error: ${message(e).slice(0, 80)}`]]);
  return JSON.stringify({ marts, tables });
}

// Proof: the federated Zetaris answer equals an independent computation over the same rows, period by
// period, metric by metric.
const SHOW = ['m:online.revenue.total', 'm:online.ads.google.roas', 'm:online.dq.rejected_orders', 'm:salon.revenue.total', 'm:salon.dq.rejected_appointments'];

/** Compares one period's answer with the oracle; prints and returns the mismatches. */
function compare(label: string, got: Map<string, number>, want: Map<string, number>, ms: number): number {
  const problems: string[] = [];
  for (const [id, w] of want) {
    const g = got.get(id);
    const unit = (CATALOG_V2_BY_ID.get(id) ?? METRIC_BY_ID.get(id))?.unit;
    const tolerance = unit === 'ratio' ? 0.00011 : unit === 'usd' ? 0.011 : 0;
    if (g === undefined) problems.push(`${id}: missing from Zetaris (expected ${w})`);
    else if (Math.abs(g - w) > tolerance) problems.push(`${id}: Zetaris ${g}, expected ${w}`);
  }
  for (const id of got.keys()) if (!want.has(id)) problems.push(`${id}: returned by Zetaris but not expected`);
  console.log(`${label}: ${got.size} of ${want.size} metrics in ${ms} ms; ${problems.length ? `${problems.length} MISMATCHES` : 'all match the independent computation'}`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  return problems.length;
}

async function prove(label: string, queryFor: (period: Period) => string, oracle: Map<Period, Map<string, number>>, detail: boolean): Promise<number> {
  let failures = 0;
  for (const [period, want] of oracle) {
    const t = Date.now();
    const rows = await client.run(queryFor(period), 500);
    const got = new Map(rows.map(([id, v]) => [id ?? '', Number(v)]));
    console.log('');
    failures += compare(`${period} from ${label}`, got, want, Date.now() - t);
    if (detail) for (const id of SHOW) if (got.has(id)) console.log(`  ${id.padEnd(36)} ${got.get(id)}`);
  }
  return failures;
}

/** One statement for every period at once (period, metric_id, value), compared period by period. */
async function proveAll(label: string, table: string, want: Map<string, Map<string, number>>): Promise<number> {
  const t = Date.now();
  const rows = await client.run(`SELECT period, metric_id, value FROM ${table}`, 5000);
  const ms = Date.now() - t;
  const got = new Map<string, Map<string, number>>();
  for (const [period, id, v] of rows) {
    if (!got.has(period!)) got.set(period!, new Map());
    got.get(period!)!.set(id!, Number(v));
  }
  let failures = 0;
  const periods = new Set([...want.keys(), ...got.keys()]);
  for (const p of periods) failures += compare(`  ${label} ${p}`, got.get(p) ?? new Map(), want.get(p) ?? new Map(), ms);
  return failures;
}

/** The oracle's rows for one layer, cut to a division's ids when given, keyed by period ('standing' for the standing layer). */
function layerWant(layers: Layers, layer: Layer, division?: (typeof DIVISIONS)[number]): Map<string, Map<string, number>> {
  const keep = (values: Map<string, number>) => {
    const ids = division ? new Set(divisionIds(division, layer)) : null;
    return new Map([...values].filter(([id]) => !ids || ids.has(id)));
  };
  if (layer === 'standing') return new Map([[STANDING_PERIOD, keep(layers.standing)]]);
  return new Map([...layers[layer]].map(([p, values]) => [p, keep(values)]));
}

const ROW_READS: RowRead[] = [
  { table: 'repairs', status: 'open' }, { table: 'repairs', status: 'late' }, { table: 'repairs', status: 'done' },
  { table: 'invoices', status: 'open' }, { table: 'invoices', status: 'overdue' }, { table: 'invoices', status: 'due_30d', business: 'salon' },
  { table: 'waiting', olderThanHours: 0 }, { table: 'waiting', olderThanHours: 24 }, { table: 'low_stock' },
  // Wave 2, the channels.
  { table: 'marketplace_stock', status: 'all' }, { table: 'marketplace_stock', status: 'low', marketplace: 'amazon' },
  { table: 'products', period: '2026-10-mtd', sort: 'worst' }, { table: 'products', period: '2026-09', sort: 'best' },
];
const SERIES: { division: Division; id: string }[] = [
  { division: 'finance', id: 'm:online.revenue.total' }, { division: 'finance', id: 'm:online.budget.google.room' },
  { division: 'salon', id: 'm:salon.no_show_rate' }, { division: 'online', id: 'm:online.service.replied_24h.share' },
  { division: 'hq', id: 'm:salon.season.month_index' },
  { division: 'finance', id: 'm:online.amazon.revenue' }, { division: 'online', id: 'm:online.products.negative_margin.count' },
];

/** Equal as data: the same keys, strings exactly, numbers within a cent (or a hundredth of an hour). */
function sameData(got: unknown, want: unknown): boolean {
  if (typeof got === 'number' && typeof want === 'number') return Math.abs(got - want) <= 0.011;
  if (got && want && typeof got === 'object' && typeof want === 'object') {
    const keys = new Set([...Object.keys(got), ...Object.keys(want)]);
    return [...keys].every((k) => sameData((got as Record<string, unknown>)[k], (want as Record<string, unknown>)[k]));
  }
  return got === want;
}

/** The row reads and the series, through the DataPort, against the oracle. */
async function proveRowsAndSeries(port: ReturnType<typeof createZetarisDataPort>, layers: Layers, asOf: string): Promise<number> {
  const year = generateYear();
  let failures = 0;
  console.log('\nrow reads (DataPort, version 2)');
  for (const read of ROW_READS) {
    const t = Date.now();
    const got = await port.readRows!({ ...read, asOf });
    const want = oracleRows(year, read);
    const ok = got.rows.length === want.rows.length && sameData(got.rows, want.rows) && sameData(got.totals, want.totals);
    console.log(`${ok ? '  ok ' : '  ✗  '} ${JSON.stringify(read)}: ${got.rows.length} rows, totals ${JSON.stringify(got.totals)} in ${Date.now() - t} ms`);
    if (!ok) { failures += 1; console.log(`     expected ${want.rows.length} rows, totals ${JSON.stringify(want.totals)}`); }
  }
  console.log('\nseries (DataPort, version 2, from the division marts)');
  for (const { division, id } of SERIES) {
    const t = Date.now();
    const got = await port.getMetricSeries!({ division, metricId: id, asOf });
    const want = seriesOf(layers, id);
    const ok = sameData(got.points, want) && got.points.length === want.length;
    console.log(`${ok ? '  ok ' : '  ✗  '} ${division} ${id}: ${got.points.length} points, min ${got.stats.min}, max ${got.stats.max}, mean12 ${got.stats.mean12} in ${Date.now() - t} ms`);
    if (!ok) failures += 1;
  }
  return failures;
}

/** Version 2's proof beyond the period view: the derived and standing views, every mart table, and the DataPort's own reads. */
async function proveV2Layers(): Promise<number> {
  const layers = computeLayers(generateYear());
  let failures = 0;
  console.log('\nlayer views (every period in one statement)');
  failures += await proveAll(DERIVED_VIEW_V2, DERIVED_VIEW_V2, layerWant(layers, 'derived'));
  failures += await proveAll(STANDING_VIEW_V2, STANDING_VIEW_V2, layerWant(layers, 'standing'));
  for (const m of v2Marts()) {
    console.log(`\nmart ${m.mart} (every period in one statement per table)`);
    for (const layer of LAYERS) failures += await proveAll(`${layer}_metrics`, `${m.mart}.${layer}_metrics`, layerWant(layers, layer, m.division));
  }
  // The reads the worker makes, through the DataPort itself.
  const port = createZetarisDataPort({ ...env, FAHQ_DATA_VERSION: '2' }, { client, ensureSources: async () => {} });
  const asOf = new Date().toISOString();
  console.log('\nDataPort reads (version 2)');
  for (const period of ['2026-10-mtd', '2026-09'] as const) {
    let t = Date.now();
    const all = await port.getFinanceMetrics({ asOf, period });
    const want = new Map([...layers.period.get(period)!, ...layers.derived.get(period)!, ...layers.standing]);
    failures += compare(`getFinanceMetrics ${period} (three layer views)`, new Map(all.metrics.map((x) => [x.id, x.value])), want, Date.now() - t);
    for (const division of DIVISIONS) {
      t = Date.now();
      const r = await port.getDivisionMetrics!({ division, period, asOf });
      failures += compare(`getDivisionMetrics ${division} ${period} (${r.view})`, new Map(r.metrics.map((x) => [x.id, x.value])), divisionSlice(layers, division, period), Date.now() - t);
      for (const a of r.attention) console.log(`  attention ${a.level.padEnd(5)} ${a.metricId}: ${a.rule}`);
    }
  }
  return failures + (await proveRowsAndSeries(port, layers, asOf));
}

try {
  const v1Before = v2 ? await v1MartListing() : '';
  if (!args.has('--verify-only')) await (v2 ? buildV2() : buildV1());
  // Version 1 is asked of its view and again of the Virtual Data Mart table built on it; version 2 of its
  // period view, then its other layers, its marts and the DataPort.
  let failures = v2
    ? (await prove(PERIOD_VIEW_V2, (p) => financeQuery(p, 2), computeAll(generateYear(), 2), true)) + (await proveV2Layers())
    : (await prove(FINANCE_VIEW, financeQuery, computeAll(generateBusiness(), 1), true))
      + (await prove(`the data mart (${MART_VIEW})`, martQuery, computeAll(generateBusiness(), 1), false));
  if (v2) {
    const same = (await v1MartListing()) === v1Before;
    console.log(`\nversion 1: mart ${MART} and its tables are listed ${same ? 'exactly as before' : 'DIFFERENTLY from before'}`);
    if (!same) failures += 1;
  }
  if (failures) {
    console.error(`\nzetaris-setup: ${failures} mismatches`);
    process.exitCode = 1;
  } else {
    console.log(`\nzetaris-setup: version ${v2 ? 2 : 1} verified`);
  }
} catch (e) {
  console.error(`zetaris-setup failed: ${message(e)}`);
  process.exitCode = 1;
} finally {
  await sources.close();
}
