// Creates the Zetaris objects the finance assistant reads, then proves them.
// Usage: npx tsx scripts/zetaris-setup.ts               (create what is missing, then verify)
//        npx tsx scripts/zetaris-setup.ts --recreate    (drop and rebuild the tables and views first)
//        npx tsx scripts/zetaris-setup.ts --verify-only
// Three Lightning databases stand for three separately owned systems (salon bookings, the online
// store, marketing), each a REST source served by packages/data's synthetic source server. Zetaris
// reaches that server at host.docker.internal. The governed view fortune_hq.finance_metrics is also
// published as a Virtual Data Mart (fortune_demo_finance_mart.finance_metrics, no copy of the data).
// Credentials come from .env.local and are never printed.
import fs from 'node:fs';
import path from 'node:path';
import {
  CONTAINER, FINANCE_VIEW, MART, MART_TABLE, MART_VIEW, METRIC_BY_ID, computeFinanceMetricsLocally, financeQuery, financeViewBody,
  martQuery, martSql,
} from '../packages/data/src/finance-sql.ts';
import { SOURCE_PORT_DEFAULT, ensureSourceServer } from '../packages/data/src/source-server.ts';
import { PERIODS, generateBusiness, type Period } from '../packages/data/src/synthetic.ts';
import { createZetarisClient, zetarisConfigFromEnv } from '../packages/data/src/zetaris-client.ts';

const root = path.resolve(import.meta.dirname, '..');
const envFile = path.join(root, '.env.local');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const env = process.env;
const args = new Set(process.argv.slice(2));

const port = Number(env.FAHQ_SOURCE_PORT ?? SOURCE_PORT_DEFAULT);
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
    if (/not (found|exist)|does not exist|no such|cannot find/i.test(message(e))) console.log(`absent   ${label}`);
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

try {
  if (!args.has('--verify-only')) {
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

  // Proof: the federated Zetaris answer equals an independent computation over the same rows,
  // asked of the governed view and again of the Virtual Data Mart table built on it.
  const business = generateBusiness();
  async function prove(label: string, queryFor: (period: Period) => string, detail: boolean): Promise<number> {
    let failures = 0;
    for (const period of Object.keys(PERIODS) as Period[]) {
      const t = Date.now();
      const rows = await client.run(queryFor(period), 500);
      const got = new Map(rows.map(([id, v]) => [id ?? '', Number(v)]));
      const want = computeFinanceMetricsLocally(business, period);
      const problems: string[] = [];
      for (const [id, w] of want) {
        const g = got.get(id);
        const unit = METRIC_BY_ID.get(id)?.unit;
        const tolerance = unit === 'ratio' ? 0.00011 : unit === 'usd' ? 0.011 : 0;
        if (g === undefined) problems.push(`${id}: missing from Zetaris (expected ${w})`);
        else if (Math.abs(g - w) > tolerance) problems.push(`${id}: Zetaris ${g}, expected ${w}`);
      }
      for (const id of got.keys()) if (!want.has(id)) problems.push(`${id}: returned by Zetaris but not expected`);
      failures += problems.length;
      console.log(`\n${period}: ${got.size} of ${want.size} metrics from ${label} in ${Date.now() - t} ms; ${problems.length ? `${problems.length} MISMATCHES` : 'all match the independent computation'}`);
      for (const p of problems) console.log(`  ✗ ${p}`);
      const show = ['m:online.revenue.total', 'm:online.ads.google.roas', 'm:online.dq.rejected_orders', 'm:salon.revenue.total', 'm:salon.dq.rejected_appointments'];
      if (detail) for (const id of show) if (got.has(id)) console.log(`  ${id.padEnd(36)} ${got.get(id)}`);
    }
    return failures;
  }
  let failures = await prove(FINANCE_VIEW, financeQuery, true);
  failures += await prove(`the data mart (${MART_VIEW})`, martQuery, false);
  if (failures) {
    console.error(`\nzetaris-setup: ${failures} mismatches`);
    process.exitCode = 1;
  } else {
    console.log('\nzetaris-setup: verified');
  }
} catch (e) {
  console.error(`zetaris-setup failed: ${message(e)}`);
  process.exitCode = 1;
} finally {
  await sources.close();
}
