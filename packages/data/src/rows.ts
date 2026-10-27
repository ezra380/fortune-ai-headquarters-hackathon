import { PERIOD_KEYS, type RowRead, type RowsData } from '@fahq/contracts';
import { LINE_COST, LINE_PROFIT, LINE_REVENUE, LOW_COVER, STOCK_OUT } from './channels.ts';
import { YEAR_TO_DATE } from './customers.ts';
import { CONTAINER_V2, round, sourceRows, specOf, type Source, type SourceRows } from './finance-sql.ts';
import { FINISHED, STILL_OPEN, UNPAID, clock, days, inDays, moment } from './operations.ts';
import { both, isNull, num, type Cond, type Row } from './sql.ts';
import { AS_OF, AS_OF_END, INVOICE_BUSINESSES, LAST_WEEK, MARKETPLACES, PERIODS, REFUND_REASONS } from './synthetic.ts';
import { rowViewBody } from './zetaris-objects.ts';

// The rows behind the standing numbers (version 2): which repairs are late, which invoices are overdue, which
// messages are waiting, which wanted products are low. Each RowRead is a fixed question: its SQL is built here
// from fixed conditions (the same ones the standing metrics count with), over the source's row view, with the
// source's data-quality rule, so the rows of "late repairs" are exactly the repairs the late count counts.
// Nothing a model or a person types reaches the SQL: a read names a table and a status from a fixed list, and
// "older than N hours" is applied to the rows after the read. The port adds the totals up, so a Code Mode
// script never adds numbers itself (its own sums are refused as untraced). Money totals stay per business.
// Every column is the row's own data: no customer, no message text, no name.

/** The most rows one read returns; a read that matches more is refused, never cut short. */
export const ROW_CAP = 500;
/** "Wanted": at least this many product views in the week before (the inventory metrics' threshold). */
export const WANTED_VIEWS = 40;
/** A finished repair counts as recent when it was finished in the 30 days ending on the data date. */
const RECENT_FROM = inDays(-29);

type Value = string | number | null;
/** A column; `nullable`: a number column that may be empty (NULL), such as the days of cover of a listing that sold nothing. */
type Col = { key: string; sql: string; js: (r: Row) => Value; number: boolean; nullable?: true };
type Out = Record<string, Value>;
type View = Parameters<typeof rowViewBody>[0];

const text = (key: string, col: string): Col => ({ key, sql: col, js: (r) => (isNull(r[col]) ? null : String(r[col])), number: false });
const amount = (key: string, sql: string, js: (r: Row) => number): Col => ({ key, sql, js, number: true });
const column = (key: string, col: string): Col => amount(key, col, (r) => num(r, col));
const str = (r: Row, k: string) => String(r[k]);
const cond = (sql: string, js: (r: Row) => boolean): Cond => ({ sql, js });

/** One fixed question: its source, columns, condition beyond the data-quality rule, order, and how its rows add up. */
type RowQuery = {
  source: Source;
  view: View;
  cols: readonly Col[];
  where: Cond;
  /** Column keys to sort by; a leading '-' sorts high to low. */
  order: readonly string[];
  /** Applied to the typed rows after the read (never in SQL). */
  keep?: (r: Out) => boolean;
  totals: (rows: readonly Out[]) => RowsData['totals'];
  /**
   * A question one row per source row cannot answer (rows added up per product, another row view joined): its own
   * fixed statement, every row view it reads (for the hash), and its TypeScript twin over the valid source rows.
   */
  grouped?: { sql: string; views: readonly View[]; rows: (b: SourceRows) => Out[] };
};

const sumOf = (rows: readonly Out[], key: string) => round(rows.reduce((t, r) => t + Number(r[key]), 0), 2);
const countBy = (rows: readonly Out[], key: string) => {
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r[key])] = (out[String(r[key])] ?? 0) + 1;
  return out;
};

// ---- The four tables ------------------------------------------------------------------------

const STILL_OPEN_OVER_14D = both(STILL_OPEN, cond(`DATEDIFF('${AS_OF}', received_date) > 14`, (r) => days(str(r, 'received_date'), AS_OF) > 14));
const REPAIR_WHERE: Record<Extract<RowRead, { table: 'repairs' }>['status'], Cond> = {
  open: STILL_OPEN,
  late: STILL_OPEN_OVER_14D,
  done: both(FINISHED, cond(`completed_date >= '${RECENT_FROM}'`, (r) => !isNull(r.completed_date) && str(r, 'completed_date') >= RECENT_FROM)),
};

