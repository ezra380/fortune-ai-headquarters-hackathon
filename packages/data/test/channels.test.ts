import { createHash } from 'node:crypto';
import { PERIOD_KEYS, type Period } from '@fahq/contracts';
import { describe, expect, it } from 'vitest';
import { CHANNEL_METRICS, CHANNEL_SOURCE_NAMES, CHANNEL_STANDING, COVER_DAYS } from '../src/channels.ts';
import { CUSTOMER_METRICS, CUSTOMER_STANDING } from '../src/customers.ts';
import { WEB_METRICS, WEB_STANDING } from '../src/web.ts';
import { CATALOG_V2, attentionFor } from '../src/divisions.ts';
import { SOURCES, financeViewBody, sourceRows } from '../src/finance-sql.ts';
import { computeLayers, standingViewBody } from '../src/layers.ts';
import { AS_OF, LISTINGS, MARKETPLACES, PERIODS, generateYear } from '../src/synthetic.ts';

// The channels wave 2 adds for Finance (docs/wave2.md, items 1 to 3): each source's data-quality rule and its one
// planted row; the numbers that re-count what other sources already count, added up against them exactly; and the
// oracle's numbers checked against the rows, so the live proof compares Zetaris with something known to be right.

const year = generateYear();
const rows = sourceRows(year);
const layers = computeLayers(year);
const at = (p: Period, id: string) => layers.period.get(p)!.get(id);
const standing = (id: string) => layers.standing.get(id);
const inPeriod = (p: Period, day: string) => day >= PERIODS[p].from && day <= PERIODS[p].to;
const cents = (n: number) => Math.round(n * 100);
const totalCents = (xs: readonly number[]) => xs.reduce((t, x) => t + cents(x), 0);
const rejectedId = (source: string) => CHANNEL_METRICS.find((m) => m.source === source && m.agg.kind === 'rejected')!.id;
const valid = <T extends object>(source: (typeof CHANNEL_SOURCE_NAMES)[number], xs: readonly T[]) => xs.filter((r) => SOURCES[source].valid(r as Record<string, unknown>));
function groupBy<T>(xs: readonly T[], key: (x: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of xs) out.set(key(x), [...(out.get(key(x)) ?? []), x]);
  return out;
}

describe('the channels: data-quality rules', () => {
  it('reject exactly the one planted row of each source, and count it in its own month only', () => {
    for (const source of CHANNEL_SOURCE_NAMES) {
      const all = rows[source];
      const bad = all.filter((r) => String(Object.values(r)[0]).includes('-bad-'));
      expect(bad, source).toHaveLength(1);
      expect(all.filter((r) => !SOURCES[source].valid(r)), source).toEqual(bad);
      const day = String(bad[0]![SOURCES[source].date]);
      const month = PERIOD_KEYS.find((p) => inPeriod(p, day))!;
      for (const p of PERIOD_KEYS) expect(at(p, rejectedId(source)), `${source} ${p}`).toBe(p === month ? 1 : 0);
    }
  });

  it('say in SQL what they say in TypeScript, and the period view reads each source once', () => {
    const body = financeViewBody(2);
    for (const source of CHANNEL_SOURCE_NAMES) {
      expect(body.split(`fortune_hq_v2.${SOURCES[source].table} `).length - 1, source).toBe(1);
      expect(body).toContain(SOURCES[source].validSql);
    }
    // The products that lost money are counted per product first, then per period, in the same one read of the lines.
    expect(body).toContain("END, sku) g_order_lines GROUP BY period");
    expect(body).toContain('COUNT(CASE WHEN ROUND(p');
    expect(standingViewBody().split('FROM fortune_hq_v2.marketplace_stock').length - 1).toBe(1);
  });

  it('serve every new metric in every one of the thirteen periods, and every standing one', () => {
    for (const p of PERIOD_KEYS) for (const m of CHANNEL_METRICS) expect(layers.period.get(p)!.has(m.id), `${m.id} ${p}`).toBe(true);
    for (const m of CHANNEL_STANDING) expect(layers.standing.has(m.id), m.id).toBe(true);
  });
});

