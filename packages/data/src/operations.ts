import type { Division } from '@fahq/contracts';
import type { MetricDef } from './finance-sql.ts';
import { ONE, both, isNull, num, oneIf, oneOf, quoted, type Cond, type Field, type Row, type SourceSpec } from './sql.ts';
import {
  AS_OF, INVOICE_BUSINESSES, LAST_WEEK, MESSAGE_CHANNELS, MESSAGE_DIRECTIONS, MESSAGE_INTENTS, PRODUCT_LINES, RECOVERY_CHANNELS, REFUND_REASONS,
  REPAIR_CHANNELS, REPAIR_STATUSES, REPAIR_TYPES, SALON_LOCATIONS, SUPPLIERS,
} from './synthetic.ts';

// The day-to-day systems version 2 adds (each its own source, served by generateOperations): what each row
// must be to count (its data-quality rule, with a rejected-rows metric so the filter is visible), its period
// totals and its standing numbers as of the data date. Who reads each number is its `divisions`: a source's
// rejected rows go to every division that reads the source, and to HQ. Thresholds live in `about`, never in
// a label. Nothing here reads a message's text: the support inbox has none.

export const OPS_SOURCE_NAMES = ['order_costs', 'refunds', 'checkouts', 'inventory', 'messages', 'repairs', 'invoices'] as const;
export type OpsSource = (typeof OPS_SOURCE_NAMES)[number];

const str = (r: Row, k: string) => String(r[k]);
const startsDemoOrder = (r: Row) => !isNull(r.order_id) && str(r, 'order_id').startsWith('demo-o-');

export const OPS_SOURCES: Record<OpsSource, SourceSpec> = {
  order_costs: {
    table: 'online_order_costs', date: 'order_date',
    validSql: "payment_fee_usd >= 0 AND shipping_cost_usd >= 0 AND order_id LIKE 'demo-o-%'",
    valid: (r) => num(r, 'payment_fee_usd') >= 0 && num(r, 'shipping_cost_usd') >= 0 && startsDemoOrder(r),
  },
  refunds: {
    table: 'online_refunds', date: 'refund_date',
    validSql: `amount_usd > 0 AND reason IN (${quoted(REFUND_REASONS)}) AND order_id LIKE 'demo-o-%'`,
    valid: (r) => num(r, 'amount_usd') > 0 && oneOf(REFUND_REASONS, r.reason) && startsDemoOrder(r),
  },
  checkouts: {
    table: 'online_checkouts', date: 'created_date',
    // Recovered exactly when it names the order it became.
    validSql: `value_usd >= 0 AND product_line IN (${quoted(PRODUCT_LINES)}) AND recovered_via IN (${quoted(RECOVERY_CHANNELS)}) AND (recovered_via = 'none') = (recovered_order_id IS NULL)`,
    valid: (r) => num(r, 'value_usd') >= 0 && oneOf(PRODUCT_LINES, r.product_line) && oneOf(RECOVERY_CHANNELS, r.recovered_via)
      && (r.recovered_via === 'none') === isNull(r.recovered_order_id),
  },
  inventory: {
    table: 'online_inventory', date: 'snapshot_date',
    // Only the store's own lines: there is no topper or hair-loss line to count interest in.
    validSql: `on_hand >= 0 AND reorder_point >= 0 AND views_7d >= 0 AND add_to_cart_7d >= 0 AND product_line IN (${quoted(PRODUCT_LINES)})`,
    valid: (r) => ['on_hand', 'reorder_point', 'views_7d', 'add_to_cart_7d'].every((k) => num(r, k) >= 0) && oneOf(PRODUCT_LINES, r.product_line),
  },
  messages: {
    table: 'support_messages', date: 'received_date',
    validSql: `channel IN (${quoted(MESSAGE_CHANNELS)}) AND direction IN (${quoted(MESSAGE_DIRECTIONS)}) AND intent IN (${quoted(MESSAGE_INTENTS)}) AND substr(received_at, 1, 10) = received_date AND (first_reply_at IS NULL OR first_reply_at >= received_at)`,
    valid: (r) => oneOf(MESSAGE_CHANNELS, r.channel) && oneOf(MESSAGE_DIRECTIONS, r.direction) && oneOf(MESSAGE_INTENTS, r.intent)
      && str(r, 'received_at').slice(0, 10) === r.received_date && (isNull(r.first_reply_at) || str(r, 'first_reply_at') >= str(r, 'received_at')),
  },
  repairs: {
    table: 'salon_repairs', date: 'received_date',
    validSql: `quote_usd >= 0 AND parts_cost_usd >= 0 AND labor_cost_usd >= 0 AND repair_type IN (${quoted(REPAIR_TYPES)}) AND status IN (${quoted(REPAIR_STATUSES)}) AND channel IN (${quoted(REPAIR_CHANNELS)}) AND location IN (${quoted(SALON_LOCATIONS)}) AND (completed_date IS NULL OR completed_date >= received_date)`,
    valid: (r) => ['quote_usd', 'parts_cost_usd', 'labor_cost_usd'].every((k) => num(r, k) >= 0) && oneOf(REPAIR_TYPES, r.repair_type)
      && oneOf(REPAIR_STATUSES, r.status) && oneOf(REPAIR_CHANNELS, r.channel) && oneOf(SALON_LOCATIONS, r.location)
      && (isNull(r.completed_date) || str(r, 'completed_date') >= str(r, 'received_date')),
  },
  invoices: {
    table: 'finance_invoices', date: 'invoice_date',
    validSql: `amount_usd > 0 AND due_date >= invoice_date AND (paid_date IS NULL OR paid_date >= invoice_date) AND business IN (${quoted(INVOICE_BUSINESSES)}) AND supplier_id IN (${quoted(SUPPLIERS)})`,
    valid: (r) => num(r, 'amount_usd') > 0 && str(r, 'due_date') >= str(r, 'invoice_date') && (isNull(r.paid_date) || str(r, 'paid_date') >= str(r, 'invoice_date'))
      && oneOf(INVOICE_BUSINESSES, r.business) && oneOf(SUPPLIERS, r.supplier_id),
  },
};