function repairs(read: Extract<RowRead, { table: 'repairs' }>): RowQuery {
  return {
    source: 'repairs', view: 'salon_repairs', where: REPAIR_WHERE[read.status], order: ['receivedDate', 'ticketId'],
    cols: [
      text('ticketId', 'ticket_id'), text('type', 'repair_type'), text('location', 'location'), text('channel', 'channel'), text('status', 'status'),
      text('receivedDate', 'received_date'), text('completedDate', 'completed_date'), column('quoteUsd', 'quote_usd'),
      amount('costUsd', 'ROUND(parts_cost_usd + labor_cost_usd, 2)', (r) => round(num(r, 'parts_cost_usd') + num(r, 'labor_cost_usd'), 2)),
      // Days open so far (to the data date) for an open repair; days it took for a finished one.
      amount('days', `DATEDIFF(COALESCE(completed_date, '${AS_OF}'), received_date)`, (r) => days(str(r, 'received_date'), isNull(r.completed_date) ? AS_OF : str(r, 'completed_date'))),
    ],
    totals: (rows) => ({ count: rows.length, quoteUsd: sumOf(rows, 'quoteUsd'), costUsd: sumOf(rows, 'costUsd') }),
  };
}

const INVOICE_WHERE: Record<Extract<RowRead, { table: 'invoices' }>['status'], Cond> = {
  open: UNPAID,
  overdue: both(UNPAID, cond(`due_date < '${AS_OF}'`, (r) => str(r, 'due_date') < AS_OF)),
  due_30d: both(UNPAID, cond(`due_date >= '${AS_OF}' AND due_date <= '${inDays(30)}'`, (r) => str(r, 'due_date') >= AS_OF && str(r, 'due_date') <= inDays(30))),
};

function invoices(read: Extract<RowRead, { table: 'invoices' }>): RowQuery {
  const only = read.business;
  const where = only ? both(INVOICE_WHERE[read.status], cond(`business = '${only}'`, (r) => r.business === only)) : INVOICE_WHERE[read.status];
  return {
    source: 'invoices', view: 'finance_invoices', where, order: ['dueDate', 'invoiceId'],
    cols: [
      text('invoiceId', 'invoice_id'), text('supplierId', 'supplier_id'), text('business', 'business'), text('productLine', 'product_line'),
      text('invoiceDate', 'invoice_date'), text('dueDate', 'due_date'), column('amountUsd', 'amount_usd'),
      amount('daysPastDue', `GREATEST(DATEDIFF('${AS_OF}', due_date), 0)`, (r) => Math.max(days(str(r, 'due_date'), AS_OF), 0)),
    ],
    // What is owed is never added across the two businesses: one total each.
    totals: (rows) => Object.fromEntries((only ? [only] : INVOICE_BUSINESSES).map((b) => {
      const mine = rows.filter((r) => r.business === b);
      return [b, { count: mine.length, amountUsd: sumOf(mine, 'amountUsd') }];
    })),
  };
}

/** Minutes from a message's arrival to the end of the data date, from the date and clock digits (no time zone can shift it). */
const WAITING_MINUTES = `(DATEDIFF('${inDays(1)}', received_date) * 1440 - ${clock('received_at')})`;

function waiting(read: Extract<RowRead, { table: 'waiting' }>): RowQuery {
  const over = read.olderThanHours * 60;
  return {
    source: 'messages', view: 'support_messages', order: ['receivedAt', 'threadId'],
    // As the standing count of waiting messages: customers' messages of the last week with no first answer.
    where: cond(
      `direction = 'inbound' AND first_reply_at IS NULL AND received_date >= '${LAST_WEEK.from}' AND received_date <= '${LAST_WEEK.to}'`,
      (r) => r.direction === 'inbound' && isNull(r.first_reply_at) && str(r, 'received_date') >= LAST_WEEK.from && str(r, 'received_date') <= LAST_WEEK.to,
    ),
    cols: [
      text('threadId', 'thread_id'), text('channel', 'channel'), text('intent', 'intent'), text('receivedAt', 'received_at'),
      amount('waitingMinutes', WAITING_MINUTES, (r) => (moment(AS_OF_END) - moment(r.received_at)) / 60_000),
      amount('waitingHours', `ROUND(${WAITING_MINUTES} / 60, 1)`, (r) => round((moment(AS_OF_END) - moment(r.received_at)) / 3_600_000, 1)),
    ],
    keep: (r) => Number(r.waitingMinutes) > over,
    totals: (rows) => ({ count: rows.length, byChannel: countBy(rows, 'channel'), byIntent: countBy(rows, 'intent') }),
  };
}