describe('every number the base served keeps its value', () => {
  // All 1,224 values of hq/divisions-merge @ 16449bf (period and derived in every period, and standing), computed by
  // running that commit's own code (git archive 16449bf packages/data/src): sha256 of the JSON, keys sorted. Slice 2's
  // customers (new columns on orders, refunds and messages, the reviews) and store site move none of them either.
  it('the channels, the customers and the site add numbers of their own and move none of the others', () => {
    const added = new Set([...CHANNEL_METRICS, ...CHANNEL_STANDING, ...CUSTOMER_METRICS, ...CUSTOMER_STANDING, ...WEB_METRICS, ...WEB_STANDING].map((m) => m.id));
    const flat: Record<string, number> = {};
    for (const layer of ['period', 'derived'] as const) for (const [p, m] of layers[layer]) for (const [id, v] of m) if (!added.has(id)) flat[`${layer}|${p}|${id}`] = v;
    for (const [id, v] of layers.standing) if (!added.has(id)) flat[`standing|${id}`] = v;
    expect(Object.keys(flat)).toHaveLength(1224);
    const sorted = Object.fromEntries(Object.keys(flat).sort().map((k) => [k, flat[k]]));
    expect(createHash('sha256').update(JSON.stringify(sorted)).digest('hex')).toBe('cab17db7b478892a85aba1d0f3f17dfb28aeb90824552c99900e00be9388f621');
  });
});

describe('the email split adds up to the email rows exactly', () => {
  it('each email row: its messages carry its sends and revenue to the cent, under its own name', () => {
    const messages = valid('email_messages', year.marketing.emailMessages);
    const byRow = groupBy(messages, (m) => m.email_id);
    expect(byRow.size).toBe(year.marketing.email.length);
    for (const e of year.marketing.email) {
      const mine = byRow.get(e.email_id)!;
      expect(mine.reduce((t, m) => t + m.sends, 0), e.email_id).toBe(e.sends);
      expect(totalCents(mine.map((m) => m.revenue_usd)), e.email_id).toBe(cents(e.revenue_usd));
      expect(new Set(mine.map((m) => `${m.kind}|${m.name}|${m.send_date}`))).toEqual(new Set([`${e.kind}|${e.name}|${e.send_date}`]));
    }
  });

  it('each period: flow plus campaign sends are the emails sent, and their revenue the email revenue', () => {
    for (const p of PERIOD_KEYS) {
      expect(at(p, 'm:online.email.flow.sends')! + at(p, 'm:online.email.campaign.sends')!, p).toBe(at(p, 'm:online.email.sends'));
      expect(cents(at(p, 'm:online.email.flow.revenue')!) + cents(at(p, 'm:online.email.campaign.revenue')!), p).toBe(cents(at(p, 'm:online.email.revenue')!));
      const campaigns = year.marketing.email.filter((e) => e.kind === 'campaign' && inPeriod(p, e.send_date));
      expect(at(p, 'm:online.email.campaign.count'), p).toBe(campaigns.length);
      const rate = at(p, 'm:online.email.unsubscribe_rate')!;
      expect(rate, p).toBeGreaterThan(0);
      expect(rate, p).toBeLessThan(0.01);
    }
  });
});

