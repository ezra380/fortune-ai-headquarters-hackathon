import { PERIOD_KEYS, type Period } from '@fahq/contracts';
import { describe, expect, it } from 'vitest';
import { SOURCES, VERSIONS, financeViewBody, sourceRows, specOf } from '../src/finance-sql.ts';
import { computeLayers, standingViewBody } from '../src/layers.ts';
import { OPS_METRICS, OPS_SOURCE_NAMES, OPS_STANDING } from '../src/operations.ts';
import { PERIODS, generateYear } from '../src/synthetic.ts';

// The day-to-day systems version 2 adds: each source's data-quality rule and its one planted bad row, and
// the oracle's numbers checked here against the rows directly, so the live proof (Zetaris against the
// oracle) compares Zetaris with something already known to be right.

const year = generateYear();
const rows = sourceRows(year);
const layers = computeLayers(year);
const at = (p: Period, id: string) => layers.period.get(p)!.get(id);
const standing = (id: string) => layers.standing.get(id);
const SEPT = PERIODS['2026-09'];
const inSept = (d: string) => d >= SEPT.from && d <= SEPT.to;
const total = (xs: readonly number[]) => Math.round(xs.reduce((t, x) => t + x, 0) * 100) / 100;
const rejectedId = (source: string) => [...OPS_METRICS].find((m) => m.source === source && m.agg.kind === 'rejected')!.id;

describe('data-quality rules of the day-to-day systems', () => {
  it('reject exactly the one planted row of each source, and count it in its own month only', () => {
    for (const source of OPS_SOURCE_NAMES) {
      const all = rows[source];
      const bad = all.filter((r) => String(Object.values(r)[0]).includes('-bad-'));
      expect(bad, source).toHaveLength(1);
      expect(SOURCES[source].valid(bad[0]!), source).toBe(false);
      expect(all.filter((r) => !SOURCES[source].valid(r)), source).toEqual(bad);
      const day = String(bad[0]![SOURCES[source].date]);
      const month = PERIOD_KEYS.find((p) => day >= PERIODS[p].from && day <= PERIODS[p].to)!;
      for (const p of PERIOD_KEYS) expect(at(p, rejectedId(source)), `${source} ${p}`).toBe(p === month ? 1 : 0);
    }
  });

  it('say in SQL what they say in TypeScript, and the period view reads each source once', () => {
    const body = financeViewBody(2);
    for (const source of OPS_SOURCE_NAMES) {
      expect(body.split(`fortune_hq_v2.${SOURCES[source].table} `).length - 1, source).toBe(1);
      expect(body).toContain(SOURCES[source].validSql);
    }
    expect(SOURCES.messages.validSql).toContain('(first_reply_at IS NULL OR first_reply_at >= received_at)');
    expect(SOURCES.checkouts.validSql).toContain("(recovered_via = 'none') = (recovered_order_id IS NULL)");
    expect(SOURCES.invoices.validSql).toContain('due_date >= invoice_date');
    expect(SOURCES.repairs.validSql).toContain('(completed_date IS NULL OR completed_date >= received_date)');
    // Reply times come from DATEDIFF and the clock digits, never from a time-zone dependent timestamp.
    expect(body).not.toMatch(/unix_timestamp|to_timestamp|current_date|now\(\)/i);
    expect(standingViewBody()).not.toMatch(/current_date|now\(\)/i);
  });

  it('serve every new metric in every one of the thirteen periods, and every standing one', () => {
    for (const p of PERIOD_KEYS) for (const m of OPS_METRICS) expect(layers.period.get(p)!.has(m.id), `${m.id} ${p}`).toBe(true);
    for (const m of OPS_STANDING) expect(layers.standing.has(m.id), m.id).toBe(true);
    for (const p of PERIOD_KEYS) for (const id of ['m:online.contribution', 'm:online.refund_rate']) expect(layers.derived.get(p)!.has(id), `${id} ${p}`).toBe(true);
    expect(VERSIONS[1].metrics.some((m) => OPS_METRICS.includes(m))).toBe(false);
  });
});