function lowStock(): RowQuery {
  return {
    source: 'inventory', view: 'online_inventory', order: ['-views7d', 'sku'],
    // The data date's stock, as the month so far's low-stock count reads it.
    where: cond(`snapshot_date = '${AS_OF}' AND on_hand <= reorder_point`, (r) => r.snapshot_date === AS_OF && num(r, 'on_hand') <= num(r, 'reorder_point')),
    cols: [
      text('sku', 'sku'), text('productLine', 'product_line'), column('onHand', 'on_hand'), column('reorderPoint', 'reorder_point'),
      column('views7d', 'views_7d'), column('addToCart7d', 'add_to_cart_7d'),
    ],
    totals: (rows) => {
      const wanted = rows.filter((r) => Number(r.views7d) >= WANTED_VIEWS);
      return { count: rows.length, wanted: wanted.length, wantedOutOfStock: wanted.filter((r) => Number(r.onHand) === 0).length };
    },
  };
}

// ---- The channels (wave 2) --------------------------------------------------------------------

/** Days of cover at the last 28 days' pace, to a tenth (none when nothing sold); the TypeScript divides once, as Zetaris rounds. */
const COVER_SQL = 'CASE WHEN units_28d > 0 THEN ROUND(on_hand * 28 / units_28d, 1) END';
const coverOf = (r: Row) => (num(r, 'units_28d') > 0 ? Math.round((num(r, 'on_hand') * 280) / num(r, 'units_28d')) / 10 : null);

function marketplaceStock(read: Extract<RowRead, { table: 'marketplace_stock' }>): RowQuery {
  const today = cond(`snapshot_date = '${AS_OF}'`, (r) => r.snapshot_date === AS_OF);
  const low = cond(`(${STOCK_OUT.sql} OR ${LOW_COVER.sql})`, (r) => STOCK_OUT.js(r) || LOW_COVER.js(r));
  const only = read.marketplace;
  const mine = only ? cond(`marketplace = '${only}'`, (r) => r.marketplace === only) : undefined;
  const where = [today, ...(read.status === 'low' ? [low] : []), ...(mine ? [mine] : [])].reduce(both);
  return {
    source: 'marketplace_stock', view: 'marketplace_stock', where, order: ['marketplace', 'sku'],
    cols: [
      text('sku', 'sku'), text('marketplace', 'marketplace'), text('productLine', 'product_line'), column('onHand', 'on_hand'), column('inbound', 'inbound'),
      column('units28d', 'units_28d'), amount('dailyUnits', 'ROUND(units_28d / 28, 2)', (r) => Math.round((num(r, 'units_28d') * 100) / 28) / 100),
      { key: 'daysOfCover', sql: COVER_SQL, js: coverOf, number: true, nullable: true },
      { key: 'status', sql: `CASE WHEN ${STOCK_OUT.sql} THEN 'out' WHEN ${LOW_COVER.sql} THEN 'low' ELSE 'ok' END`, js: (r) => (STOCK_OUT.js(r) ? 'out' : LOW_COVER.js(r) ? 'low' : 'ok'), number: false },
    ],
    // Units, never money, so both marketplaces add up.
    totals: (rows) => ({
      count: rows.length, outOfStock: rows.filter((r) => r.status === 'out').length, lowCover: rows.filter((r) => r.status === 'low').length,
      onHandUnits: sumOf(rows, 'onHand'), inboundUnits: sumOf(rows, 'inbound'),
    }),
  };
}

const LINES = `${CONTAINER_V2}.online_order_lines`;
const STOCK = `${CONTAINER_V2}.online_inventory`;
const REVIEWS = `${CONTAINER_V2}.online_reviews`;
/** Spark's sorted, comma-joined distinct values of a column (a customer's topics), and its TypeScript twin. */
const joinedSql = (col: string) => `concat_ws(',', sort_array(collect_set(${col})))`;
const joined = (values: readonly unknown[]) => [...new Set(values.map(String))].sort().join(',');
/** Each product's rating: the average of all its valid reviews to the data date, and how many there are. */
const ratingsOf = (b: SourceRows) => {
  const out = new Map<string, number[]>();
  for (const v of sourceRows(b).reviews.filter((r) => specOf('reviews', 2).valid(r))) out.set(str(v, 'sku'), [...(out.get(str(v, 'sku')) ?? []), num(v, 'rating')]);
  return out;
};

