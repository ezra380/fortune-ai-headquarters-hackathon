import type { Division } from '@fahq/contracts';
import type { MetricDef } from './finance-sql.ts';
import { counted, isNull, num, oneOf, qualified, quoted, type Cond, type Field, type Row, type SourceSpec } from './sql.ts';
import { AS_OF, EMAIL_NAMES, MARKETPLACES, PRODUCT_LINES } from './synthetic.ts';

// The channels wave 2 adds for Finance (docs/wave2.md, items 1 to 3), each its own source with its data-quality rule
// and a rejected-rows metric: Amazon's and Walmart's sales, fees, Walmart's ads and both warehouses' stock; the
// email rows split into flows and campaigns; the store orders split into their lines, so each product's money is
// known. The email split and the order lines re-divide rows other sources already count, so their numbers add up
// to the existing ones exactly (tests). Who reads what keeps the asks of docs/wave2.md: the marketplace numbers
// are Finance's and HQ's (Online asks George for the stock), the product numbers Online's and HQ's apart from the
// cost of goods (Finance asks Georgette).

export const CHANNEL_SOURCE_NAMES = ['marketplace_sales', 'marketplace_ads', 'marketplace_stock', 'email_messages', 'order_lines'] as const;
export type ChannelSource = (typeof CHANNEL_SOURCE_NAMES)[number];

const str = (r: Row, k: string) => String(r[k]);
const startsWith = (r: Row, k: string, prefix: string) => !isNull(r[k]) && str(r, k).startsWith(prefix);
const atLeastZero = (r: Row, keys: readonly string[]) => keys.every((k) => num(r, k) >= 0);

export const CHANNEL_SOURCES: Record<ChannelSource, SourceSpec> = {
  marketplace_sales: {
    table: 'marketplace_sales', date: 'sale_date',
    validSql: `units > 0 AND revenue_usd >= 0 AND fees_usd >= 0 AND marketplace IN (${quoted(MARKETPLACES)}) AND sku LIKE 'demo-sku-%'`,
    valid: (r) => num(r, 'units') > 0 && atLeastZero(r, ['revenue_usd', 'fees_usd']) && oneOf(MARKETPLACES, r.marketplace) && startsWith(r, 'sku', 'demo-sku-'),
  },
  marketplace_ads: {
    table: 'marketplace_ads', date: 'ad_date',
    validSql: "spend_usd >= 0 AND clicks >= 0 AND conversions >= 0 AND revenue_usd >= 0 AND channel = 'walmart'",
    valid: (r) => atLeastZero(r, ['spend_usd', 'clicks', 'conversions', 'revenue_usd']) && r.channel === 'walmart',
  },
  marketplace_stock: {
    table: 'marketplace_stock', date: 'snapshot_date',
    validSql: `on_hand >= 0 AND inbound >= 0 AND units_28d >= 0 AND marketplace IN (${quoted(MARKETPLACES)}) AND sku LIKE 'demo-sku-%'`,
    valid: (r) => atLeastZero(r, ['on_hand', 'inbound', 'units_28d']) && oneOf(MARKETPLACES, r.marketplace) && startsWith(r, 'sku', 'demo-sku-'),
  },
  email_messages: {
    table: 'marketing_email_messages', date: 'send_date',
    validSql: `sends >= 0 AND revenue_usd >= 0 AND unsubscribes >= 0 AND unsubscribes <= sends AND kind IN ('flow', 'campaign') AND name IN (${quoted(EMAIL_NAMES)}) AND email_id LIKE 'demo-em-%'`,
    valid: (r) => atLeastZero(r, ['sends', 'revenue_usd', 'unsubscribes']) && num(r, 'unsubscribes') <= num(r, 'sends') && oneOf(['flow', 'campaign'], r.kind)
      && oneOf(EMAIL_NAMES, r.name) && startsWith(r, 'email_id', 'demo-em-'),
  },
  order_lines: {
    table: 'online_order_lines', date: 'order_date',
    // A line never carries more refund than it sold for.
    validSql: `units > 0 AND price_usd >= 0 AND unit_cost_usd >= 0 AND refunded_usd >= 0 AND refunded_usd <= units * price_usd AND order_id LIKE 'demo-o-%' AND sku LIKE 'demo-sku-%' AND product_line IN (${quoted(PRODUCT_LINES)})`,
    valid: (r) => num(r, 'units') > 0 && atLeastZero(r, ['price_usd', 'unit_cost_usd', 'refunded_usd']) && num(r, 'refunded_usd') <= num(r, 'units') * num(r, 'price_usd')
      && startsWith(r, 'order_id', 'demo-o-') && startsWith(r, 'sku', 'demo-sku-') && oneOf(PRODUCT_LINES, r.product_line),
  },
};

