import { PERIOD_KEYS, type Period } from '@fahq/contracts';
import { describe, expect, it } from 'vitest';
import { CUSTOMER_METRICS, CUSTOMER_SOURCE_NAMES, CUSTOMER_STANDING, YEAR_TO_DATE } from '../src/customers.ts';
import { CATALOG_V2, attentionFor } from '../src/divisions.ts';
import { SOURCES, financeViewBody, specOf } from '../src/finance-sql.ts';
import { computeLayers, standingViewBody } from '../src/layers.ts';
import { AS_OF, PERIODS, generateYear, type InboxMessage } from '../src/synthetic.ts';

// The customers wave 2 adds for Online (docs/wave2.md, items 4 and 5): who placed each order, got each refund and sent
// each message, the reviews, Emma's reply speed and the duplicated messages. Each number is counted again here straight
// from the rows, in plain TypeScript that does not reuse the oracle's window or aggregates, so the live proof compares
// Zetaris with something known to be right.

const year = generateYear();
const layers = computeLayers(year);
const at = (p: Period, id: string) => layers.period.get(p)!.get(id);
const standing = (id: string) => layers.standing.get(id);
const inPeriod = (p: Period, day: string) => day >= PERIODS[p].from && day <= PERIODS[p].to;
const minutes = (from: string, to: string) => (Date.parse(`${to.replace(' ', 'T')}Z`) - Date.parse(`${from.replace(' ', 'T')}Z`)) / 60_000;
const good = <T extends object>(source: 'orders' | 'refunds' | 'messages' | 'reviews', xs: readonly T[]) => xs.filter((r) => specOf(source, 2).valid(r as Record<string, unknown>));

describe('the customers: who placed, got and sent what', () => {
  const orders = new Map(year.online.orders.map((o) => [o.order_id, o]));

  it('names a synthetic customer on every order, refund and message, and never moves a row', () => {
    for (const rows of [year.online.orders, year.online.refunds, year.support.messages, year.online.reviews]) {
      for (const r of rows) expect(r.customer_id, JSON.stringify(r).slice(0, 60)).toMatch(/^demo-cu-[a-z]\d{5}$/);
    }
    // A refund goes to the order's customer; a message that led to an order came from that order's customer.
    for (const f of year.online.refunds) expect(f.customer_id, f.refund_id).toBe(orders.get(f.order_id)!.customer_id);
    for (const m of year.support.messages.filter((x) => x.converted_order_id)) expect(m.customer_id, m.message_id).toBe(orders.get(m.converted_order_id!)!.customer_id);
    // The shop's follow-up goes to the customer of the thread it follows up.
    const threads = new Map(year.support.messages.filter((m) => m.direction === 'inbound').map((m) => [m.thread_id, m.customer_id]));
    for (const m of year.support.messages.filter((x) => x.direction === 'outbound')) expect(m.customer_id, m.message_id).toBe(threads.get(m.thread_id));
    // Some customers order more than once.
    const perCustomer = new Map<string, number>();
    for (const o of year.online.orders) perCustomer.set(o.customer_id, (perCustomer.get(o.customer_id) ?? 0) + 1);
    expect([...perCustomer.values()].filter((n) => n > 1).length).toBeGreaterThan(50);
  });

  it('says who answered exactly the messages that were answered, from the fixed list', () => {
    for (const m of year.support.messages) expect(m.answered_by === null, m.message_id).toBe(m.first_reply_at === null);
    const answered = year.support.messages.filter((m) => m.answered_by !== null);
    const share = (who: string) => answered.filter((m) => m.answered_by === who).length / answered.length;
    expect(share('emma')).toBeGreaterThan(0.5);
    for (const who of ['salon', 'other']) expect(share(who), who).toBeGreaterThan(0.05);
    expect(share('auto')).toBeGreaterThan(0.005); // only chats answered within two minutes
  });
});