/**
 * Each store product's period from its order lines, by order date: units, revenue, cost, refunds on those orders
 * (to the data date), profit after them, margin and refund rate; and its views in the week before the period's last
 * day, from the inventory; and its rating (wave 2): the average of all its reviews to the data date, and how many. One
 * statement: the valid lines of the period, added up per product, joined to that day's valid stock rows and the
 * product's valid reviews.
 */
function products(read: Extract<RowRead, { table: 'products' }>): RowQuery {
  const { from, to } = PERIODS[read.period];
  const s = specOf('order_lines', 2);
  const stock = specOf('inventory', 2);
  const [rev, cost, profit] = [LINE_REVENUE.sql, LINE_COST.sql, LINE_PROFIT.sql];
  const cols: Col[] = [
    text('sku', 'sku'), text('productLine', 'product_line'), column('units', 'units'), column('revenueUsd', 'revenue'), column('costUsd', 'cost'),
    column('refundsUsd', 'refunds'), column('profitUsd', 'profit'), { ...column('margin', 'margin'), nullable: true }, { ...column('refundRate', 'refund_rate'), nullable: true },
    { ...column('views7d', 'views_7d'), nullable: true }, { ...column('avgRating', 'avg_rating'), nullable: true }, column('reviews', 'reviews'),
  ];
  const sql = `SELECT l.sku AS c0, l.product_line AS c1, SUM(l.units) AS c2, ROUND(SUM(${rev}), 2) AS c3, ROUND(SUM(${cost}), 2) AS c4, ROUND(SUM(refunded_usd), 2) AS c5, `
    + `ROUND(SUM(${profit}), 2) AS c6, ROUND(SUM(${profit}) / NULLIF(SUM(${rev}), 0), 4) AS c7, ROUND(SUM(refunded_usd) / NULLIF(SUM(${rev}), 0), 4) AS c8, MAX(i.views_7d) AS c9, `
    + `MAX(v.avg_rating) AS c10, COALESCE(MAX(v.reviews), 0) AS c11 `
    + `FROM (SELECT sku, product_line, units, price_usd, unit_cost_usd, refunded_usd FROM ${LINES} WHERE (${s.validSql}) AND order_date BETWEEN '${from}' AND '${to}') l `
    + `LEFT JOIN (SELECT sku AS stock_sku, views_7d FROM ${STOCK} WHERE (${stock.validSql}) AND snapshot_date = '${to}') i ON i.stock_sku = l.sku `
    + `LEFT JOIN (SELECT sku AS rated_sku, ROUND(AVG(rating), 2) AS avg_rating, COUNT(*) AS reviews FROM ${REVIEWS} WHERE (${specOf('reviews', 2).validSql}) GROUP BY sku) v ON v.rated_sku = l.sku `
    + `GROUP BY l.sku, l.product_line ORDER BY c6${read.sort === 'best' ? ' DESC' : ''}, c0`;
  const rows = (b: SourceRows): Out[] => {
    const all = sourceRows(b);
    const ratings = ratingsOf(b);
    const views = new Map(all.inventory.filter((r) => stock.valid(r) && r.snapshot_date === to).map((r) => [str(r, 'sku'), num(r, 'views_7d')]));
    const bySku = new Map<string, Row[]>();
    for (const r of all.order_lines.filter((x) => s.valid(x) && str(x, 'order_date') >= from && str(x, 'order_date') <= to)) bySku.set(str(r, 'sku'), [...(bySku.get(str(r, 'sku')) ?? []), r]);
    return [...bySku].map(([sku, lines]) => {
      const add = (f: (r: Row) => number) => lines.reduce((t, r) => t + f(r), 0);
      const [revenue, refunds, made] = [add(LINE_REVENUE.js), add((r) => num(r, 'refunded_usd')), add(LINE_PROFIT.js)];
      return {
        sku, productLine: str(lines[0]!, 'product_line'), units: add((r) => num(r, 'units')), revenueUsd: round(revenue, 2), costUsd: round(add(LINE_COST.js), 2),
        refundsUsd: round(refunds, 2), profitUsd: round(made, 2), margin: revenue ? round(made / revenue, 4) : null, refundRate: revenue ? round(refunds / revenue, 4) : null,
        views7d: views.get(sku) ?? null,
        avgRating: ratings.has(sku) ? round(ratings.get(sku)!.reduce((t, x) => t + x, 0) / ratings.get(sku)!.length, 2) : null, reviews: ratings.get(sku)?.length ?? 0,
      };
    });
  };
  return {
    source: 'order_lines', view: 'online_order_lines', cols, where: cond('TRUE', () => true), order: read.sort === 'best' ? ['-profitUsd', 'sku'] : ['profitUsd', 'sku'],
    grouped: { sql, views: ['online_order_lines', 'online_inventory', 'online_reviews'], rows },
    totals: (rows) => ({
      count: rows.length, units: rows.reduce((t, r) => t + Number(r.units), 0), revenueUsd: sumOf(rows, 'revenueUsd'), costUsd: sumOf(rows, 'costUsd'),
      refundsUsd: sumOf(rows, 'refundsUsd'), profitUsd: sumOf(rows, 'profitUsd'), losing: rows.filter((r) => Number(r.profitUsd) < 0).length,
    }),
  };
}

