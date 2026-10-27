import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RowRead } from '@fahq/contracts';
import { createZetarisDataPort } from '../src/index.ts';
import { CATALOG_V2, divisionIds, seriesHashText, seriesOf, seriesQuery } from '../src/divisions.ts';
import { computeLayers } from '../src/layers.ts';
import { ROW_CAP, checkRowRead, oracleRows, rowHashText, rowQuery, rowSql } from '../src/rows.ts';
import { generateYear } from '../src/synthetic.ts';

// The rows behind the standing numbers, and one metric over the year. The oracle's rows are checked against the
// metrics (computed independently, from the metric definitions); the port is checked with a FAKE Zetaris that
// answers with the oracle's rows as strings. The live proof of SQL against TypeScript is in scripts/zetaris-setup.ts.

const year = generateYear();
const layers = computeLayers(year);
const standing = (id: string) => layers.standing.get(id) ?? 0;
const mtd = (id: string) => layers.period.get('2026-10-mtd')!.get(id) ?? 0;
const env = { ZETARIS_ORG_ID: '7', ZETARIS_API_KEY: 'test-key', ZETARIS_REST_URL: 'http://zetaris.test/api/v1.0', FAHQ_DATA_VERSION: '2' } as NodeJS.ProcessEnv;
const asOf = '2026-10-27T12:00:00.000Z';

const READS: RowRead[] = [
  { table: 'repairs', status: 'open' }, { table: 'repairs', status: 'late' }, { table: 'repairs', status: 'done' },
  { table: 'invoices', status: 'open' }, { table: 'invoices', status: 'overdue', business: 'online' }, { table: 'invoices', status: 'due_30d' },
  { table: 'waiting', olderThanHours: 0 }, { table: 'low_stock' },
  { table: 'marketplace_stock', status: 'all' }, { table: 'marketplace_stock', status: 'low', marketplace: 'walmart' },
  { table: 'products', period: '2026-09', sort: 'best' }, { table: 'products', period: '2026-10-mtd', sort: 'worst' },
  { table: 'return_cases', period: '2026-09' }, { table: 'return_cases', period: '2026-10-mtd' },
  { table: 'journey', period: '2026-09' }, { table: 'journey', period: '2026-10-mtd' },
];

/** Zetaris's answer to a read: the oracle's rows (before any after-read filter) as strings in column order, '' for NULL. */
function answer(read: RowRead): string[][] {
  const all = read.table === 'waiting' ? { ...read, olderThanHours: 0 } : read;
  const q = rowQuery(all);
  return oracleRows(year, all).rows.map((r) => q.cols.map((c) => (r[c.key] === null ? '' : String(r[c.key]))));
}

function portAnswering(respond: (sql: string) => string[][]) {
  const asked: string[] = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    const sql = JSON.parse(String(init?.body)).sql as string;
    asked.push(sql);
    return new Response(JSON.stringify({ data: respond(sql) }));
  }) as typeof fetch;
  return { port: createZetarisDataPort(env, { fetch: fetchFn, ensureSources: async () => {} }), asked };
}