describe('the order lines add up to the orders exactly', () => {
  const lines = valid('order_lines', year.online.orderLines);
  const byOrder = groupBy(lines, (l) => l.order_id);
  const orders = year.online.orders.filter((o) => SOURCES.orders.valid(o));

  it("each order: its lines carry its revenue and cost to the cent, its refunds to the data date, and products of its own line", () => {
    expect(byOrder.size).toBe(orders.length);
    const refunds = groupBy(year.online.refunds.filter((r) => SOURCES.refunds.valid(r)), (r) => r.order_id);
    for (const o of orders) {
      const mine = byOrder.get(o.order_id)!;
      expect(mine.reduce((t, l) => t + l.units, 0), o.order_id).toBe(o.units);
      expect(totalCents(mine.map((l) => l.units * l.price_usd)), o.order_id).toBe(cents(o.net_usd));
      expect(totalCents(mine.map((l) => l.units * l.unit_cost_usd)), o.order_id).toBe(cents(o.cost_usd));
      expect(totalCents(mine.map((l) => l.refunded_usd)), o.order_id).toBe(totalCents((refunds.get(o.order_id) ?? []).map((r) => r.amount_usd)));
      expect(new Set(mine.map((l) => l.product_line)), o.order_id).toEqual(new Set([o.product_line]));
      expect(new Set(mine.map((l) => l.sku)).size, o.order_id).toBe(mine.length);
    }
  });

  it("each period: the cost of goods is the orders' cost, and the lines' revenue the online revenue", () => {
    for (const p of PERIOD_KEYS) {
      const theirs = orders.filter((o) => inPeriod(p, o.order_date));
      expect(cents(at(p, 'm:online.products.cogs')!), p).toBe(totalCents(theirs.map((o) => o.cost_usd)));
      const sold = lines.filter((l) => inPeriod(p, l.order_date));
      expect(totalCents(sold.map((l) => l.units * l.price_usd)), p).toBe(cents(at(p, 'm:online.revenue.total')!));
    }
  });

  it('counts the products whose lines lost money after refunds, product by product', () => {
    let seen = 0;
    for (const p of PERIOD_KEYS) {
      const bySku = groupBy(lines.filter((l) => inPeriod(p, l.order_date)), (l) => l.sku);
      const losing = [...bySku.values()].filter((ls) => totalCents(ls.map((l) => l.units * l.price_usd)) - totalCents(ls.map((l) => l.refunded_usd)) - totalCents(ls.map((l) => l.units * l.unit_cost_usd)) < 0);
      expect(at(p, 'm:online.products.negative_margin.count'), p).toBe(losing.length);
      seen += losing.length;
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe('the marketplaces', () => {
  const sales = valid('marketplace_sales', year.marketplace.sales);
  const stock = valid('marketplace_stock', year.marketplace.stock);

  it("total each marketplace's sales, orders and fees from its own rows; the store's revenue does not move", () => {
    for (const m of MARKETPLACES) {
      for (const p of PERIOD_KEYS) {
        const mine = sales.filter((s) => s.marketplace === m && inPeriod(p, s.sale_date));
        expect(at(p, `m:online.${m}.orders.count`), `${m} ${p}`).toBe(mine.length);
        expect(cents(at(p, `m:online.${m}.revenue`)!), `${m} ${p}`).toBe(totalCents(mine.map((s) => s.revenue_usd)));
        expect(cents(at(p, `m:online.${m}.fees`)!), `${m} ${p}`).toBe(totalCents(mine.map((s) => s.fees_usd)));
        expect(mine.length, `${m} ${p}`).toBeGreaterThan(0);
      }
    }
    const store = year.online.orders.filter((o) => SOURCES.orders.valid(o) && inPeriod('2026-09', o.order_date));
    expect(cents(at('2026-09', 'm:online.revenue.total')!)).toBe(totalCents(store.map((o) => o.net_usd)));
  });

  it("keeps the warehouse's 28-day units equal to the sales, on every snapshot", () => {
    for (const s of stock) {
      const from = new Date(Date.parse(`${s.snapshot_date}T00:00:00Z`) - 27 * 86_400_000).toISOString().slice(0, 10);
      const sold = sales.filter((x) => x.marketplace === s.marketplace && x.sku === s.sku && x.sale_date >= from && x.sale_date <= s.snapshot_date);
      expect(s.units_28d, s.stock_id).toBe(sold.reduce((t, x) => t + x.units, 0));
    }
    expect(stock.filter((s) => s.snapshot_date === AS_OF)).toHaveLength(LISTINGS.amazon.length + LISTINGS.walmart.length);
  });

  it('counts, on the data date, the listings out of stock and those under three weeks of cover (never both), and the units inbound', () => {
    const today = stock.filter((s) => s.snapshot_date === AS_OF);
    for (const m of MARKETPLACES) {
      const mine = today.filter((s) => s.marketplace === m);
      const out = mine.filter((s) => s.on_hand === 0);
      const low = mine.filter((s) => s.on_hand > 0 && s.units_28d > 0 && s.on_hand / (s.units_28d / 28) < COVER_DAYS);
      expect(standing(`m:online.${m}.stock.out.count`), m).toBe(out.length);
      expect(standing(`m:online.${m}.stock.low_cover.count`), m).toBe(low.length);
    }
    expect(standing('m:online.amazon.stock.low_cover.count')! + standing('m:online.walmart.stock.low_cover.count')!).toBeGreaterThan(0);
    expect(standing('m:online.amazon.stock.out.count')! + standing('m:online.walmart.stock.out.count')!).toBeGreaterThan(0);
    expect(standing('m:online.marketplace.inbound_units')).toBe(today.reduce((t, s) => t + s.inbound, 0));
    const fired = attentionFor([...layers.standing].map(([id, value]) => ({ id, value }))).filter((a) => /^m:online\.(amazon|walmart)\.stock\./.test(a.metricId));
    expect(new Set(fired.map((a) => a.level))).toEqual(new Set(['act', 'watch']));
  });

  it("totals Walmart's ads like Google's, and leaves the all-channel ad spend as it was", () => {
    const ads = valid('marketplace_ads', year.marketplace.ads);
    for (const p of PERIOD_KEYS) {
      const mine = ads.filter((a) => inPeriod(p, a.ad_date));
      const [spend, revenue] = [totalCents(mine.map((a) => a.spend_usd)), totalCents(mine.map((a) => a.revenue_usd))];
      expect(cents(at(p, 'm:online.ads.walmart.spend')!), p).toBe(spend);
      expect(at(p, 'm:online.ads.walmart.roas'), p).toBeCloseTo(revenue / spend, 4);
      const three = ['google', 'meta', 'amazon'].reduce((t, ch) => t + cents(at(p, `m:online.ads.${ch}.spend`)!), 0);
      expect(cents(layers.derived.get(p)!.get('m:online.ads.total.spend')!), p).toBe(three);
    }
  });
});

describe('the asks of docs/wave2.md: who must not read what', () => {
  const readers = (prefix: RegExp) => CATALOG_V2.filter((m) => prefix.test(m.id));

  it('Online never reads the marketplace stock (Georgette asks George); Finance and HQ do', () => {
    const walled = readers(/^m:online\.((amazon|walmart)\.stock\.|marketplace\.)/);
    expect(walled.length).toBeGreaterThanOrEqual(5);
    for (const m of walled) {
      expect(m.divisions, m.id).not.toContain('online');
      expect(m.divisions, m.id).toEqual(expect.arrayContaining(['finance', 'hq']));
    }
  });

  it("Finance never reads the products' performance apart from their money totals (George asks Georgette)", () => {
    const products = readers(/^m:online\.products\./);
    expect(products.map((m) => m.id)).toEqual(expect.arrayContaining(['m:online.products.cogs', 'm:online.products.negative_margin.count']));
    for (const m of products) {
      expect(m.divisions, m.id).toContain('online');
      if (m.unit !== 'usd') expect(m.divisions, m.id).not.toContain('finance');
    }
    for (const m of readers(/^m:online\.(returns|reviews)\./)) expect(m.divisions, m.id).not.toContain('finance');
  });

  it('Online never reads a salon number', () => {
    expect(readers(/^m:salon\./).length).toBeGreaterThan(0);
    for (const m of readers(/^m:salon\./)) expect(m.divisions, m.id).not.toContain('online');
  });

  // Review fix: this test passed only because no m:salon.clients.* metric exists (items 7 and 8 are not built).
  // `it.fails` keeps the suite green and fails loud the day the segments land: then turn it into `it`.
  it.fails("Finance never reads the salon's client segments (George asks Cindy): NOT BUILT, items 7 and 8", () => {
    const clients = readers(/^m:salon\.clients\./);
    expect(clients.length, 'no m:salon.clients.* metric yet').toBeGreaterThan(0);
    for (const m of clients) expect(m.divisions, m.id).not.toContain('finance');
  });
});

// Review fix: a count's bare noun ("products", "emails", "orders") belongs to the one metric that counts that thing
// in general. The plan checker holds a small number before a metric's phrase to that metric, so a marketplace
// listing count named "products" would hold "bundle 2 products" in a Finance plan to the warehouse counts.
describe('the count phrases: the bare nouns stay with the metric that owns them', () => {
  const BARE = ['product', 'products', 'listing', 'listings', 'order', 'orders', 'email', 'emails'];
  const nounsOf = (id: string) => CATALOG_V2.find((m) => m.id === id)?.nouns ?? [];
  const QUALIFIED_ONLY = [
    ...MARKETPLACES.flatMap((m) => [`m:online.${m}.orders.count`, `m:online.${m}.stock.low_cover.count`, `m:online.${m}.stock.out.count`]),
    'm:online.ads.walmart.conversions', 'm:online.email.flow.sends', 'm:online.email.campaign.sends', 'm:online.products.negative_margin.count',
  ];

  it("names the channels' counts with qualified phrases only", () => {
    for (const id of QUALIFIED_ONLY) {
      expect(nounsOf(id).length, id).toBeGreaterThan(0);
      for (const n of nounsOf(id)) expect(BARE, `${id}: "${n}"`).not.toContain(n);
    }
  });

  it('keeps the bare nouns on the store orders and the emails sent', () => {
    expect(nounsOf('m:online.orders.count')).toEqual(expect.arrayContaining(['order', 'orders']));
    expect(nounsOf('m:online.email.sends')).toEqual(expect.arrayContaining(['email', 'emails']));
  });
});