// ---- The customers (wave 2) -------------------------------------------------------------------

const REFUNDS = `${CONTAINER_V2}.online_refunds`;
const ORDERS = `${CONTAINER_V2}.online_orders`;
const MESSAGES = `${CONTAINER_V2}.support_messages`;

/** A row's numbers per refund reason, every reason named (none: 0), so the totals never add a business's money across another's. */
const perReason = (rows: readonly Out[], f: (mine: readonly Out[]) => number) => Object.fromEntries(REFUND_REASONS.map((x) => [x, f(rows.filter((r) => r.reason === x))]));

/**
 * Each refund issued in the period, oldest first: its order, the customer (a synthetic id), the order's products, the
 * reason, amount and days after the sale; and the customer's refunds in the 365 days to the data date, reviews (how
 * many, the lowest rating, their topics) and messages to the shop (how many, their topics). Never a name or a message's
 * text. One statement: the valid refunds of the period joined to their orders, the orders' lines and, per customer,
 * the year's refunds, the reviews and the inbound messages, each from its source's valid rows.
 */
function returnCases(read: Extract<RowRead, { table: 'return_cases' }>): RowQuery {
  const { from, to } = PERIODS[read.period];
  const valid = (source: Source) => `(${specOf(source, 2).validSql})`;
  const cols: Col[] = [
    text('refundId', 'refund_id'), text('orderId', 'order_id'), text('customerId', 'customer_id'), text('skus', 'skus'), text('reason', 'reason'),
    column('amountUsd', 'amount_usd'), text('refundDate', 'refund_date'), column('daysAfterSale', 'days'), column('refunds365d', 'refunds_365d'),
    column('reviews', 'reviews'), { ...column('lowestRating', 'lowest_rating'), nullable: true }, text('reviewTopics', 'review_topics'),
    column('messages', 'messages'), text('messageTopics', 'message_topics'),
  ];
  // The refunds are read once (Spark refuses one exploded row view joined with itself): the customer's year is a window
  // over that read, and the period is chosen after it.
  const sql = 'SELECT f.refund_id AS c0, f.order_id AS c1, f.customer_id AS c2, l.skus AS c3, f.reason AS c4, f.amount_usd AS c5, f.refund_date AS c6, '
    + 'DATEDIFF(f.refund_date, o.order_date) AS c7, f.refunds_365d AS c8, COALESCE(v.reviews, 0) AS c9, v.lowest_rating AS c10, v.review_topics AS c11, '
    + 'COALESCE(m.messages, 0) AS c12, m.message_topics AS c13 '
    + `FROM (SELECT refund_id, order_id, customer_id, reason, amount_usd, refund_date, COUNT(CASE WHEN refund_date BETWEEN '${YEAR_TO_DATE.from}' AND '${YEAR_TO_DATE.to}' THEN 1 END) `
    + `OVER (PARTITION BY customer_id) AS refunds_365d FROM ${REFUNDS} WHERE ${valid('refunds')}) f `
    + `JOIN (SELECT order_id AS placed_id, order_date FROM ${ORDERS} WHERE ${valid('orders')}) o ON o.placed_id = f.order_id `
    + `LEFT JOIN (SELECT order_id AS lined_id, ${joinedSql('sku')} AS skus FROM ${LINES} WHERE ${valid('order_lines')} GROUP BY order_id) l ON l.lined_id = f.order_id `
    + `LEFT JOIN (SELECT customer_id AS reviewer_id, COUNT(*) AS reviews, MIN(rating) AS lowest_rating, ${joinedSql('topic')} AS review_topics FROM ${REVIEWS} WHERE ${valid('reviews')} GROUP BY customer_id) v ON v.reviewer_id = f.customer_id `
    + `LEFT JOIN (SELECT customer_id AS writer_id, COUNT(*) AS messages, ${joinedSql('intent')} AS message_topics FROM ${MESSAGES} WHERE ${valid('messages')} AND direction = 'inbound' GROUP BY customer_id) m ON m.writer_id = f.customer_id `
    + `WHERE f.refund_date BETWEEN '${from}' AND '${to}' ORDER BY c6, c0`;
  const rows = (b: SourceRows): Out[] => {
    const all = sourceRows(b);
    const ok = (source: Source) => (r: Row) => specOf(source, 2).valid(r);
    const byCustomer = (rs: readonly Row[]) => {
      const out = new Map<string, Row[]>();
      for (const r of rs) out.set(str(r, 'customer_id'), [...(out.get(str(r, 'customer_id')) ?? []), r]);
      return out;
    };
    const placed = new Map(all.orders.filter(ok('orders')).map((o) => [str(o, 'order_id'), str(o, 'order_date')]));
    const lines = new Map<string, Row[]>();
    for (const l of all.order_lines.filter(ok('order_lines'))) lines.set(str(l, 'order_id'), [...(lines.get(str(l, 'order_id')) ?? []), l]);
    const year = byCustomer(all.refunds.filter((f) => ok('refunds')(f) && str(f, 'refund_date') >= YEAR_TO_DATE.from && str(f, 'refund_date') <= YEAR_TO_DATE.to));
    const reviews = byCustomer(all.reviews.filter(ok('reviews')));
    const messages = byCustomer(all.messages.filter((m) => ok('messages')(m) && m.direction === 'inbound'));
    return all.refunds.filter((f) => ok('refunds')(f) && str(f, 'refund_date') >= from && str(f, 'refund_date') <= to && placed.has(str(f, 'order_id'))).map((f) => {
      const [orderId, customerId] = [str(f, 'order_id'), str(f, 'customer_id')];
      const [theirReviews, theirMessages] = [reviews.get(customerId) ?? [], messages.get(customerId) ?? []];
      return {
        refundId: str(f, 'refund_id'), orderId, customerId, skus: lines.has(orderId) ? joined(lines.get(orderId)!.map((l) => l.sku)) : null, reason: str(f, 'reason'),
        amountUsd: num(f, 'amount_usd'), refundDate: str(f, 'refund_date'), daysAfterSale: days(placed.get(orderId)!, str(f, 'refund_date')),
        refunds365d: year.get(customerId)?.length ?? 0, reviews: theirReviews.length,
        lowestRating: theirReviews.length ? Math.min(...theirReviews.map((v) => num(v, 'rating'))) : null, reviewTopics: theirReviews.length ? joined(theirReviews.map((v) => v.topic)) : null,
        messages: theirMessages.length, messageTopics: theirMessages.length ? joined(theirMessages.map((m) => m.intent)) : null,
      };
    });
  };
  return {
    source: 'refunds', view: 'online_refunds', cols, where: cond('TRUE', () => true), order: ['refundDate', 'refundId'],
    grouped: { sql, views: ['online_refunds', 'online_orders', 'online_order_lines', 'online_reviews', 'support_messages'], rows },
    // Online money only; the port adds it up per reason so a script never does.
    totals: (rows) => ({
      count: rows.length, amountUsd: sumOf(rows, 'amountUsd'), customers: new Set(rows.map((r) => r.customerId)).size,
      repeatCustomers: new Set(rows.filter((r) => Number(r.refunds365d) >= 2).map((r) => r.customerId)).size,
      byReason: perReason(rows, (mine) => mine.length), amountByReason: perReason(rows, (mine) => sumOf(mine, 'amountUsd')),
    }),
  };
}