describe('the customers: data-quality rules', () => {
  it('reject exactly the one planted row of the reviews, and count it in its own month only', () => {
    for (const source of CUSTOMER_SOURCE_NAMES) {
      const all = year.online.reviews;
      const bad = all.filter((r) => r.review_id.includes('-bad-'));
      expect(bad).toHaveLength(1);
      expect(all.filter((r) => !SOURCES[source].valid(r)), source).toEqual(bad);
      const month = PERIOD_KEYS.find((p) => inPeriod(p, bad[0]!.review_date))!;
      for (const p of PERIOD_KEYS) expect(at(p, 'm:online.dq.rejected_reviews'), p).toBe(p === month ? 1 : 0);
    }
  });

  it('reject an order, refund or message with no customer, and a message whose answerer does not match its answer', () => {
    const [o, f, m] = [year.online.orders[0]!, year.online.refunds[0]!, year.support.messages.find((x) => x.answered_by === 'emma')!];
    expect(specOf('orders', 2).valid(o)).toBe(true);
    expect(specOf('orders', 2).valid({ ...o, customer_id: null })).toBe(false);
    expect(specOf('orders', 1).valid({ ...o, customer_id: null })).toBe(true); // version 1's rule is frozen
    expect(specOf('refunds', 2).valid({ ...f, customer_id: 'someone' })).toBe(false);
    expect(specOf('messages', 2).valid(m)).toBe(true);
    expect(specOf('messages', 2).valid({ ...m, answered_by: null })).toBe(false);
    expect(specOf('messages', 2).valid({ ...m, first_reply_at: null })).toBe(false);
    expect(specOf('messages', 2).valid({ ...m, answered_by: 'bot' })).toBe(false);
    expect(specOf('messages', 2).validSql).toContain("(answered_by IS NULL) = (first_reply_at IS NULL)");
  });

  it('serve every new metric in every one of the thirteen periods, and the standing one', () => {
    for (const p of PERIOD_KEYS) for (const m of CUSTOMER_METRICS) expect(layers.period.get(p)!.has(m.id), `${m.id} ${p}`).toBe(true);
    for (const m of CUSTOMER_STANDING) expect(layers.standing.has(m.id), m.id).toBe(true);
    for (const m of CATALOG_V2.filter((x) => ['minutes', 'days', 'seconds', 'score'].includes(x.unit))) expect(m.planUse, m.id).toBe(false);
  });
});

describe('the reviews and the repeat returners', () => {
  const reviews = good('reviews', year.online.reviews);

  it('count, rate low and average each period from its own reviews', () => {
    let low = 0;
    for (const p of PERIOD_KEYS) {
      const mine = reviews.filter((v) => inPeriod(p, v.review_date));
      expect(at(p, 'm:online.reviews.count'), p).toBe(mine.length);
      expect(at(p, 'm:online.reviews.low_rating.count'), p).toBe(mine.filter((v) => v.rating <= 2).length);
      expect(at(p, 'm:online.reviews.avg_rating'), p).toBe(Math.round((mine.reduce((t, v) => t + v.rating, 0) / mine.length) * 100) / 100);
      low += mine.filter((v) => v.rating <= 2).length;
    }
    expect(low).toBeGreaterThan(0);
    // A review is of a product the customer's order had, and comes after it.
    const lines = new Set(year.online.orderLines.map((l) => `${l.order_id}|${l.sku}`));
    const orders = new Map(year.online.orders.map((o) => [o.order_id, o]));
    for (const v of reviews) {
      expect(lines.has(`${v.order_id}|${v.sku}`), v.review_id).toBe(true);
      expect(orders.get(v.order_id)!.customer_id, v.review_id).toBe(v.customer_id);
      expect(v.review_date > orders.get(v.order_id)!.order_date && v.review_date <= AS_OF, v.review_id).toBe(true);
    }
  });

  it('counts the customers refunded twice or more in the 365 days to the data date, and the rule fires', () => {
    const refunds = good('refunds', year.online.refunds).filter((f) => f.refund_date >= YEAR_TO_DATE.from && f.refund_date <= AS_OF);
    expect(YEAR_TO_DATE.from).toBe('2025-10-27');
    const per = new Map<string, number>();
    for (const f of refunds) per.set(f.customer_id, (per.get(f.customer_id) ?? 0) + 1);
    const repeat = [...per.values()].filter((n) => n >= 2).length;
    expect(standing('m:online.returns.repeat_customers.count')).toBe(repeat);
    expect(repeat).toBeGreaterThanOrEqual(5);
    expect(attentionFor([{ id: 'm:online.returns.repeat_customers.count', value: repeat }])).toEqual([
      { metricId: 'm:online.returns.repeat_customers.count', level: 'watch', rule: 'Some customers have sent orders back again and again this year.' },
    ]);
    expect(standingViewBody()).toContain(`COUNT(CASE WHEN p0 >= 2 THEN 1 END)`);
  });
});