describe('the online numbers (the oracle, checked against the rows)', () => {
  it('total fees, shipping and refunds from their own rows, the planted rows left out', () => {
    const costs = year.online.orderCosts.filter((c) => inSept(c.order_date));
    expect(at('2026-09', 'm:online.fees.payment')).toBeCloseTo(total(costs.map((c) => c.payment_fee_usd)), 2);
    const may = year.online.orderCosts.filter((c) => c.order_date >= '2026-05-01' && c.order_date <= '2026-05-31' && c.shipping_cost_usd >= 0);
    expect(at('2026-05', 'm:online.shipping.cost')).toBeCloseTo(total(may.map((c) => c.shipping_cost_usd)), 2);
    const refunds = year.online.refunds.filter((r) => inSept(r.refund_date));
    expect(at('2026-09', 'm:online.refunds.total')).toBeCloseTo(total(refunds.map((r) => r.amount_usd)), 2);
    expect(at('2026-09', 'm:online.refunds.count')).toBe(refunds.length);
  });

  it('count left checkouts and those that came back as an order, and their share', () => {
    const sept = year.online.checkouts.filter((c) => inSept(c.created_date));
    const back = sept.filter((c) => c.recovered_order_id !== null);
    expect(at('2026-09', 'm:online.checkouts.abandoned.count')).toBe(sept.length);
    expect(at('2026-09', 'm:online.checkouts.recovered.count')).toBe(back.length);
    expect(at('2026-09', 'm:online.checkouts.recovered.value')).toBeCloseTo(total(back.map((c) => c.value_usd)), 2);
    expect(at('2026-09', 'm:online.checkouts.recovery_rate')).toBeCloseTo(back.length / sept.length, 4);
  });

  it("read stock on the period's last day: wanted means at least forty views in the week before", () => {
    const today = year.online.inventory.filter((s) => s.snapshot_date === '2026-10-26');
    expect(today).toHaveLength(60);
    const low = today.filter((s) => s.on_hand <= s.reorder_point);
    expect(at('2026-10-mtd', 'm:online.inventory.low_stock.count')).toBe(low.length);
    expect(at('2026-10-mtd', 'm:online.inventory.wanted_low_stock.count')).toBe(low.filter((s) => s.views_7d >= 40).length);
    expect(at('2026-10-mtd', 'm:online.inventory.wanted_out_of_stock.count')).toBe(today.filter((s) => s.on_hand === 0 && s.views_7d >= 40).length);
    expect(at('2026-10-mtd', 'm:online.inventory.wanted_low_stock.count')!).toBeGreaterThan(0);
  });

  it("time the inbox from each customer's message to the first answer, leaving out the shop's own follow-ups", () => {
    const minutes = (m: { received_at: string; first_reply_at: string | null }) =>
      m.first_reply_at === null ? null : (Date.parse(`${m.first_reply_at.replace(' ', 'T')}Z`) - Date.parse(`${m.received_at.replace(' ', 'T')}Z`)) / 60_000;
    const sept = year.support.messages.filter((m) => m.direction === 'inbound' && inSept(m.received_date));
    const within = (n: number) => sept.filter((m) => { const x = minutes(m); return x !== null && x <= n; }).length;
    const late = (n: number, xs = sept) => xs.filter((m) => { const x = minutes(m); return x === null || x > n; });
    expect(at('2026-09', 'm:online.service.inbound.count')).toBe(sept.length);
    expect(at('2026-09', 'm:online.service.replied_1h.share')).toBeCloseTo(within(60) / sept.length, 4);
    expect(at('2026-09', 'm:online.service.replied_24h.share')).toBeCloseTo(within(1440) / sept.length, 4);
    expect(at('2026-09', 'm:online.service.unanswered_48h.count')).toBe(late(2880).length);
    expect(at('2026-09', 'm:online.service.texts_unanswered_48h.count')).toBe(late(2880, sept.filter((m) => m.channel === 'sms' || m.channel === 'phone_text')).length);
    const buyers = sept.filter((m) => m.intent === 'purchase');
    expect(at('2026-09', 'm:online.service.sale_intent.count')).toBe(buyers.length);
    expect(at('2026-09', 'm:online.service.missed_sale_intent.count')).toBe(late(1440, buyers).filter((m) => m.converted_order_id === null).length);
    expect(year.support.messages.some((m) => m.direction === 'outbound' && inSept(m.received_date))).toBe(true);
  });

  it('count the messages of the last week still waiting, and those waiting over a day', () => {
    const week = year.support.messages.filter((m) => m.direction === 'inbound' && m.received_date >= '2026-10-20' && m.first_reply_at === null);
    expect(standing('m:online.service.waiting_now.count')).toBe(week.length);
    expect(standing('m:online.service.waiting_over_24h.count')).toBe(week.filter((m) => m.received_at < '2026-10-26 00:00:00').length);
    expect(standing('m:online.service.waiting_over_24h.count')!).toBeGreaterThan(0);
  });

  it('take contribution as gross profit less fees, shipping, refunds and all ad spend; the refund rate as refunds over revenue', () => {
    for (const p of ['2026-09', '2025-12'] as const) {
      const ads = ['google', 'meta', 'amazon'].reduce((t, ch) => t + at(p, `m:online.ads.${ch}.spend`)!, 0);
      const costs = at(p, 'm:online.fees.payment')! + at(p, 'm:online.shipping.cost')! + at(p, 'm:online.refunds.total')! + ads;
      expect(layers.derived.get(p)!.get('m:online.contribution')).toBeCloseTo(at(p, 'm:online.gross_profit')! - costs, 2);
      expect(layers.derived.get(p)!.get('m:online.refund_rate')).toBeCloseTo(at(p, 'm:online.refunds.total')! / at(p, 'm:online.revenue.total')!, 4);
    }
  });
});

