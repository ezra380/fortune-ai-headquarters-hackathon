import type { Division } from '@fahq/contracts';
import type { MetricDef } from './finance-sql.ts';
import { REPLY_MINUTES_FIELD, answeredWithin, clock, inDays, moment } from './operations.ts';
import { ONE, both, counted, isNull, num, oneIf, oneOf, quoted, type Cond, type Row, type SourceSpec } from './sql.ts';
import { AS_OF, REVIEW_TOPICS } from './synthetic.ts';

// The customers wave 2 adds for Online (docs/wave2.md, items 4 and 5): the reviews (their own source, with its rule and
// a rejected-rows metric), the customers who send back again and again (from the refunds, which now name the
// customer), Emma's reply speed and the messages a customer sent twice (from the support inbox, which now names the
// customer and who answered). A customer is a synthetic id; no name, text or contact detail is anywhere. Who reads
// what keeps the asks of docs/wave2.md: returns and reviews are Online's and HQ's (Finance asks Georgette).

export const CUSTOMER_SOURCE_NAMES = ['reviews'] as const;
export type CustomerSource = (typeof CUSTOMER_SOURCE_NAMES)[number];

const str = (r: Row, k: string) => String(r[k]);
const startsWith = (r: Row, k: string, prefix: string) => !isNull(r[k]) && str(r, k).startsWith(prefix);

export const CUSTOMER_SOURCES: Record<CustomerSource, SourceSpec> = {
  reviews: {
    table: 'online_reviews', date: 'review_date',
    validSql: `rating >= 1 AND rating <= 5 AND topic IN (${quoted(REVIEW_TOPICS)}) AND order_id LIKE 'demo-o-%' AND customer_id LIKE 'demo-cu-%' AND sku LIKE 'demo-sku-%'`,
    valid: (r) => num(r, 'rating') >= 1 && num(r, 'rating') <= 5 && oneOf(REVIEW_TOPICS, r.topic) && startsWith(r, 'order_id', 'demo-o-')
      && startsWith(r, 'customer_id', 'demo-cu-') && startsWith(r, 'sku', 'demo-sku-'),
  },
};

// ---- The inbox's previous message (the period view's window, and its TypeScript twin) ----------

/** The columns the window adds to each message: the customer's previous message on the same topic, same direction. */
const PREVIOUS = ['channel', 'received_at', 'first_reply_at'] as const;

/** Each message with its previous message's channel and times (null for a customer's first), as the period view's LAG gives them. */
export function withPrevious(messages: readonly Row[]): Row[] {
  const order = (r: Row) => `${str(r, 'received_at')}|${str(r, 'message_id')}`;
  const last = new Map<string, Row>();
  const prev = new Map<Row, Row>();
  for (const m of [...messages].sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0))) {
    const key = `${str(m, 'customer_id')}|${str(m, 'intent')}|${str(m, 'direction')}`;
    const before = last.get(key);
    if (before) prev.set(m, before);
    last.set(key, m);
  }
  return messages.map((m) => ({ ...m, ...Object.fromEntries(PREVIOUS.map((c) => [`prev_${c}`, prev.get(m)?.[c] ?? null])) }));
}

/** Minutes from the previous message's arrival to this one's, from the date and clock digits (no time zone can shift it). */
const GAP_MINUTES = `(DATEDIFF(received_date, substr(prev_received_at, 1, 10)) * 1440 + ${clock('received_at')} - ${clock('prev_received_at')})`;

/**
 * A duplicate: the customer's previous message on the same topic came on another channel within the 24 hours before
 * this one, and had not been answered when this one came. Counted on the second message's day.
 */
export const DUPLICATE: Cond = {
  sql: `prev_channel IS NOT NULL AND prev_channel <> channel AND ${GAP_MINUTES} <= 1440 AND (prev_first_reply_at IS NULL OR prev_first_reply_at > received_at)`,
  js: (r) => !isNull(r.prev_channel) && r.prev_channel !== r.channel && (moment(r.received_at) - moment(r.prev_received_at)) / 60_000 <= 1440
    && (isNull(r.prev_first_reply_at) || str(r, 'prev_first_reply_at') > str(r, 'received_at')),
};
/** Both messages of a duplicate were answered (by the data date): two people did the same work. */
const ANSWERED_TWICE: Cond = both(DUPLICATE, {
  sql: 'first_reply_at IS NOT NULL AND prev_first_reply_at IS NOT NULL', js: (r) => !isNull(r.first_reply_at) && !isNull(r.prev_first_reply_at),
});

// ---- Metrics ------------------------------------------------------------------------------

const ROWS = ['row', 'rows'] as const;
const REVIEWS = ['review', 'reviews'] as const;
const MESSAGES = ['message', 'messages'] as const;
const ONLINE_HQ: readonly Division[] = ['online', 'hq'];
const LOW_RATING: Cond = { sql: 'rating <= 2', js: (r) => num(r, 'rating') <= 2 };
const BY_EMMA = { direction: 'inbound', answered_by: 'emma' };
/** The 365 days ending on the data date. */
export const YEAR_TO_DATE = { from: inDays(-364), to: AS_OF } as const;

