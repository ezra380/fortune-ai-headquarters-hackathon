import type { RowRead, RowsData } from '@fahq/contracts';
import { CONTAINER_V2, round, sourceRows, specOf, type Source, type SourceRows } from './finance-sql.ts';
import { FINISHED, STILL_OPEN, UNPAID, clock, days, inDays, moment } from './operations.ts';
import { both, isNull, num, type Cond, type Row } from './sql.ts';
import { AS_OF, AS_OF_END, INVOICE_BUSINESSES, LAST_WEEK } from './synthetic.ts';
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
type Col = { key: string; sql: string; js: (r: Row) => Value; number: boolean };
type Out = Record<string, Value>;

const text = (key: string, col: string): Col => ({ key, sql: col, js: (r) => (isNull(r[col]) ? null : String(r[col])), number: false });
const amount = (key: string, sql: string, js: (r: Row) => number): Col => ({ key, sql, js, number: true });
const column = (key: string, col: string): Col => amount(key, col, (r) => num(r, col));
const str = (r: Row, k: string) => String(r[k]);
const cond = (sql: string, js: (r: Row) => boolean): Cond => ({ sql, js });

/** One fixed question: its source, columns, condition beyond the data-quality rule, order, and how its rows add up. */
type RowQuery = {
  source: Source;
  view: Parameters<typeof rowViewBody>[0];
  cols: readonly Col[];
  where: Cond;
  /** Column keys to sort by; a leading '-' sorts high to low. */
  order: readonly string[];
  /** Applied to the typed rows after the read (never in SQL). */
  keep?: (r: Out) => boolean;
  totals: (rows: readonly Out[]) => RowsData['totals'];
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
  }
}

const alias = (q: RowQuery, key: string) => `c${q.cols.findIndex((c) => c.key === key)}`;

/** The one statement a read runs: the columns by position, the data-quality rule, the fixed condition, the order. */
export function rowSql(q: RowQuery): string {
  const order = q.order.map((k) => (k.startsWith('-') ? `${alias(q, k.slice(1))} DESC` : alias(q, k))).join(', ');
  return `SELECT ${q.cols.map((c, i) => `${c.sql} AS c${i}`).join(', ')} FROM ${CONTAINER_V2}.${q.view} WHERE (${specOf(q.source, 2).validSql}) AND ${q.where.sql} ORDER BY ${order}`;
}

/** What a read's query hash covers: the row view's body and the statement. */
export const rowHashText = (q: RowQuery) => `${rowViewBody(q.view)}\n--\n${rowSql(q)}`;

/** Zetaris's answer (strings, '' for NULL) as typed rows; a number column that is not a number stops the read. */
function typed(q: RowQuery, raw: readonly string[][]): Out[] {
  return raw.map((cells) => Object.fromEntries(q.cols.map((c, i) => {
    const v = cells[i];
    if (!c.number) return [c.key, v === undefined || v === '' ? null : v];
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
  const rows = sourceRows(b)[q.source].filter((r) => s.valid(r) && q.where.js(r)).map((r) => Object.fromEntries(q.cols.map((c) => [c.key, c.js(r)])));
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