// ---- Fields and conditions ----------------------------------------------------------------

type Expr = Exclude<Field, string>;
/** A line's revenue, cost, and what it made once its refunds are taken off (a returned piece's cost is not added back). */
export const LINE_REVENUE: Expr = { sql: '(units * price_usd)', js: (r) => num(r, 'units') * num(r, 'price_usd') };
export const LINE_COST: Expr = { sql: '(units * unit_cost_usd)', js: (r) => num(r, 'units') * num(r, 'unit_cost_usd') };
export const LINE_PROFIT: Expr = {
  sql: '(units * price_usd - refunded_usd - units * unit_cost_usd)', js: (r) => num(r, 'units') * num(r, 'price_usd') - num(r, 'refunded_usd') - num(r, 'units') * num(r, 'unit_cost_usd'),
};
/** Marketplace stock: none on hand, or in stock with under three weeks of cover at the last 28 days' pace (never both). */
export const COVER_DAYS = 21;
export const STOCK_OUT: Cond = { sql: 'on_hand = 0', js: (r) => num(r, 'on_hand') === 0 };
export const LOW_COVER: Cond = {
  sql: `on_hand > 0 AND on_hand * 28 < ${COVER_DAYS} * units_28d`, js: (r) => num(r, 'on_hand') > 0 && num(r, 'on_hand') * 28 < COVER_DAYS * num(r, 'units_28d'),
};
/** Standing stock numbers read the data date's snapshot only. */
const ON_THE_DATA_DATE = { from: AS_OF, to: AS_OF } as const;

// ---- Metrics ------------------------------------------------------------------------------

const ROWS = ['row', 'rows'] as const;
const ORDERS = ['order', 'orders'] as const;
const LISTED = ['listing', 'listings', 'product', 'products'] as const;
const EMAILS = ['email', 'emails'] as const;
const FINANCE_HQ: readonly Division[] = ['finance', 'hq'];
const ONLINE_MONEY: readonly Division[] = ['online', 'finance'];
const NAME = { amazon: 'Amazon', walmart: 'Walmart' } as const;
const WALMART_AD = { divisions: ONLINE_MONEY, source: 'marketplace_ads', where: { channel: 'walmart' } } as const;

type Def = Omit<MetricDef, 'layer' | 'since' | 'business'>;
const ofLayer = (layer: MetricDef['layer']) => (d: Def): MetricDef => ({ business: 'online', ...d, layer, since: 2 });
const period = ofLayer('period');
const standing = ofLayer('standing');