type Def = Omit<MetricDef, 'layer' | 'since' | 'business'>;
const ofLayer = (layer: MetricDef['layer']) => (d: Def): MetricDef => ({ business: 'online', ...d, layer, since: 2 });
const period = ofLayer('period');
const standing = ofLayer('standing');

/** Period totals: the reviews by the day they were left, the inbox's new numbers by the day a message came. */
export const CUSTOMER_METRICS: MetricDef[] = [
  period({ id: 'm:online.reviews.count', label: 'Product reviews left', unit: 'count', divisions: ONLINE_HQ, source: 'reviews', agg: { kind: 'count' }, nouns: counted(REVIEWS, ['product', 'customer']) }),
  period({
    id: 'm:online.reviews.low_rating.count', label: 'Product reviews rated one or two', unit: 'count', divisions: ONLINE_HQ, source: 'reviews', agg: { kind: 'count' }, test: LOW_RATING,
    nouns: counted(REVIEWS, ['low-rated', 'low rating', 'bad']), about: 'A rating of 1 or 2 out of 5.',
  }),
  period({
    id: 'm:online.reviews.avg_rating', label: 'Average product review rating', unit: 'score', divisions: ONLINE_HQ, source: 'reviews', agg: { kind: 'avg', field: 'rating' },
    planUse: false, about: 'Out of 5, over the reviews left in the period.',
  }),
  period({ id: 'm:online.dq.rejected_reviews', label: 'Review rows rejected by data checks', unit: 'count', divisions: ONLINE_HQ, source: 'reviews', agg: { kind: 'rejected' }, nouns: counted(ROWS, ['review']) }),
  // The inbox: Emma's first answers, and customers who wrote twice about the same thing before anyone answered.
  period({
    id: 'm:online.service.emma.replied_1h.share', label: 'Messages Emma answered within the hour', unit: 'ratio', divisions: ['online'], source: 'messages',
    agg: { kind: 'ratio', num: oneIf(answeredWithin(60)), den: ONE }, where: BY_EMMA, about: 'Of the customer messages Emma gave the first answer to.',
  }),
  period({
    id: 'm:online.service.emma.first_reply_minutes', label: "Emma's usual time to a first answer (median)", unit: 'minutes', divisions: ['online'], source: 'messages',
    agg: { kind: 'median', field: REPLY_MINUTES_FIELD }, where: BY_EMMA, planUse: false,
    about: 'The median minutes from a customer message to its first answer, of the messages Emma answered first, by the day they came.',
  }),
  period({
    id: 'm:online.service.duplicate.count', label: 'Customer messages sent again on another channel before an answer', unit: 'count', divisions: ONLINE_HQ, source: 'messages',
    agg: { kind: 'count' }, where: { direction: 'inbound' }, test: DUPLICATE, nouns: counted(MESSAGES, ['duplicate', 'duplicated', 'repeated']),
    about: "The customer's previous message on the same topic came on another channel within the 24 hours before, and had not been answered yet.",
  }),
  period({
    id: 'm:online.service.answered_twice.count', label: 'Duplicated customer messages answered twice', unit: 'count', divisions: ['online'], source: 'messages',
    agg: { kind: 'count' }, where: { direction: 'inbound' }, test: ANSWERED_TWICE, nouns: counted(MESSAGES, ['answered-twice', 'double-answered']),
    about: 'Duplicated messages where both the first message and the second got an answer, by the data date.',
  }),
];

/** Standing numbers: the customers who sent back again and again, over the year to the data date. */
export const CUSTOMER_STANDING: MetricDef[] = [
  standing({
    id: 'm:online.returns.repeat_customers.count', label: 'Customers refunded twice or more in the last year', unit: 'count', divisions: ONLINE_HQ, source: 'refunds',
    agg: { kind: 'repeat', by: 'customer_id', atLeast: 2 }, window: YEAR_TO_DATE, nouns: counted(['returner', 'returners'], ['repeat']),
    about: `Two or more refunds issued in the 365 days ending on the data date, ${AS_OF}.`,
  }),
];

/** The oracle's twin of the 'repeat' aggregate: how many groups have at least `atLeast` rows. */
export function repeatGroups(rows: readonly Row[], by: string, atLeast: number): number {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(str(r, by), (counts.get(str(r, by)) ?? 0) + 1);
  return [...counts.values()].filter((n) => n >= atLeast).length;
}

/** The oracle's twin of the 'median' aggregate: Spark's exact percentile at one half (between the two middle values), to a tenth. */
export function median(values: readonly number[]): number | undefined {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (xs.length === 0) return undefined;
  const at = (xs.length - 1) / 2;
  const [lo, hi] = [xs[Math.floor(at)]!, xs[Math.ceil(at)]!];
  return Math.round((lo + (hi - lo) * (at - Math.floor(at))) * 10) / 10;
}
