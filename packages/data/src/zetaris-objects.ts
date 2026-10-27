import { CONTAINER_V2, PERIOD_VIEW_V2, financeViewBody } from './finance-sql.ts';
import { DIVISIONS, LAYERS, LAYER_VIEW, MARTS_V2, divisionMartSql, filterViewBody, filterViewName } from './divisions.ts';
import { DERIVED_VIEW_V2, STANDING_VIEW_V2, derivedViewBody, standingViewBody } from './layers.ts';

// Version 2's Zetaris objects, created beside version 1's and never in place of them: new REST tables
// (version 1's databases get a *_v2 table next to their own; the budget sheet gets its own database, as
// each separately owned system does), row views, the three layer views and each division's filter views in
// their own container, and one Virtual Data Mart per division. Version 1's tables, views and mart are never
// named here, so nothing built from this list can drop or change them.
// Zetaris descriptions allow only letters, digits, spaces and _ . - ,

/** Version 2's sources are served on their own port, so the server version 1 reads is never involved. */
export const SOURCE_PORT_V2_DEFAULT = 18121;

/** Databases version 2 adds. A database and a container must never share a name (one namespace). */
export const V2_DATABASES = [{ db: 'FORTUNE_DEMO_FINANCE', about: 'Fortune demo finance owner budget sheet, synthetic' }] as const;

export const V2_TABLES = [
  {
    db: 'FORTUNE_DEMO_SALON', table: 'appointments_v2', path: '/v2/salon/appointments', view: 'salon_appointments',
    cols: ['appointment_id', 'appointment_date', 'service', 'stylist_id', 'price_usd', 'duration_min', 'status'],
  },
  {
    db: 'FORTUNE_DEMO_ONLINE', table: 'orders_v2', path: '/v2/online/orders', view: 'online_orders',
    cols: ['order_id', 'order_date', 'product_line', 'channel', 'units', 'gross_usd', 'discount_usd', 'net_usd', 'cost_usd'],
  },
  {
    db: 'FORTUNE_DEMO_MARKETING', table: 'ads_v2', path: '/v2/marketing/ads', view: 'marketing_ads',
    cols: ['ad_id', 'ad_date', 'channel', 'keyword', 'spend_usd', 'clicks', 'conversions', 'revenue_usd'],
  },
  {
    db: 'FORTUNE_DEMO_MARKETING', table: 'email_v2', path: '/v2/marketing/email', view: 'marketing_email',
    cols: ['email_id', 'send_date', 'kind', 'name', 'sends', 'opens', 'clicks', 'revenue_usd'],
  },
  {
    db: 'FORTUNE_DEMO_FINANCE', table: 'budgets', path: '/v2/finance/budgets', view: 'finance_budgets',
    cols: ['budget_id', 'month_start', 'channel', 'cap_usd', 'status'],
  },
] as const;

export type Statement = { label: string; sql: string };

/** The division filter views, every division and layer (twelve), each over its layer view. */
function filterViews(): Statement[] {
  return DIVISIONS.flatMap((d) => LAYERS.map((l) => ({
    label: `${CONTAINER_V2}.${filterViewName(d, l)}`,
    sql: `CREATE SCHEMASTORE VIEW ${filterViewName(d, l)} WITH CONTAINER ${CONTAINER_V2} AS ${filterViewBody(d, l)}`,
  })));
}

/** Everything version 2 needs but the marts, in creation order. Each is one statement; "already exists" means done. */
export function v2CreateStatements(sourceBase: string): Statement[] {
  return [
    ...V2_DATABASES.map(({ db, about }) => ({ label: db, sql: `CREATE LIGHTNING DATABASE ${db} DESCRIBE BY "${about}"` })),
    { label: `container ${CONTAINER_V2}`, sql: `CREATE SCHEMASTORE CONTAINER ${CONTAINER_V2}` },
    ...V2_TABLES.map((t) => ({
      label: `${t.db.toLowerCase()}.${t.table}`,
      sql: `CREATE LIGHTNING REST TABLE ${t.table} FROM ${t.db} REQUEST(endpoint "${sourceBase}${t.path}", method "get", response_type "json", http_encoding "URLENCODED") HEADER () BODY ()`,
    })),
    ...V2_TABLES.map((t) => ({
      label: `${CONTAINER_V2}.${t.view}`,
      sql: `CREATE SCHEMASTORE VIEW ${t.view} WITH CONTAINER ${CONTAINER_V2} AS SELECT ${t.cols.map((c) => `item.${c}`).join(', ')} FROM ${t.db.toLowerCase()}.${t.table} LATERAL VIEW explode(data) AS item`,
    })),
    { label: PERIOD_VIEW_V2, sql: `CREATE SCHEMASTORE VIEW period_metrics WITH CONTAINER ${CONTAINER_V2} AS ${financeViewBody(2)}` },
    { label: DERIVED_VIEW_V2, sql: `CREATE SCHEMASTORE VIEW derived_metrics WITH CONTAINER ${CONTAINER_V2} AS ${derivedViewBody()}` },
    { label: STANDING_VIEW_V2, sql: `CREATE SCHEMASTORE VIEW standing_metrics WITH CONTAINER ${CONTAINER_V2} AS ${standingViewBody()}` },
    ...filterViews(),
  ];
}

/** The four division marts, each with its three tables; setup adds whatever SHOW does not list yet. */
export const v2Marts = () => DIVISIONS.map((d) => ({ division: d, mart: MARTS_V2[d], ...divisionMartSql(d) }));

/**
 * Version 2's objects in drop order: the marts, then every view that reads another (filter views, then the
 * derived and standing views, then the period view), then the row views, then the REST tables. Its
 * databases and container stay: dropping them is never needed to rebuild, and a container cannot be
 * dropped in SQL.
 */
export function v2DropStatements(): Statement[] {
  return [
    ...v2Marts().map((m) => ({ label: `mart ${m.mart}`, sql: m.drop })),
    ...filterViews().map((s) => ({ label: s.label, sql: `DROP VIEW ${s.label}` })),
    ...(['derived', 'standing', 'period'] as const).map((l) => ({ label: LAYER_VIEW[l].view, sql: `DROP VIEW ${LAYER_VIEW[l].view}` })),
    ...V2_TABLES.map((t) => ({ label: `${CONTAINER_V2}.${t.view}`, sql: `DROP VIEW ${CONTAINER_V2}.${t.view}` })),
    ...V2_TABLES.map((t) => ({ label: `${t.db.toLowerCase()}.${t.table}`, sql: `DROP LIGHTNING DATABASE TABLE ${t.db.toLowerCase()}.${t.table}` })),
  ];
}