describe("the inbox: Emma's reply speed and the duplicated messages", () => {
  const inbound = good('messages', year.support.messages).filter((m) => m.direction === 'inbound');

  it("Emma's share answered within the hour and her median minutes, each period from her own first answers", () => {
    for (const p of PERIOD_KEYS) {
      const hers = inbound.filter((m) => m.answered_by === 'emma' && inPeriod(p, m.received_date)).map((m) => minutes(m.received_at, m.first_reply_at!));
      expect(at(p, 'm:online.service.emma.replied_1h.share'), p).toBe(Math.round((hers.filter((x) => x <= 60).length / hers.length) * 10_000) / 10_000);
      const xs = [...hers].sort((a, b) => a - b);
      const mid = xs.length % 2 ? xs[(xs.length - 1) / 2]! : (xs[xs.length / 2 - 1]! + xs[xs.length / 2]!) / 2;
      expect(at(p, 'm:online.service.emma.first_reply_minutes'), p).toBe(Math.round(mid * 10) / 10);
    }
  });

  /** Counted by brute force: each inbound message against the same customer's latest earlier one on the same topic. */
  function duplicates(): { message: InboxMessage; first: InboxMessage }[] {
    const all = year.support.messages.filter((m) => m.direction === 'inbound');
    const key = (m: InboxMessage) => `${m.received_at}|${m.message_id}`;
    return inbound.flatMap((m) => {
      const earlier = all.filter((e) => e.customer_id === m.customer_id && e.intent === m.intent && key(e) < key(m)).sort((a, b) => (key(a) < key(b) ? 1 : -1));
      const first = earlier[0];
      if (!first || first.channel === m.channel || minutes(first.received_at, m.received_at) > 1440) return [];
      if (first.first_reply_at !== null && first.first_reply_at <= m.received_at) return [];
      return [{ message: m, first }];
    });
  }

  it('counts each period the messages sent again on another channel within a day, before the first was answered, and those answered twice', () => {
    const found = duplicates();
    for (const p of PERIOD_KEYS) {
      const mine = found.filter((d) => inPeriod(p, d.message.received_date));
      expect(at(p, 'm:online.service.duplicate.count'), p).toBe(mine.length);
      expect(at(p, 'm:online.service.answered_twice.count'), p).toBe(mine.filter((d) => d.message.first_reply_at !== null && d.first.first_reply_at !== null).length);
    }
    expect(found.length).toBeGreaterThan(30);
    expect(found.filter((d) => d.message.first_reply_at !== null && d.first.first_reply_at !== null).length).toBeGreaterThan(10);
  });

  it('reads the inbox once in the period view, through the window that finds each customer\'s previous message', () => {
    const body = financeViewBody(2);
    expect(body.split('fortune_hq_v2.support_messages ').length - 1).toBe(1);
    expect(body).toContain('LAG(channel) OVER (PARTITION BY customer_id, intent, direction ORDER BY received_at, message_id) AS prev_channel');
    expect(body).toContain('ROUND(percentile(CASE WHEN');
    expect(financeViewBody(1)).not.toContain('LAG(');
  });
});