describe('row reads: the rows behind the standing numbers', () => {
  it('count exactly what the standing and month-so-far numbers count', () => {
    const totals = (read: RowRead) => oracleRows(year, read).totals as Record<string, any>;
    expect(totals({ table: 'repairs', status: 'open' }).count).toBe(standing('m:salon.repairs.open.count'));
    expect(totals({ table: 'repairs', status: 'late' }).count).toBe(standing('m:salon.repairs.open_over_14d.count'));
    expect(totals({ table: 'repairs', status: 'late' }).count).toBeGreaterThan(0);
    for (const b of ['salon', 'online'] as const) {
      expect(totals({ table: 'invoices', status: 'open' })[b].amountUsd).toBeCloseTo(standing(`m:${b}.ap.open`), 2);
      expect(totals({ table: 'invoices', status: 'overdue', business: b })[b]).toEqual({ count: standing(`m:${b}.ap.overdue.count`), amountUsd: expect.closeTo(standing(`m:${b}.ap.overdue`), 2) });
      expect(totals({ table: 'invoices', status: 'due_30d' })[b].amountUsd).toBeCloseTo(standing(`m:${b}.ap.due_30d`), 2);
    }
    expect(totals({ table: 'waiting', olderThanHours: 0 }).count).toBe(standing('m:online.service.waiting_now.count'));
    expect(totals({ table: 'waiting', olderThanHours: 24 }).count).toBe(standing('m:online.service.waiting_over_24h.count'));
    expect(totals({ table: 'low_stock' })).toEqual({
      count: mtd('m:online.inventory.low_stock.count'), wanted: mtd('m:online.inventory.wanted_low_stock.count'),
      wantedOutOfStock: mtd('m:online.inventory.wanted_out_of_stock.count'),
    });
  });

  it("count the marketplace warehouses' stock as the standing numbers do: out of stock, low on cover, inbound", () => {
    const totals = (read: RowRead) => oracleRows(year, read).totals as Record<string, number>;
    const all = totals({ table: 'marketplace_stock', status: 'all' });
    expect(all.outOfStock).toBe(standing('m:online.amazon.stock.out.count') + standing('m:online.walmart.stock.out.count'));
    expect(all.lowCover).toBe(standing('m:online.amazon.stock.low_cover.count') + standing('m:online.walmart.stock.low_cover.count'));
    expect(all.inboundUnits).toBe(standing('m:online.marketplace.inbound_units'));
    for (const m of ['amazon', 'walmart'] as const) {
      const low = oracleRows(year, { table: 'marketplace_stock', status: 'low', marketplace: m });
      expect(low.totals).toMatchObject({ count: standing(`m:online.${m}.stock.out.count`) + standing(`m:online.${m}.stock.low_cover.count`), outOfStock: standing(`m:online.${m}.stock.out.count`), lowCover: standing(`m:online.${m}.stock.low_cover.count`) });
      expect(low.rows.every((r) => r.marketplace === m && r.status !== 'ok')).toBe(true);
    }
    const out = oracleRows(year, { table: 'marketplace_stock', status: 'low' }).rows.find((r) => r.status === 'out')!;
    expect(out).toMatchObject({ onHand: 0, daysOfCover: Number(out.units28d) > 0 ? 0 : null });
  });

  it("add each product's money up to the period's numbers, best or worst first", () => {
    for (const period of ['2026-09', '2026-10-mtd'] as const) {
      const at = (id: string) => layers.period.get(period)!.get(id)!;
      const best = oracleRows(year, { table: 'products', period, sort: 'best' });
      const t = best.totals as Record<string, number>;
      expect(t.revenueUsd).toBeCloseTo(at('m:online.revenue.total'), 2);
      expect(t.costUsd).toBeCloseTo(at('m:online.products.cogs'), 2);
      expect(t.losing).toBe(at('m:online.products.negative_margin.count'));
      expect(t.units).toBe(year.online.orderLines.filter((l) => l.units > 0 && l.order_date.slice(0, 7) === period.slice(0, 7)).reduce((s, l) => s + l.units, 0));
      const profits = best.rows.map((r) => Number(r.profitUsd));
      expect(profits).toEqual([...profits].sort((a, b) => b - a));
      const worst = oracleRows(year, { table: 'products', period, sort: 'worst' });
      expect(worst.rows.map((r) => r.sku)).toEqual(best.rows.map((r) => r.sku).reverse());
      expect(worst.totals).toEqual(best.totals);
      for (const r of best.rows) {
        expect(Number(r.profitUsd)).toBeCloseTo(Number(r.revenueUsd) - Number(r.refundsUsd) - Number(r.costUsd), 2);
        expect(r.views7d).toEqual(expect.any(Number));
        // Its rating: every valid review of the product to the data date (wave 2).
        const mine = year.online.reviews.filter((v) => v.sku === r.sku && v.rating >= 1 && v.rating <= 5);
        expect(r.reviews, String(r.sku)).toBe(mine.length);
        expect(r.avgRating, String(r.sku)).toBe(mine.length ? Math.round((mine.reduce((t, v) => t + v.rating, 0) / mine.length) * 100) / 100 : null);
      }
      expect(best.rows.some((r) => r.avgRating !== null)).toBe(true);
    }
  });

  it('give the store journey of a period by source, adding up to the site numbers, most visits first', () => {
    for (const period of ['2026-09', '2026-10-mtd', '2025-12'] as const) {
      const at = (id: string) => layers.period.get(period)!.get(id)!;
      const { rows, totals } = oracleRows(year, { table: 'journey', period });
      const t = totals as Record<string, number>;
      expect(rows.map((r) => r.source).sort()).toEqual(['direct', 'email', 'google', 'meta', 'organic', 'social']);
      expect(t.sessions).toBe(at('m:online.web.sessions'));
      expect(t.orders).toBe(at('m:online.orders.count'));
      expect(t.cartRate).toBe(at('m:online.web.cart_rate'));
      expect(t.conversionRate).toBe(at('m:online.web.conversion_rate'));
      const sessions = rows.map((r) => Number(r.sessions));
      expect(sessions).toEqual([...sessions].sort((a, b) => b - a));
      for (const r of rows) {
        expect(Number(r.orders)).toBeLessThanOrEqual(Number(r.checkouts));
        expect(Number(r.checkouts)).toBeLessThanOrEqual(Number(r.carts));
        expect(r.conversionRate).toBe(Math.round((Number(r.orders) / Number(r.sessions)) * 10_000) / 10_000);
      }
    }
  });

  it("list each refund of the period with its customer's year, reviews and messages, adding up to the refund numbers", () => {
    let repeatSeen = 0;
    for (const period of ['2026-09', '2026-10-mtd', '2026-03'] as const) {
      const at = (id: string) => layers.period.get(period)!.get(id)!;
      const { rows, totals } = oracleRows(year, { table: 'return_cases', period });
      const t = totals as { count: number; amountUsd: number; repeatCustomers: number; byReason: Record<string, number>; amountByReason: Record<string, number> };
      expect(t.count).toBe(at('m:online.refunds.count'));
      expect(t.amountUsd).toBeCloseTo(at('m:online.refunds.total'), 2);
      expect(Object.values(t.byReason).reduce((s, n) => s + n, 0)).toBe(t.count);
      expect(Object.values(t.amountByReason).reduce((s, n) => s + n, 0)).toBeCloseTo(t.amountUsd, 2);
      expect(t.repeatCustomers).toBeLessThanOrEqual(standing('m:online.returns.repeat_customers.count'));
      repeatSeen += t.repeatCustomers;
      for (const r of rows) {
        // Counted again straight from the rows, for this customer.
        const order = year.online.orders.find((o) => o.order_id === r.orderId)!;
        expect(r.customerId).toBe(order.customer_id);
        expect(r.daysAfterSale).toBe((Date.parse(String(r.refundDate)) - Date.parse(order.order_date)) / 86_400_000);
        expect(r.skus).toBe([...new Set(year.online.orderLines.filter((l) => l.order_id === r.orderId).map((l) => l.sku))].sort().join(','));
        const reviews = year.online.reviews.filter((v) => v.customer_id === r.customerId && v.rating >= 1 && v.rating <= 5);
        expect(r.reviews).toBe(reviews.length);
        expect(r.lowestRating).toBe(reviews.length ? Math.min(...reviews.map((v) => v.rating)) : null);
        const messages = year.support.messages.filter((m) => m.customer_id === r.customerId && m.direction === 'inbound' && m.message_id !== 'demo-msg-bad-reply');
        expect(r.messages).toBe(messages.length);
        expect(r.messageTopics).toBe(messages.length ? [...new Set(messages.map((m) => m.intent))].sort().join(',') : null);
        const year365 = year.online.refunds.filter((f) => f.customer_id === r.customerId && f.amount_usd > 0 && f.refund_date >= '2025-10-27' && f.refund_date <= '2026-10-26');
        expect(r.refunds365d).toBe(year365.length);
      }
      expect(rows.map((r) => `${r.refundDate}|${r.refundId}`)).toEqual(rows.map((r) => `${r.refundDate}|${r.refundId}`).sort());
    }
    expect(repeatSeen).toBeGreaterThan(0);
  });

  it('keep money per business: an invoice read for one business has only its total, a read for both has two', () => {
    const one = oracleRows(year, { table: 'invoices', status: 'open', business: 'salon' });
    expect(Object.keys(one.totals)).toEqual(['salon']);
    expect(one.rows.every((r) => r.business === 'salon')).toBe(true);
    expect(Object.keys(oracleRows(year, { table: 'invoices', status: 'open' }).totals)).toEqual(['salon', 'online']);
  });

  it('never return a planted bad row, a customer (but as a synthetic id where a read asks for one), a message text or a name', () => {
    for (const read of READS) {
      const { rows } = oracleRows(year, read);
      for (const r of rows) {
        // The return cases name each refund's customer by a synthetic id only (docs/wave2.md, item 4).
        const { customerId, ...rest } = r;
        if (read.table === 'return_cases') expect(customerId).toMatch(/^demo-cu-[a-z]\d{5}$/);
        else expect(customerId).toBeUndefined();
        expect(JSON.stringify(rest)).not.toMatch(/-bad-|customer|demo-oc-|demo-sc-|demo-cu-/);
        for (const key of Object.keys(rest)) expect(key).not.toMatch(/body|text|subject|name|customer|phone|email/i);
      }
    }
    expect(oracleRows(year, { table: 'waiting', olderThanHours: 0 }).rows[0]).toEqual(expect.objectContaining({ threadId: expect.stringMatching(/^demo-th-/) }));
  });

  it('build their SQL only from fixed conditions: the data-quality rule, a fixed filter, columns by position', () => {
    const sql = rowSql(rowQuery({ table: 'invoices', status: 'overdue', business: 'online' }));
    expect(sql).toMatch(/^SELECT invoice_id AS c0, .* FROM fortune_hq_v2\.finance_invoices WHERE \(amount_usd > 0 AND .*\) AND paid_date IS NULL AND due_date < '2026-10-26' AND business = 'online' ORDER BY c5, c0$/);
    expect(rowSql(rowQuery({ table: 'low_stock' }))).toMatch(/ORDER BY c4 DESC, c0$/);
    // "Older than" is applied to the rows after the read, never written into the SQL.
    expect(rowSql(rowQuery({ table: 'waiting', olderThanHours: 24 }))).toBe(rowSql(rowQuery({ table: 'waiting', olderThanHours: 3 })));
  });

  it('refuse anything off the fixed lists, with a plain reason', () => {
    const bad = (read: unknown) => () => checkRowRead(read as RowRead);
    expect(bad({ table: 'repairs', status: "open' OR 1=1 --" })).toThrow('status must be one of open, late, done');
    expect(bad({ table: 'invoices', status: 'open', business: 'combined' })).toThrow('business must be salon or online');
    expect(bad({ table: 'waiting', olderThanHours: -1 })).toThrow('olderThanHours must be from 0 to 720');
    expect(bad({ table: 'waiting', olderThanHours: Number.NaN })).toThrow('olderThanHours');
    expect(bad({ table: 'customers' })).toThrow('row read "customers": there is no such row table');
    expect(bad({ table: 'marketplace_stock', status: 'some' })).toThrow('status must be one of all, low');
    expect(bad({ table: 'marketplace_stock', status: 'all', marketplace: 'ebay' })).toThrow('marketplace must be amazon or walmart');
    expect(bad({ table: 'products', period: "2026-09' OR '1'='1", sort: 'best' })).toThrow('period must be one of');
    expect(bad({ table: 'products', period: '2026-09', sort: 'top' })).toThrow('sort must be best or worst');
    expect(bad({ table: 'return_cases', period: "2026-09' --" })).toThrow('period must be one of');
    expect(bad({ table: 'journey', period: '2026' })).toThrow('period must be one of');
    expect(rowSql(rowQuery({ table: 'journey', period: '2026-09' }))).toMatch(/visit_date BETWEEN '2026-09-01' AND '2026-09-30' GROUP BY source ORDER BY c1 DESC, c0$/);
    expect(rowSql(rowQuery({ table: 'return_cases', period: '2026-09' }))).toMatch(/refund_date BETWEEN '2026-09-01' AND '2026-09-30'.* refund_date BETWEEN '2025-10-27' AND '2026-10-26'.* ORDER BY c6, c0$/);
    // The products read takes its period from the fixed list, and its order is one of two.
    expect(rowSql(rowQuery({ table: 'products', period: '2026-09', sort: 'worst' }))).toMatch(/order_date BETWEEN '2026-09-01' AND '2026-09-30'.* snapshot_date = '2026-09-30'.* ORDER BY c6, c0$/);
    expect(rowSql(rowQuery({ table: 'products', period: '2026-09', sort: 'best' }))).toMatch(/ORDER BY c6 DESC, c0$/);
    expect(checkRowRead({ table: 'invoices', status: 'open', extra: 'x' } as never)).toEqual({ table: 'invoices', status: 'open' });
  });
});