// ---- The store site (wave 2) ------------------------------------------------------------------

const PAGE_DAYS = `${CONTAINER_V2}.web_page_days`;
const rate = (part: number, whole: number) => (whole ? round(part / whole, 4) : null);

/**
 * The store journey of one period, by where the visits came from, most visits first: sessions, carts, checkouts,
 * orders, the share of visits that added to the cart and that ended in an order. One statement over the period's valid
 * page days, added up per source; the port adds the sources up (counts, so they add) and works out the overall rates.
 */
function journey(read: Extract<RowRead, { table: 'journey' }>): RowQuery {
  const { from, to } = PERIODS[read.period];
  const s = specOf('page_days', 2);
  const cols: Col[] = [
    text('source', 'source'), column('sessions', 'sessions'), column('carts', 'carts'), column('checkouts', 'checkouts'), column('orders', 'orders'),
    { ...column('cartRate', 'cart_rate'), nullable: true }, { ...column('conversionRate', 'conversion_rate'), nullable: true },
  ];
  const sql = 'SELECT source AS c0, SUM(sessions) AS c1, SUM(carts) AS c2, SUM(checkouts) AS c3, SUM(orders) AS c4, '
    + 'ROUND(SUM(carts) / NULLIF(SUM(sessions), 0), 4) AS c5, ROUND(SUM(orders) / NULLIF(SUM(sessions), 0), 4) AS c6 '
    + `FROM ${PAGE_DAYS} WHERE (${s.validSql}) AND visit_date BETWEEN '${from}' AND '${to}' GROUP BY source ORDER BY c1 DESC, c0`;
  const rows = (b: SourceRows): Out[] => {
    const bySource = new Map<string, Row[]>();
    for (const d of sourceRows(b).page_days.filter((r) => s.valid(r) && str(r, 'visit_date') >= from && str(r, 'visit_date') <= to)) {
      bySource.set(str(d, 'source'), [...(bySource.get(str(d, 'source')) ?? []), d]);
    }
    return [...bySource].map(([source, mine]) => {
      const add = (k: string) => mine.reduce((t, r) => t + num(r, k), 0);
      return { source, sessions: add('sessions'), carts: add('carts'), checkouts: add('checkouts'), orders: add('orders'), cartRate: rate(add('carts'), add('sessions')), conversionRate: rate(add('orders'), add('sessions')) };
    });
  };
  return {
    source: 'page_days', view: 'web_page_days', cols, where: cond('TRUE', () => true), order: ['-sessions', 'source'],
    grouped: { sql, views: ['web_page_days'], rows },
    totals: (rows) => {
      const add = (k: string) => rows.reduce((t, r) => t + Number(r[k]), 0);
      const [sessions, carts, orders] = [add('sessions'), add('carts'), add('orders')];
      return { count: rows.length, sessions, carts, checkouts: add('checkouts'), orders, cartRate: rate(carts, sessions) ?? 0, conversionRate: rate(orders, sessions) ?? 0 };
    },
  };
}