// ---- Conditions ---------------------------------------------------------------------------

const isNullCond = (col: string): Cond => ({ sql: `${col} IS NULL`, js: (r) => isNull(r[col]) });
const notNullCond = (col: string): Cond => ({ sql: `${col} IS NOT NULL`, js: (r) => !isNull(r[col]) });
const inCond = (col: string, xs: readonly string[]): Cond => ({ sql: `${col} IN (${quoted(xs)})`, js: (r) => oneOf(xs, r[col]) });
const days = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;

/**
 * Minutes from a message's arrival to the shop's first answer (NULL when unanswered). The day difference comes
 * from DATEDIFF on dates and the rest from the clock digits, so no session time zone can shift it.
 */
const clock = (col: string) => `(CAST(substr(${col}, 12, 2) AS INT) * 60 + CAST(substr(${col}, 15, 2) AS INT))`;
const REPLY_MINUTES = `(DATEDIFF(substr(first_reply_at, 1, 10), received_date) * 1440 + ${clock('first_reply_at')} - ${clock('received_at')})`;
const moment = (v: unknown) => Date.parse(`${String(v).replace(' ', 'T')}Z`);
const replyMinutes = (r: Row) => (isNull(r.first_reply_at) ? null : (moment(r.first_reply_at) - moment(r.received_at)) / 60_000);
const answeredWithin = (minutes: number): Cond => ({
  sql: `${REPLY_MINUTES} <= ${minutes}`, js: (r) => { const m = replyMinutes(r); return m !== null && m <= minutes; },
});
const notAnsweredWithin = (minutes: number): Cond => ({
  sql: `(first_reply_at IS NULL OR ${REPLY_MINUTES} > ${minutes})`, js: (r) => { const m = replyMinutes(r); return m === null || m > minutes; },
});