/** Period totals of the channels. */
export const CHANNEL_METRICS: MetricDef[] = [
  // Amazon and Walmart: what each marketplace sold from its warehouse and kept in fees. Not the store's revenue.
  ...MARKETPLACES.flatMap((m): MetricDef[] => {
    const mine = { divisions: FINANCE_HQ, source: 'marketplace_sales', where: { marketplace: m } } as const;
    return [
      period({ id: `m:online.${m}.revenue`, label: `${NAME[m]} marketplace sales`, unit: 'usd', ...mine, agg: { kind: 'sum', field: 'revenue_usd' }, about: `Orders sold and shipped from ${NAME[m]}'s warehouse, by the order day; not part of the online store's revenue.` }),
      period({ id: `m:online.${m}.orders.count`, label: `${NAME[m]} marketplace orders`, unit: 'count', ...mine, agg: { kind: 'count' }, nouns: qualified(ORDERS, [`${m} marketplace`]) }),
      period({ id: `m:online.${m}.fees`, label: `${NAME[m]} marketplace fees (referral and warehouse)`, unit: 'usd', ...mine, agg: { kind: 'sum', field: 'fees_usd' }, about: 'The referral fee and the warehouse fee per unit the marketplace kept from those orders.' }),
    ];
  }),
  period({ id: 'm:online.dq.rejected_marketplace_sales', label: 'Marketplace sale rows rejected by data checks', unit: 'count', divisions: FINANCE_HQ, source: 'marketplace_sales', agg: { kind: 'rejected' }, nouns: counted(ROWS, ['marketplace sale', 'marketplace order']) }),
  // Walmart's own ads, like the Google family (Amazon's have been among the marketing ads since version 1).
  period({ id: 'm:online.ads.walmart.spend', label: 'Walmart ad spend', unit: 'usd', ...WALMART_AD, agg: { kind: 'sum', field: 'spend_usd' }, about: 'Not in the all-channel ad spend, the revenue per ad dollar or the contribution, which cover Google, Meta and Amazon.' }),
  period({ id: 'm:online.ads.walmart.revenue', label: 'Walmart ad revenue', unit: 'usd', ...WALMART_AD, agg: { kind: 'sum', field: 'revenue_usd' } }),
  period({ id: 'm:online.ads.walmart.roas', label: 'Walmart ad return (revenue / spend)', unit: 'ratio', ...WALMART_AD, agg: { kind: 'ratio', num: 'revenue_usd', den: 'spend_usd' } }),
  period({ id: 'm:online.ads.walmart.conversions', label: 'Walmart ad orders', unit: 'count', ...WALMART_AD, agg: { kind: 'sum', field: 'conversions' }, nouns: qualified(ORDERS, ['walmart ad']) }),
  period({ id: 'm:online.dq.rejected_marketplace_ads', label: 'Walmart ad rows rejected by data checks', unit: 'count', divisions: ['online', 'finance', 'hq'], source: 'marketplace_ads', agg: { kind: 'rejected' }, nouns: counted(ROWS, ['walmart ad']) }),
  period({ id: 'm:online.dq.rejected_marketplace_stock', label: 'Marketplace stock rows rejected by data checks', unit: 'count', divisions: FINANCE_HQ, source: 'marketplace_stock', agg: { kind: 'rejected' }, nouns: counted(ROWS, ['marketplace stock', 'stock report']) }),
  // The email rows split by flow and campaign: the sends add up to the emails sent, the revenue to the email revenue.
  period({ id: 'm:online.email.flow.sends', label: 'Flow emails sent', unit: 'count', divisions: ONLINE_MONEY, source: 'email_messages', agg: { kind: 'sum', field: 'sends' }, where: { kind: 'flow' }, nouns: qualified(EMAILS, ['flow']) }),
  period({ id: 'm:online.email.campaign.sends', label: 'Campaign emails sent', unit: 'count', divisions: ONLINE_MONEY, source: 'email_messages', agg: { kind: 'sum', field: 'sends' }, where: { kind: 'campaign' }, nouns: qualified(EMAILS, ['campaign']) }),
  period({ id: 'm:online.email.flow.revenue', label: 'Flow email revenue', unit: 'usd', divisions: ONLINE_MONEY, source: 'email_messages', agg: { kind: 'sum', field: 'revenue_usd' }, where: { kind: 'flow' } }),
  period({ id: 'm:online.email.campaign.revenue', label: 'Campaign email revenue', unit: 'usd', divisions: ONLINE_MONEY, source: 'email_messages', agg: { kind: 'sum', field: 'revenue_usd' }, where: { kind: 'campaign' } }),
  period({ id: 'm:online.email.campaign.count', label: 'Email campaigns sent', unit: 'count', divisions: ONLINE_MONEY, source: 'email_messages', agg: { kind: 'count' }, where: { kind: 'campaign' }, nouns: counted(['campaign', 'campaigns'], ['email']) }),
  period({ id: 'm:online.email.unsubscribe_rate', label: 'Email unsubscribes over emails sent', unit: 'ratio', divisions: ONLINE_MONEY, source: 'email_messages', agg: { kind: 'ratio', num: 'unsubscribes', den: 'sends' } }),
  period({ id: 'm:online.dq.rejected_email_messages', label: 'Email message rows rejected by data checks', unit: 'count', divisions: ['online', 'finance', 'hq'], source: 'email_messages', agg: { kind: 'rejected' }, nouns: counted(ROWS, ['email message', 'email']) }),
  // The store orders' lines: the cost of what was sold (it adds up to the orders' cost) and the products that lost money.
  period({ id: 'm:online.products.cogs', label: 'Cost of the store products sold', unit: 'usd', divisions: ONLINE_MONEY, source: 'order_lines', agg: { kind: 'sum', field: LINE_COST }, about: 'From the order lines, by order date; it adds up to the cost on the store orders.' }),
  period({
    id: 'm:online.products.negative_margin.count', label: 'Store products that lost money after refunds', unit: 'count', divisions: ['online', 'hq'], source: 'order_lines',
    agg: { kind: 'losing', by: 'sku', field: LINE_PROFIT }, nouns: qualified(['product', 'products'], ['money-losing', 'losing', 'loss-making']),
    about: "Products whose order lines in the period brought in less than they cost once the refunds on those orders, to the data date, are taken off. A returned piece's cost is not added back.",
  }),
  period({ id: 'm:online.dq.rejected_order_lines', label: 'Order line rows rejected by data checks', unit: 'count', divisions: ['online', 'finance', 'hq'], source: 'order_lines', agg: { kind: 'rejected' }, nouns: counted(ROWS, ['order line', 'line']) }),
];