// ---- Checking a read, its SQL, its rows ------------------------------------------------------

const REPAIR_STATUSES = Object.keys(REPAIR_WHERE);
const INVOICE_STATUSES = Object.keys(INVOICE_WHERE);

/** The read as asked, checked against the fixed lists; anything else is refused with a plain reason. */
export function checkRowRead(input: RowRead): RowRead {
  const where = `row read "${String((input as { table?: unknown }).table).slice(0, 40)}"`;
  switch (input.table) {
    case 'repairs':
      if (!REPAIR_STATUSES.includes(input.status)) throw new Error(`${where}: status must be one of ${REPAIR_STATUSES.join(', ')}`);
      return { table: 'repairs', status: input.status };
    case 'invoices':
      if (!INVOICE_STATUSES.includes(input.status)) throw new Error(`${where}: status must be one of ${INVOICE_STATUSES.join(', ')}`);
      if (input.business !== undefined && !(INVOICE_BUSINESSES as readonly string[]).includes(input.business)) throw new Error(`${where}: business must be salon or online`);
      return { table: 'invoices', status: input.status, ...(input.business ? { business: input.business } : {}) };
    case 'waiting':
      if (!Number.isFinite(input.olderThanHours) || input.olderThanHours < 0 || input.olderThanHours > 24 * 30) throw new Error(`${where}: olderThanHours must be from 0 to 720`);
      return { table: 'waiting', olderThanHours: input.olderThanHours };
    case 'low_stock':
      return { table: 'low_stock' };
    case 'marketplace_stock':
      if (!['all', 'low'].includes(input.status)) throw new Error(`${where}: status must be one of all, low`);
      if (input.marketplace !== undefined && !(MARKETPLACES as readonly string[]).includes(input.marketplace)) throw new Error(`${where}: marketplace must be amazon or walmart`);
      return { table: 'marketplace_stock', status: input.status, ...(input.marketplace ? { marketplace: input.marketplace } : {}) };
    case 'products':
      if (!PERIOD_KEYS.includes(input.period)) throw new Error(`${where}: period must be one of ${PERIOD_KEYS.join(', ')}`);
      if (!['best', 'worst'].includes(input.sort)) throw new Error(`${where}: sort must be best or worst`);
      return { table: 'products', period: input.period, sort: input.sort };
    case 'return_cases':
    case 'journey':
      if (!PERIOD_KEYS.includes(input.period)) throw new Error(`${where}: period must be one of ${PERIOD_KEYS.join(', ')}`);
      return { table: input.table, period: input.period };
    default:
      throw new Error(`${where}: there is no such row table`);
  }
}