describe('DataPort row reads (version 2)', () => {
  it('returns the rows and totals of each read, with the view and a hash over the row view and the statement', async () => {
    for (const read of READS) {
      const { port, asked } = portAnswering(() => answer(read));
      const r = await port.readRows!({ ...read, asOf });
      const q = rowQuery(read);
      expect(asked).toEqual([rowSql(q)]);
      expect(r.rows).toEqual(oracleRows(year, read).rows);
      expect(r.totals).toEqual(oracleRows(year, read).totals);
      expect(r).toMatchObject({ table: read.table, dataDate: '2026-10-26', view: `fortune_hq_v2.${q.view}` });
      expect(r.queryHash).toBe(createHash('sha256').update(rowHashText(q)).digest('hex'));
    }
  });

  it('applies "older than" to the rows it read: the same statement, fewer rows', async () => {
    const { port, asked } = portAnswering(() => answer({ table: 'waiting', olderThanHours: 0 }));
    const all = await port.readRows!({ table: 'waiting', olderThanHours: 0, asOf });
    const old = await port.readRows!({ table: 'waiting', olderThanHours: 24, asOf });
    expect(asked[0]).toBe(asked[1]);
    expect(old.rows.length).toBeLessThan(all.rows.length);
    expect(old.rows.every((r) => Number(r.waitingMinutes) > 24 * 60)).toBe(true);
    expect(old.totals.count).toBe(standing('m:online.service.waiting_over_24h.count'));
  });

  it('refuses a read too large to return whole, a non-numeric amount, and a bad read before asking Zetaris', async () => {
    const many = Array.from({ length: ROW_CAP + 1 }, () => answer({ table: 'repairs', status: 'open' })[0]!);
    await expect(portAnswering(() => many).port.readRows!({ table: 'repairs', status: 'open', asOf })).rejects.toThrow(`more than ${ROW_CAP} rows match repairs`);
    const broken = answer({ table: 'repairs', status: 'open' }).map((r) => r.map((v, i) => (i === 7 ? 'n/a' : v)));
    await expect(portAnswering(() => broken).port.readRows!({ table: 'repairs', status: 'open', asOf })).rejects.toThrow('non-numeric quoteUsd');
    const { port, asked } = portAnswering(() => []);
    await expect(port.readRows!({ table: 'repairs', status: 'all' as never, asOf })).rejects.toThrow('status must be one of');
    expect(asked).toEqual([]);
    expect((await port.readRows!({ table: 'repairs', status: 'late', asOf })).totals).toEqual({ count: 0, quoteUsd: 0, costUsd: 0 });
  });

  it('is not offered by a version 1 port', () => {
    const v1 = createZetarisDataPort({ ...env, FAHQ_DATA_VERSION: '1' }, { ensureSources: async () => {} });
    expect(v1.readRows).toBeUndefined();
    expect(v1.getMetricSeries).toBeUndefined();
  });
});