const FINISHED = inCond('status', ['done', 'shipped']);
const STILL_OPEN = inCond('status', ['open', 'in_repair']);
const UNPAID = isNullCond('paid_date');
const inDays = (n: number) => new Date(Date.parse(`${AS_OF}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// ---- Metrics ------------------------------------------------------------------------------

const ROWS = ['row', 'rows'] as const;
const MESSAGES = ['message', 'messages'] as const;
const INBOUND = { direction: 'inbound' };
const ONLINE: readonly Division[] = ['online'];
const ONLINE_MONEY: readonly Division[] = ['online', 'finance'];
const SALON_MONEY: readonly Division[] = ['salon', 'finance'];
const repairMargin: Field = { sql: '(quote_usd - parts_cost_usd - labor_cost_usd)', js: (r) => num(r, 'quote_usd') - num(r, 'parts_cost_usd') - num(r, 'labor_cost_usd') };
const repairCost: Field = { sql: '(parts_cost_usd + labor_cost_usd)', js: (r) => num(r, 'parts_cost_usd') + num(r, 'labor_cost_usd') };
const finishedWithinTwoWeeks: Cond = {
  sql: 'completed_date IS NOT NULL AND DATEDIFF(completed_date, received_date) <= 14',
  js: (r) => !isNull(r.completed_date) && days(str(r, 'received_date'), str(r, 'completed_date')) <= 14,
};

/** A version 2 metric of one layer; its business is its id's unless it says otherwise. */
type Def = Omit<MetricDef, 'layer' | 'since' | 'business'> & Partial<Pick<MetricDef, 'business'>>;
const ofLayer = (layer: MetricDef['layer']) => (d: Def): MetricDef => ({ business: d.id.startsWith('m:salon.') ? 'salon' : 'online', ...d, layer, since: 2 });
const period = ofLayer('period');
const standing = ofLayer('standing');

/** Period totals: each source's rows dated in the period. */
export const OPS_METRICS: MetricDef[] = [
  // Order fees and shipping labels, and refunds: what an online sale costs after it is made.
  period({ id: 'm:online.fees.payment', label: 'Online payment fees', unit: 'usd', divisions: ONLINE_MONEY, source: 'order_costs', agg: { kind: 'sum', field: 'payment_fee_usd' } }),
  period({ id: 'm:online.shipping.cost', label: 'Online shipping label cost', unit: 'usd', divisions: ONLINE_MONEY, source: 'order_costs', agg: { kind: 'sum', field: 'shipping_cost_usd' } }),
  period({ id: 'm:online.dq.rejected_order_costs', label: 'Order fee and shipping rows rejected by data checks', unit: 'count', divisions: ['online', 'finance', 'hq'], source: 'order_costs', agg: { kind: 'rejected' }, nouns: ROWS }),
  period({ id: 'm:online.refunds.total', label: 'Online refunds issued', unit: 'usd', divisions: ONLINE_MONEY, source: 'refunds', agg: { kind: 'sum', field: 'amount_usd' }, about: 'Dated by the day the refund was issued, not the order date.' }),
  period({ id: 'm:online.refunds.count', label: 'Online refunds', unit: 'count', divisions: ONLINE_MONEY, source: 'refunds', agg: { kind: 'count' }, nouns: ['refund', 'refunds'] }),
  period({ id: 'm:online.dq.rejected_refunds', label: 'Refund rows rejected by data checks', unit: 'count', divisions: ['online', 'finance', 'hq'], source: 'refunds', agg: { kind: 'rejected' }, nouns: ROWS }),
  // Checkouts left before paying, and those that came back as an order.
  period({ id: 'm:online.checkouts.abandoned.count', label: 'Checkouts left before paying', unit: 'count', divisions: ONLINE, source: 'checkouts', agg: { kind: 'count' }, nouns: ['checkout', 'checkouts'] }),
  period({ id: 'm:online.checkouts.abandoned.value', label: 'Value of checkouts left before paying', unit: 'usd', divisions: ONLINE, source: 'checkouts', agg: { kind: 'sum', field: 'value_usd' } }),
  period({ id: 'm:online.checkouts.recovered.count', label: 'Left checkouts that came back as an order', unit: 'count', divisions: ONLINE, source: 'checkouts', agg: { kind: 'count' }, test: notNullCond('recovered_order_id'), nouns: ['checkout', 'checkouts'] }),
  period({ id: 'm:online.checkouts.recovered.value', label: 'Value of left checkouts that came back as an order', unit: 'usd', divisions: ONLINE_MONEY, source: 'checkouts', agg: { kind: 'sum', field: 'value_usd' }, test: notNullCond('recovered_order_id') }),
  period({ id: 'm:online.checkouts.recovery_rate', label: 'Share of left checkouts that came back as an order', unit: 'ratio', divisions: ONLINE, source: 'checkouts', agg: { kind: 'ratio', num: oneIf(notNullCond('recovered_order_id')), den: ONE } }),
  period({ id: 'm:online.dq.rejected_checkouts', label: 'Checkout rows rejected by data checks', unit: 'count', divisions: ['online', 'hq'], source: 'checkouts', agg: { kind: 'rejected' }, nouns: ROWS }),
  // Stock on the period's last day (the month so far: the data date), and the week's interest before it.
  period({
    id: 'm:online.inventory.low_stock.count', label: 'Products at or below their reorder point', unit: 'count', divisions: ONLINE, source: 'inventory', agg: { kind: 'count' },
    test: { sql: 'on_hand <= reorder_point', js: (r) => num(r, 'on_hand') <= num(r, 'reorder_point') }, nouns: ['product', 'products'],
    about: "On the period's last day; for the month so far, on the data date.",
  }),
  period({
    id: 'm:online.inventory.wanted_low_stock.count', label: 'Wanted products low on stock', unit: 'count', divisions: ['online', 'hq'], source: 'inventory', agg: { kind: 'count' },
    test: { sql: 'on_hand <= reorder_point AND views_7d >= 40', js: (r) => num(r, 'on_hand') <= num(r, 'reorder_point') && num(r, 'views_7d') >= 40 }, nouns: ['product', 'products'],
    about: "At or below the reorder point with at least 40 product views in the week before, on the period's last day.",
  }),
  period({
    id: 'm:online.inventory.wanted_out_of_stock.count', label: 'Wanted products out of stock', unit: 'count', divisions: ['online', 'hq'], source: 'inventory', agg: { kind: 'count' },
    test: { sql: 'on_hand = 0 AND views_7d >= 40', js: (r) => num(r, 'on_hand') === 0 && num(r, 'views_7d') >= 40 }, nouns: ['product', 'products'],
    about: "None on hand with at least 40 product views in the week before, on the period's last day.",
  }),
  period({ id: 'm:online.dq.rejected_inventory', label: 'Inventory rows rejected by data checks', unit: 'count', divisions: ['online', 'hq'], source: 'inventory', agg: { kind: 'rejected' }, nouns: ROWS }),
  // The support inbox: customers' messages (not the shop's own follow-ups), by the day they came.
  period({ id: 'm:online.service.inbound.count', label: 'Customer messages received', unit: 'count', divisions: ONLINE, source: 'messages', agg: { kind: 'count' }, where: INBOUND, nouns: MESSAGES }),
  period({ id: 'm:online.service.replied_1h.share', label: 'Customer messages answered within the hour', unit: 'ratio', divisions: ONLINE, source: 'messages', agg: { kind: 'ratio', num: oneIf(answeredWithin(60)), den: ONE }, where: INBOUND }),
  period({ id: 'm:online.service.replied_24h.share', label: 'Customer messages answered within a day', unit: 'ratio', divisions: ONLINE, source: 'messages', agg: { kind: 'ratio', num: oneIf(answeredWithin(1440)), den: ONE }, where: INBOUND }),
  period({
    id: 'm:online.service.unanswered_48h.count', label: 'Customer messages not answered within two days', unit: 'count', divisions: ONLINE, source: 'messages', agg: { kind: 'count' },
    where: INBOUND, test: notAnsweredWithin(2880), nouns: MESSAGES, about: 'No first answer within 48 hours; one still unanswered on the data date counts.',
  }),
  period({
    id: 'm:online.service.texts_unanswered_48h.count', label: "Texts to the shop's numbers not answered within two days", unit: 'count', divisions: ONLINE, source: 'messages',
    agg: { kind: 'count' }, where: INBOUND, test: both(inCond('channel', ['sms', 'phone_text']), notAnsweredWithin(2880)), nouns: ['text', 'texts'],
    about: 'Texts to either shop number with no first answer within 48 hours.',
  }),
  period({ id: 'm:online.service.sale_intent.count', label: 'Customer messages asking to buy', unit: 'count', divisions: ONLINE, source: 'messages', agg: { kind: 'count' }, where: { ...INBOUND, intent: 'purchase' }, nouns: MESSAGES }),
  period({
    id: 'm:online.service.missed_sale_intent.count', label: 'Customers asking to buy who got no answer within a day and did not order', unit: 'count', divisions: ['online', 'hq'],
    source: 'messages', agg: { kind: 'count' }, where: { ...INBOUND, intent: 'purchase' }, test: both(notAnsweredWithin(1440), isNullCond('converted_order_id')),
    nouns: ['customer', 'customers', 'buyer', 'buyers'], about: 'A purchase question with no first answer within 24 hours and no order after it.',
  }),
  period({ id: 'm:online.dq.rejected_messages', label: 'Support message rows rejected by data checks', unit: 'count', divisions: ['online', 'hq'], source: 'messages', agg: { kind: 'rejected' }, nouns: ROWS }),
  // Salon repair tickets, by the day the piece arrived.
  period({ id: 'm:salon.repairs.received.count', label: 'Repair tickets received', unit: 'count', divisions: ['salon'], source: 'repairs', agg: { kind: 'count' }, nouns: ['repair', 'repairs', 'ticket', 'tickets'] }),
  period({ id: 'm:salon.repairs.revenue', label: 'Repair fees paid on tickets received', unit: 'usd', divisions: SALON_MONEY, source: 'repairs', agg: { kind: 'sum', field: 'quote_usd' }, test: notNullCond('paid_date'), about: 'The repair tickets of the ops app, separate from the repair appointments in the salon book.' }),
  period({ id: 'm:salon.repairs.cost', label: 'Parts and labor on finished repairs', unit: 'usd', divisions: SALON_MONEY, source: 'repairs', agg: { kind: 'sum', field: repairCost }, test: FINISHED }),
  period({ id: 'm:salon.repairs.margin', label: 'Margin on finished, paid repairs (fee less parts and labor, over the fee)', unit: 'ratio', divisions: SALON_MONEY, source: 'repairs', agg: { kind: 'ratio', num: repairMargin, den: 'quote_usd' }, test: both(notNullCond('paid_date'), FINISHED) }),
  period({
    id: 'm:salon.repairs.within_14d.share', label: 'Repairs finished within two weeks of arrival', unit: 'ratio', divisions: ['salon', 'hq'], source: 'repairs',
    agg: { kind: 'ratio', num: oneIf(finishedWithinTwoWeeks), den: ONE }, test: { sql: "status <> 'cancelled'", js: (r) => r.status !== 'cancelled' },
    about: 'Finished within 14 days of arrival, of the tickets that arrived in the period and were not cancelled; one still in repair counts as not finished.',
  }),
  period({ id: 'm:salon.repairs.online_intake.share', label: 'Repairs sent in through the online form', unit: 'ratio', divisions: ['salon'], source: 'repairs', agg: { kind: 'ratio', num: oneIf(inCond('channel', ['online'])), den: ONE } }),
  period({ id: 'm:salon.dq.rejected_repairs', label: 'Repair ticket rows rejected by data checks', unit: 'count', divisions: ['salon', 'finance', 'hq'], source: 'repairs', agg: { kind: 'rejected' }, nouns: ROWS }),
  // Supplier invoices, each business on its own; a bad row is counted once, for the company.
  ...INVOICE_BUSINESSES.map((b) => period({
    id: `m:${b}.ap.invoiced`, label: `Supplier invoices received by the ${b} business`, unit: 'usd', divisions: ['finance'], source: 'invoices',
    agg: { kind: 'sum', field: 'amount_usd' }, where: { business: b },
  })),
  period({ id: 'm:combined.dq.rejected_invoices', business: 'combined', label: 'Supplier invoice rows rejected by data checks', unit: 'count', divisions: ['finance', 'hq'], source: 'invoices', agg: { kind: 'rejected' }, nouns: ROWS }),
];

/** Standing numbers: as of the data date, whatever period is asked. */
export const OPS_STANDING: MetricDef[] = [
  standing({
    id: 'm:online.service.waiting_now.count', label: 'Customer messages from the last week still waiting for a first answer', unit: 'count', divisions: ['online', 'hq'],
    source: 'messages', agg: { kind: 'count' }, where: INBOUND, test: isNullCond('first_reply_at'), window: LAST_WEEK, nouns: MESSAGES,
    about: `Messages that came in the seven days ending on the data date, ${AS_OF}, with no answer by its end.`,
  }),
  standing({
    id: 'm:online.service.waiting_over_24h.count', label: 'Customer messages from the last week waiting over a day for a first answer', unit: 'count', divisions: ['online', 'hq'],
    source: 'messages', agg: { kind: 'count' }, where: INBOUND, test: both(isNullCond('first_reply_at'), { sql: `received_at < '${AS_OF} 00:00:00'`, js: (r) => str(r, 'received_at') < `${AS_OF} 00:00:00` }),
    window: LAST_WEEK, nouns: MESSAGES, about: 'Came at least 24 hours before the end of the data date, in the seven days ending on it, and still has no answer.',
  }),
  standing({ id: 'm:salon.repairs.open.count', label: 'Repairs not finished yet', unit: 'count', divisions: ['salon', 'hq'], source: 'repairs', agg: { kind: 'count' }, test: STILL_OPEN, nouns: ['repair', 'repairs', 'ticket', 'tickets'], about: 'Waiting for payment or in repair on the data date.' }),
  standing({
    id: 'm:salon.repairs.open_over_14d.count', label: 'Repairs open longer than two weeks', unit: 'count', divisions: ['salon', 'hq'], source: 'repairs', agg: { kind: 'count' },
    test: both(STILL_OPEN, { sql: `DATEDIFF('${AS_OF}', received_date) > 14`, js: (r) => days(str(r, 'received_date'), AS_OF) > 14 }),
    nouns: ['repair', 'repairs', 'ticket', 'tickets'], about: 'Not finished, and arrived more than 14 days before the data date.',
  }),
  ...INVOICE_BUSINESSES.flatMap((b): MetricDef[] => {
    const mine = { source: 'invoices', where: { business: b }, agg: { kind: 'sum', field: 'amount_usd' } } as const;
    const overdue = both(UNPAID, { sql: `due_date < '${AS_OF}'`, js: (r) => str(r, 'due_date') < AS_OF });
    return [
      standing({ id: `m:${b}.ap.open`, label: `Owed on unpaid ${b} supplier invoices`, unit: 'usd', divisions: ['finance'], ...mine, test: UNPAID }),
      standing({
        id: `m:${b}.ap.due_30d`, label: `Owed on ${b} supplier invoices due in the next thirty days`, unit: 'usd', divisions: ['finance'], ...mine,
        test: both(UNPAID, { sql: `due_date >= '${AS_OF}' AND due_date <= '${inDays(30)}'`, js: (r) => str(r, 'due_date') >= AS_OF && str(r, 'due_date') <= inDays(30) }),
        about: `Unpaid and due from the data date, ${AS_OF}, to ${inDays(30)}.`,
      }),
      standing({ id: `m:${b}.ap.overdue`, label: `Owed on overdue ${b} supplier invoices`, unit: 'usd', divisions: ['finance', 'hq'], ...mine, test: overdue, about: `Unpaid and due before the data date, ${AS_OF}.` }),
      standing({ id: `m:${b}.ap.overdue.count`, label: `Overdue ${b} supplier invoices`, unit: 'count', divisions: ['finance', 'hq'], ...mine, agg: { kind: 'count' }, test: overdue, nouns: ['invoice', 'invoices'] }),
    ];
  }),
];