export function rowQuery(read: RowRead): RowQuery {
  switch (read.table) {
    case 'repairs': return repairs(read);
    case 'invoices': return invoices(read);
    case 'waiting': return waiting(read);
    case 'low_stock': return lowStock();
    case 'marketplace_stock': return marketplaceStock(read);
    case 'products': return products(read);
    case 'return_cases': return returnCases(read);
    case 'journey': return journey(read);
  }
}

const alias = (q: RowQuery, key: string) => `c${q.cols.findIndex((c) => c.key === key)}`;

/** The one statement a read runs: the columns by position, the data-quality rule, the fixed condition, the order. */
export function rowSql(q: RowQuery): string {
  if (q.grouped) return q.grouped.sql;
  const order = q.order.map((k) => (k.startsWith('-') ? `${alias(q, k.slice(1))} DESC` : alias(q, k))).join(', ');
  return `SELECT ${q.cols.map((c, i) => `${c.sql} AS c${i}`).join(', ')} FROM ${CONTAINER_V2}.${q.view} WHERE (${specOf(q.source, 2).validSql}) AND ${q.where.sql} ORDER BY ${order}`;
}

/** What a read's query hash covers: the body of every row view it reads, and the statement. */
export const rowHashText = (q: RowQuery) => [...(q.grouped?.views ?? [q.view]).map(rowViewBody), rowSql(q)].join('\n--\n');

/** Zetaris's answer (strings, '' for NULL) as typed rows; a number column that is not a number stops the read. */
function typed(q: RowQuery, raw: readonly string[][]): Out[] {
  return raw.map((cells) => Object.fromEntries(q.cols.map((c, i) => {
    const v = cells[i];
    if (!c.number) return [c.key, v === undefined || v === '' ? null : v];
    if (c.nullable && (v === undefined || v === '')) return [c.key, null];
    const n = Number(v);
    if (v === undefined || v === '' || !Number.isFinite(n)) throw new Error(`Zetaris returned a non-numeric ${c.key} for ${q.view}`);
    return [c.key, n];
  })));
}

/** The rows of a read and their totals, from Zetaris's answer. */
export function rowsResult(read: RowRead, raw: readonly string[][], queryHash: string): RowsData {
  const q = rowQuery(read);
  if (raw.length > ROW_CAP) throw new Error(`more than ${ROW_CAP} rows match ${read.table}; this read returns all of them or none`);
  const rows = typed(q, raw).filter((r) => !q.keep || q.keep(r));
  return { table: read.table, rows, totals: q.totals(rows), dataDate: AS_OF, queryHash, view: `${CONTAINER_V2}.${q.view}` };
}

/** The oracle: the same read computed in TypeScript from the rows Zetaris reads (the proof and the tests compare). */
export function oracleRows(b: SourceRows, read: RowRead): Pick<RowsData, 'rows' | 'totals'> {
  const q = rowQuery(read);
  const s = specOf(q.source, 2);
  const rows = q.grouped ? q.grouped.rows(b) : sourceRows(b)[q.source].filter((r) => s.valid(r) && q.where.js(r)).map((r) => Object.fromEntries(q.cols.map((c) => [c.key, c.js(r)])));
  const sorted = [...rows].sort((a, b) => {
    for (const k of q.order) {
      const [key, sign] = k.startsWith('-') ? [k.slice(1), -1] : [k, 1];
      const [x, y] = [a[key] ?? '', b[key] ?? ''];
      if (x !== y) return (x < y ? -1 : 1) * sign;
    }
    return 0;
  }).filter((r) => !q.keep || q.keep(r));
  return { rows: sorted, totals: q.totals(sorted) };
}