/** Standing numbers of the channels: each marketplace warehouse's stock on the data date. */
export const CHANNEL_STANDING: MetricDef[] = [
  ...MARKETPLACES.flatMap((m): MetricDef[] => {
    const mine = { divisions: FINANCE_HQ, source: 'marketplace_stock', where: { marketplace: m }, agg: { kind: 'count' }, window: ON_THE_DATA_DATE } as const;
    return [
      standing({
        id: `m:online.${m}.stock.low_cover.count`, label: `${NAME[m]} warehouse listings running low`, unit: 'count', ...mine, test: LOW_COVER,
        nouns: qualified(LISTED, [`${m} low-cover`, `${m} low cover`]),
        about: `In stock at ${NAME[m]}'s warehouse on the data date, ${AS_OF}, with fewer than ${COVER_DAYS} days of cover at the last 28 days' pace. Out of stock is counted on its own.`,
      }),
      standing({
        id: `m:online.${m}.stock.out.count`, label: `${NAME[m]} warehouse listings out of stock`, unit: 'count', ...mine, test: STOCK_OUT,
        nouns: qualified(LISTED, [`${m} out-of-stock`, `${m} sold-out`]),
        about: `None on hand at ${NAME[m]}'s warehouse on the data date, ${AS_OF}.`,
      }),
    ];
  }),
  standing({
    id: 'm:online.marketplace.inbound_units', label: 'Units on their way to the marketplace warehouses', unit: 'count', divisions: FINANCE_HQ, source: 'marketplace_stock',
    agg: { kind: 'sum', field: 'inbound' }, window: ON_THE_DATA_DATE, nouns: counted(['unit', 'units'], ['inbound', 'incoming']),
    about: `Amazon's and Walmart's together, on the data date, ${AS_OF}.`,
  }),
];

/** The oracle's twin of the 'losing' aggregate: how many groups' field adds up below zero (to the cent). */
export function losingGroups(rows: readonly Row[], by: string, field: Field): number {
  const f = typeof field === 'string' ? (r: Row) => num(r, field) : field.js;
  const sums = new Map<string, number>();
  for (const r of rows) sums.set(str(r, by), (sums.get(str(r, by)) ?? 0) + f(r));
  return [...sums.values()].filter((v) => Math.round(v * 100) / 100 < 0).length;
}