describe('DataPort metric series (version 2)', () => {
  const fromOracle = (sql: string) => {
    const id = /metric_id = '([^']+)'$/.exec(sql)![1]!;
    return seriesOf(layers, id).reverse().map((p) => [p.period, String(p.value)]);
  };

  it("reads one metric over the year from the division's own mart, oldest first, with its range and yearly mean", async () => {
    const { port, asked } = portAnswering(fromOracle);
    const s = await port.getMetricSeries!({ division: 'finance', metricId: 'm:online.revenue.total', asOf });
    const q = seriesQuery('finance', 'm:online.revenue.total');
    expect(asked).toEqual([q.sql]);
    expect(q.sql).toBe("SELECT period, value FROM fortune_demo_v2_finance_mart.period_metrics WHERE metric_id = 'm:online.revenue.total'");
    expect(s.points.map((p) => p.period)).toEqual([...layers.period.keys()]);
    expect(s).toMatchObject({ label: 'Online revenue, all lines, after discounts', unit: 'usd', business: 'online', view: q.table });
    expect(s.queryHash).toBe(createHash('sha256').update(seriesHashText('finance', q)).digest('hex'));
    const values = s.points.map((p) => p.value);
    expect(s.stats.min).toBe(Math.min(...values));
    expect(s.stats.max).toBe(Math.max(...values));
    // The yearly mean is the season index's denominator: a whole month over it is that month's index.
    const september = layers.derived.get('2026-09')!.get('m:online.season.month_index')!;
    expect(s.points.find((p) => p.period === '2026-09')!.value / s.stats.mean12!).toBeCloseTo(september, 3);
  });

  it('reads a derived metric from the derived table, and gives the month so far no part in the yearly mean', async () => {
    const { port } = portAnswering(fromOracle);
    const s = await port.getMetricSeries!({ division: 'finance', metricId: 'm:online.budget.google.room', asOf });
    expect(s.view).toBe('fortune_demo_v2_finance_mart.derived_metrics');
    expect(s.points).toEqual(seriesOf(layers, 'm:online.budget.google.room'));
    const whole = s.points.filter((p) => p.period !== '2026-10-mtd').map((p) => p.value);
    expect(s.stats.mean12).toBeCloseTo(whole.reduce((t, v) => t + v, 0) / whole.length, 2);
  });

  it('refuses an id the division does not read, a standing number, an unknown division, and a bad answer', async () => {
    const { port, asked } = portAnswering(fromOracle);
    await expect(port.getMetricSeries!({ division: 'online', metricId: 'm:salon.revenue.total', asOf })).rejects.toThrow('the online division does not read a metric "m:salon.revenue.total"');
    await expect(port.getMetricSeries!({ division: 'salon', metricId: "m:salon.revenue.total' OR '1'='1", asOf })).rejects.toThrow('does not read');
    await expect(port.getMetricSeries!({ division: 'salon', metricId: 'm:salon.repairs.open.count', asOf })).rejects.toThrow('standing number');
    await expect(port.getMetricSeries!({ division: 'ops' as never, metricId: 'm:salon.revenue.total', asOf })).rejects.toThrow('unknown division "ops"');
    expect(asked).toEqual([]);
    await expect(portAnswering(() => [['2026-09', '1'], ['2026-09', '2']]).port.getMetricSeries!({ division: 'salon', metricId: 'm:salon.revenue.total', asOf })).rejects.toThrow('a period twice');
    await expect(portAnswering(() => [['2027-01', '1']]).port.getMetricSeries!({ division: 'salon', metricId: 'm:salon.revenue.total', asOf })).rejects.toThrow('unknown period');
    await expect(portAnswering(() => []).port.getMetricSeries!({ division: 'salon', metricId: 'm:salon.revenue.total', asOf })).rejects.toThrow('no values');
  });

  it('can ask every period and derived id a division reads, and none of its standing ones', () => {
    for (const division of ['salon', 'finance', 'online', 'hq'] as const) {
      for (const id of [...divisionIds(division, 'period'), ...divisionIds(division, 'derived')]) expect(() => seriesQuery(division, id)).not.toThrow();
      for (const id of divisionIds(division, 'standing')) expect(() => seriesQuery(division, id)).toThrow('standing');
    }
    expect(CATALOG_V2.length).toBeGreaterThan(100);
  });
});