describe('the salon and finance numbers (the oracle, checked against the rows)', () => {
  const tickets = year.salon.repairs.filter((t) => inSept(t.received_date));

  it("check version 2's appointment columns by version 2's rule only, and split the salon's money by location and labor", () => {
    const bad = year.salon.appointments.find((a) => a.appointment_id === 'demo-a-bad-location')!;
    expect(SOURCES.appointments.valid(bad)).toBe(true); // version 1's rule never sees the new columns
    expect(specOf('appointments', 2).valid(bad)).toBe(false);
    expect(specOf('appointments', 2).validSql.startsWith(SOURCES.appointments.validSql)).toBe(true);
    expect(PERIOD_KEYS.filter((p) => at(p, 'm:salon.dq.rejected_appointments') !== 0)).toEqual(['2026-04', '2026-09']); // the location row, demo-a-bad-price
    for (const p of ['2026-04', '2026-09', '2026-10-mtd'] as const) {
      const revenue = at(p, 'm:salon.revenue.total')!;
      expect(at(p, 'm:salon.revenue.brooklyn')! + at(p, 'm:salon.revenue.lakewood')!).toBeCloseTo(revenue, 1);
      expect(at(p, 'm:salon.gross_profit')).toBeCloseTo(revenue - at(p, 'm:salon.labor_cost')!, 1);
      const shows = at(p, 'm:salon.appointments.count')!;
      const noShows = at(p, 'm:salon.no_shows.count')!;
      expect(at(p, 'm:salon.no_show_rate')).toBeCloseTo(noShows / (shows + noShows), 4);
    }
    const sept = year.salon.appointments.filter((a) => inSept(a.appointment_date) && a.status === 'completed' && a.price_usd >= 0);
    expect(at('2026-09', 'm:salon.booked_online.share')).toBeCloseTo(sept.filter((a) => a.booked_via === 'online').length / sept.length, 4);
    expect(year.salon.appointments.filter((a) => a.status === 'no_show').every((a) => a.labor_cost_usd === 0)).toBe(true);
  });
  const finished = (t: (typeof tickets)[number]) => t.status === 'done' || t.status === 'shipped';

  it('take repair fees when paid, costs and margin when finished, turnaround of the tickets not cancelled', () => {
    expect(at('2026-09', 'm:salon.repairs.received.count')).toBe(tickets.length);
    expect(at('2026-09', 'm:salon.repairs.revenue')).toBeCloseTo(total(tickets.filter((t) => t.paid_date).map((t) => t.quote_usd)), 2);
    expect(at('2026-09', 'm:salon.repairs.cost')).toBeCloseTo(total(tickets.filter(finished).map((t) => t.parts_cost_usd + t.labor_cost_usd)), 2);
    const paidDone = tickets.filter((t) => t.paid_date && finished(t));
    const margin = paidDone.reduce((s, t) => s + t.quote_usd - t.parts_cost_usd - t.labor_cost_usd, 0) / paidDone.reduce((s, t) => s + t.quote_usd, 0);
    expect(at('2026-09', 'm:salon.repairs.margin')).toBeCloseTo(margin, 4);
    const kept = tickets.filter((t) => t.status !== 'cancelled');
    const fast = kept.filter((t) => t.completed_date && (Date.parse(t.completed_date) - Date.parse(t.received_date)) / 86_400_000 <= 14);
    expect(at('2026-09', 'm:salon.repairs.within_14d.share')).toBeCloseTo(fast.length / kept.length, 4);
    expect(at('2026-09', 'm:salon.repairs.online_intake.share')).toBeCloseTo(tickets.filter((t) => t.channel === 'online').length / tickets.length, 4);
  });

  it('count repairs still open on the data date, and those open more than two weeks', () => {
    const open = year.salon.repairs.filter((t) => t.status === 'open' || t.status === 'in_repair');
    expect(standing('m:salon.repairs.open.count')).toBe(open.length);
    const late = open.filter((t) => (Date.parse('2026-10-26') - Date.parse(t.received_date)) / 86_400_000 > 14);
    expect(standing('m:salon.repairs.open_over_14d.count')).toBe(late.length);
    expect(late.length).toBeGreaterThan(0);
  });

  it('keep each business its own: invoices received, owed, due within thirty days and overdue, the planted row left out', () => {
    const good = year.finance.invoices.filter((i) => !i.invoice_id.includes('-bad-'));
    for (const b of ['salon', 'online'] as const) {
      const mine = good.filter((i) => i.business === b);
      expect(at('2026-09', `m:${b}.ap.invoiced`)).toBeCloseTo(total(mine.filter((i) => inSept(i.invoice_date)).map((i) => i.amount_usd)), 2);
      const unpaid = mine.filter((i) => i.paid_date === null);
      expect(standing(`m:${b}.ap.open`)).toBeCloseTo(total(unpaid.map((i) => i.amount_usd)), 2);
      expect(standing(`m:${b}.ap.due_30d`)).toBeCloseTo(total(unpaid.filter((i) => i.due_date >= '2026-10-26' && i.due_date <= '2026-11-25').map((i) => i.amount_usd)), 2);
      const overdue = unpaid.filter((i) => i.due_date < '2026-10-26');
      expect(standing(`m:${b}.ap.overdue`)).toBeCloseTo(total(overdue.map((i) => i.amount_usd)), 2);
      expect(standing(`m:${b}.ap.overdue.count`)).toBe(overdue.length);
      expect(overdue.length).toBeGreaterThan(0);
    }
    // The planted invoice is unpaid and past due, yet counts nowhere: it falls due before it was issued.
    const bad = year.finance.invoices.find((i) => i.invoice_id === 'demo-inv-bad-due')!;
    expect(bad.paid_date === null && bad.due_date < '2026-10-26').toBe(true);
    expect(at('2026-01', 'm:combined.dq.rejected_invoices')).toBe(1);
  });
});
