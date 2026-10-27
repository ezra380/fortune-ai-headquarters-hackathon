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
export const V2_DATABASES = [
  // Created live in slice 1 with this description; it also holds the supplier invoices now.
  { db: 'FORTUNE_DEMO_FINANCE', about: 'Fortune demo finance owner budget sheet, synthetic' },
  { db: 'FORTUNE_DEMO_SUPPORT', about: 'Fortune demo support inbox, message times and topics only, synthetic' },
  { db: 'FORTUNE_DEMO_MARKETPLACE', about: 'Fortune demo Amazon and Walmart sales, ads and warehouse stock, synthetic' },
] as const;

export const V2_TABLES = [
  {
    db: 'FORTUNE_DEMO_SALON', table: 'appointments_v2', path: '/v2/salon/appointments', view: 'salon_appointments',
    cols: ['appointment_id', 'appointment_date', 'service', 'stylist_id', 'price_usd', 'duration_min', 'status', 'location', 'booked_via', 'labor_cost_usd'],
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
  // The day-to-day systems: the store's order fees, refunds, checkouts and stock; the support inbox (its own
  // system and database); the ops app's repair tickets; the factories' invoices.
  {
    db: 'FORTUNE_DEMO_ONLINE', table: 'order_costs', path: '/v2/online/order_costs', view: 'online_order_costs',
    cols: ['cost_id', 'order_id', 'order_date', 'payment_fee_usd', 'shipping_cost_usd'],
  },
  {
    db: 'FORTUNE_DEMO_ONLINE', table: 'refunds', path: '/v2/online/refunds', view: 'online_refunds',
    cols: ['refund_id', 'order_id', 'refund_date', 'amount_usd', 'reason'],
  },
  {
    db: 'FORTUNE_DEMO_ONLINE', table: 'checkouts', path: '/v2/online/checkouts', view: 'online_checkouts',
    cols: ['checkout_id', 'created_date', 'product_line', 'value_usd', 'recovered_via', 'recovered_order_id'],
  },
  {
    db: 'FORTUNE_DEMO_ONLINE', table: 'inventory', path: '/v2/online/inventory', view: 'online_inventory',
    cols: ['snapshot_id', 'snapshot_date', 'sku', 'product_line', 'on_hand', 'reorder_point', 'views_7d', 'add_to_cart_7d'],
  },
  {
    db: 'FORTUNE_DEMO_SUPPORT', table: 'messages', path: '/v2/support/messages', view: 'support_messages',
    cols: ['message_id', 'thread_id', 'channel', 'direction', 'received_date', 'received_at', 'first_reply_at', 'intent', 'converted_order_id'],
  },
  {
    db: 'FORTUNE_DEMO_SALON', table: 'repair_tickets', path: '/v2/salon/repairs', view: 'salon_repairs',
    cols: ['ticket_id', 'channel', 'location', 'repair_type', 'received_date', 'quoted_date', 'paid_date', 'completed_date', 'shipped_date', 'status', 'quote_usd', 'parts_cost_usd', 'labor_cost_usd'],
  },
  {
    db: 'FORTUNE_DEMO_FINANCE', table: 'invoices', path: '/v2/finance/invoices', view: 'finance_invoices',
    cols: ['invoice_id', 'supplier_id', 'business', 'product_line', 'invoice_date', 'due_date', 'paid_date', 'amount_usd'],
  },
  // The channels (wave 2): the marketplaces (their own system and database), the email split, the order lines.
  {
    db: 'FORTUNE_DEMO_MARKETPLACE', table: 'sales', path: '/v2/marketplace/sales', view: 'marketplace_sales',
    cols: ['sale_id', 'sale_date', 'marketplace', 'sku', 'product_line', 'units', 'revenue_usd', 'fees_usd'],
  },
  {
    db: 'FORTUNE_DEMO_MARKETPLACE', table: 'ads', path: '/v2/marketplace/ads', view: 'marketplace_ads',
    cols: ['ad_id', 'ad_date', 'channel', 'keyword', 'spend_usd', 'clicks', 'conversions', 'revenue_usd'],
  },
  {
    db: 'FORTUNE_DEMO_MARKETPLACE', table: 'stock', path: '/v2/marketplace/stock', view: 'marketplace_stock',
    cols: ['stock_id', 'snapshot_date', 'marketplace', 'sku', 'product_line', 'on_hand', 'inbound', 'units_28d'],
  },
  {
    db: 'FORTUNE_DEMO_MARKETING', table: 'email_messages', path: '/v2/marketing/email_messages', view: 'marketing_email_messages',
    cols: ['message_id', 'email_id', 'send_date', 'kind', 'name', 'step', 'sends', 'revenue_usd', 'unsubscribes'],
  },
  {
    db: 'FORTUNE_DEMO_ONLINE', table: 'order_lines', path: '/v2/online/order_lines', view: 'online_order_lines',
    cols: ['line_id', 'order_id', 'order_date', 'sku', 'product_line', 'units', 'price_usd', 'unit_cost_usd', 'refunded_usd'],
  },
] as const;

export type Statement = { label: string; sql: string };

/** A source's row view body: its REST table's items, every column by name. Part of a row read's query hash. */
export function rowViewBody(view: (typeof V2_TABLES)[number]['view']): string {
  const t = V2_TABLES.find((x) => x.view === view);
  if (!t) throw new Error(`no version 2 row view named ${view}`);
  return `SELECT ${t.cols.map((c) => `item.${c}`).join(', ')} FROM ${t.db.toLowerCase()}.${t.table} LATERAL VIEW explode(data) AS item`;
}

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
      sql: `CREATE SCHEMASTORE VIEW ${t.view} WITH CONTAINER ${CONTAINER_V2} AS ${rowViewBody(t.view)}`,
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
