import type { Period } from '@fahq/contracts';

// Seeded, deterministic synthetic business data. Every value is invented; shapes are realistic. Salon and
// online are separate sources, as in the real business. A few rows are deliberately bad (ids demo-*-bad-*)
// so the Zetaris data-quality rules have something to catch.
// Version 1 (generateBusiness) is Sept 1 to Oct 26, 2026, exactly what the live worker reads. Version 2
// (generateYear) adds, each from its own seeded stream so not one version 1 row moves: eleven months of
// history before it (generateHistory), Meta as a third ad channel and the finance owner's monthly budget
// sheet (generateDivisions), and the day-to-day systems each division runs on (generateOperations): order
// fees and shipping labels, refunds, abandoned checkouts, inventory with product interest, the support
// inbox, salon repair tickets and supplier invoices.
// No source has a medical or hair-loss field or value (Fortune rule 6), and the support inbox has no body.

export type { Period };

/** Every period's first and last day. They never overlap, so a row's date names exactly one period. */
export const PERIODS: Record<Period, { from: string; to: string }> = {
  '2025-10': { from: '2025-10-01', to: '2025-10-31' },
  '2025-11': { from: '2025-11-01', to: '2025-11-30' },
  '2025-12': { from: '2025-12-01', to: '2025-12-31' },
  '2026-01': { from: '2026-01-01', to: '2026-01-31' },
  '2026-02': { from: '2026-02-01', to: '2026-02-28' },
  '2026-03': { from: '2026-03-01', to: '2026-03-31' },
  '2026-04': { from: '2026-04-01', to: '2026-04-30' },
  '2026-05': { from: '2026-05-01', to: '2026-05-31' },
  '2026-06': { from: '2026-06-01', to: '2026-06-30' },
  '2026-07': { from: '2026-07-01', to: '2026-07-31' },
  '2026-08': { from: '2026-08-01', to: '2026-08-31' },
  '2026-09': { from: '2026-09-01', to: '2026-09-30' },
  '2026-10-mtd': { from: '2026-10-01', to: '2026-10-26' },
};

/** The data date: the last day the synthetic rows cover. Standing numbers are "as of" it. */
export const AS_OF = PERIODS['2026-10-mtd'].to;
/** The first moment after the data date, in the timestamp format the support inbox uses. Nothing happens later. */
export const AS_OF_END = '2026-10-27 00:00:00';
/** The seven days ending on the data date. */
export const LAST_WEEK = { from: '2026-10-20', to: AS_OF } as const;

export const PRODUCT_LINES = ['fortune', 'mazali', 'tuni', 'accessories'] as const;
export const ONLINE_CHANNELS = ['google', 'amazon', 'email', 'direct'] as const;
export const SALON_SERVICES = ['wash_set', 'cut_style', 'repair', 'consignment_intake', 'color', 'fortune_appointment'] as const;
/** The ad channels: Google and Amazon since version 1, Meta from version 2. */
export const AD_CHANNELS = ['google', 'meta', 'amazon'] as const;
export type AdChannel = (typeof AD_CHANNELS)[number];
// The day-to-day systems' values (version 2). No intent, reason or type names a medical matter.
export const REFUND_REASONS = ['return', 'damage', 'other'] as const;
export const RECOVERY_CHANNELS = ['email_flow', 'sms', 'none'] as const;
/** The support inbox: support@ email, the shop's two texting numbers and the site chat. */
export const MESSAGE_CHANNELS = ['email', 'sms', 'phone_text', 'chat'] as const;
export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const;
export const MESSAGE_INTENTS = ['order_status', 'repair', 'consignment', 'product_question', 'purchase', 'return', 'other'] as const;
export const REPAIR_TYPES = ['cap_repair', 'wefting', 'lace', 'restyle', 'color_fix'] as const;
export const REPAIR_STATUSES = ['open', 'in_repair', 'done', 'shipped', 'cancelled'] as const;
export const REPAIR_CHANNELS = ['online', 'walk_in'] as const;
export const SALON_LOCATIONS = ['brooklyn', 'lakewood'] as const;
/** How a salon visit was booked: the online store's booking page, a call, or at the door. */
export const BOOKING_CHANNELS = ['online', 'phone', 'walk_in'] as const;
/** The two businesses a supplier invoice can belong to; an invoice is never split between them. */
export const INVOICE_BUSINESSES = ['salon', 'online'] as const;
export const SUPPLIERS = ['demo-sup-s1', 'demo-sup-s2', 'demo-sup-s3', 'demo-sup-s4'] as const;

/** Every enumerated column of every source, by column name, with its allowed values (the no-medical guard reads it). */
export const SOURCE_ENUMS = {
  product_line: PRODUCT_LINES, channel: [...ONLINE_CHANNELS, ...AD_CHANNELS, ...MESSAGE_CHANNELS, ...REPAIR_CHANNELS],
  service: SALON_SERVICES, reason: REFUND_REASONS, recovered_via: RECOVERY_CHANNELS, direction: MESSAGE_DIRECTIONS, booked_via: BOOKING_CHANNELS,
  intent: MESSAGE_INTENTS, repair_type: REPAIR_TYPES, status: [...REPAIR_STATUSES, 'completed', 'no_show', 'approved', 'proposed'],
  location: SALON_LOCATIONS, business: INVOICE_BUSINESSES, supplier_id: SUPPLIERS, kind: ['flow', 'campaign'],
} as const;

/**
 * Invented seasonality: how busy each calendar month is (1 = January), against Sept and Oct, which are 1
 * because version 1's rows were drawn at the base rate. The autumn holidays and Passover lift the salon,
 * November and December gifts lift the store, high summer is quiet. Not the business's real pattern.
 */
export const SEASON: Record<'salon' | 'online', Record<number, number>> = {
  salon: { 1: 0.7, 2: 0.75, 3: 0.95, 4: 1.05, 5: 0.8, 6: 0.8, 7: 0.65, 8: 0.75, 9: 1, 10: 1, 11: 0.8, 12: 0.75 },
  online: { 1: 0.7, 2: 0.75, 3: 0.95, 4: 1, 5: 0.8, 6: 0.75, 7: 0.7, 8: 0.8, 9: 1, 10: 1, 11: 1.1, 12: 1.15 },
};

export type OnlineOrder = {
  order_id: string; order_date: string; product_line: string; channel: string;
  units: number; gross_usd: number; discount_usd: number; net_usd: number; cost_usd: number;
};
export type SalonAppointment = {
  appointment_id: string; appointment_date: string; service: string; stylist_id: string;
  price_usd: number; duration_min: number; status: 'completed' | 'no_show';
};
/** Version 2's appointment: every version 1 column and value unchanged, plus where it was, how it was booked and the stylist's labor cost. */
export type SalonVisit = SalonAppointment & { location: string; booked_via: string; labor_cost_usd: number };
export type AdDay = {
  ad_id: string; ad_date: string; channel: AdChannel; keyword: string;
  spend_usd: number; clicks: number; conversions: number; revenue_usd: number;
};
export type EmailDay = {
  email_id: string; send_date: string; kind: 'flow' | 'campaign'; name: string;
  sends: number; opens: number; clicks: number; revenue_usd: number;
};
/** One line of the finance owner's monthly budget sheet: a cap per ad channel; only approved caps count. */
export type BudgetRow = {
  budget_id: string; month_start: string; channel: AdChannel; cap_usd: number; status: 'approved' | 'proposed';
};
/** One order's payment fee (the payments export) and shipping label cost (the label account): money the order cost. */
export type OrderCost = { cost_id: string; order_id: string; order_date: string; payment_fee_usd: number; shipping_cost_usd: number };
/** A refund issued by hand in the store, against one order. */
export type Refund = { refund_id: string; order_id: string; refund_date: string; amount_usd: number; reason: (typeof REFUND_REASONS)[number] };
/** A checkout left before paying; recovered when a later order came from it (the order id and the message that won it back). */
export type Checkout = {
  checkout_id: string; created_date: string; product_line: string; value_usd: number;
  recovered_via: (typeof RECOVERY_CHANNELS)[number]; recovered_order_id: string | null;
};
/** One product's stock on a snapshot date, with how many people looked at it and added it to a cart in the week before. */
export type InventorySnapshot = {
  snapshot_id: string; snapshot_date: string; sku: string; product_line: string;
  on_hand: number; reorder_point: number; views_7d: number; add_to_cart_7d: number;
};
/**
 * One message in the support inbox: when it came (or, outbound, when the shop sent it), when the shop first
 * answered, what it was about, and the order it led to. There is deliberately no body: the numbers never need it.
 */
export type SupportMessage = {
  message_id: string; thread_id: string; channel: (typeof MESSAGE_CHANNELS)[number]; direction: (typeof MESSAGE_DIRECTIONS)[number];
  received_date: string; received_at: string; first_reply_at: string | null; intent: (typeof MESSAGE_INTENTS)[number]; converted_order_id: string | null;
};
/** A repair ticket from the ops app: how it came in, each step's date (none yet when it has not happened), its quote and costs. */
export type RepairTicket = {
  ticket_id: string; channel: (typeof REPAIR_CHANNELS)[number]; location: (typeof SALON_LOCATIONS)[number]; repair_type: (typeof REPAIR_TYPES)[number];
  received_date: string; quoted_date: string | null; paid_date: string | null; completed_date: string | null; shipped_date: string | null;
  status: (typeof REPAIR_STATUSES)[number]; quote_usd: number; parts_cost_usd: number; labor_cost_usd: number;
};
/** A factory's invoice to one business (never split between them): what is owed, when it is due, when it was paid. */
export type SupplierInvoice = {
  invoice_id: string; supplier_id: string; business: (typeof INVOICE_BUSINESSES)[number]; product_line: string;
  invoice_date: string; due_date: string; paid_date: string | null; amount_usd: number;
};
export type SyntheticBusiness = {
  generatedFor: string; seed: number;
  online: { orders: OnlineOrder[] };
  salon: { appointments: SalonAppointment[] };
  marketing: { ads: AdDay[]; email: EmailDay[] };
};
/** The day-to-day systems version 2 adds (generateOperations). */
export type Operations = {
  orderCosts: OrderCost[]; refunds: Refund[]; checkouts: Checkout[]; inventory: InventorySnapshot[];
  messages: SupportMessage[]; repairs: RepairTicket[]; invoices: SupplierInvoice[];
};
/** Version 2: thirteen months of every version 1 source, Meta among the ads, the budget sheet and the operations. */
export type SyntheticYear = Omit<SyntheticBusiness, 'salon'> & {
  online: Pick<Operations, 'orderCosts' | 'refunds' | 'checkouts' | 'inventory'>;
  salon: { appointments: SalonVisit[] } & Pick<Operations, 'repairs'>;
  support: Pick<Operations, 'messages'>;
  finance: { budgets: BudgetRow[] } & Pick<Operations, 'invoices'>;
};

/** mulberry32: tiny, fast, deterministic. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stream's random draws: uniform, between two bounds, and a Poisson count. */
function drawer(seed: number) {
  const r = rng(seed);
  const between = (lo: number, hi: number) => lo + (hi - lo) * r();
  const count = (mean: number) => { let n = 0; let p = Math.exp(-mean); let s = p; const u = r(); while (u > s) { n += 1; p *= mean / n; s += p; } return n; };
  return { r, between, count };
}

/** Its own seed for each named source (FNV-1a of the name), so adding a source never shifts another. */
function streamSeed(seed: number, name: string): number {
  let h = 0x811c9dc5;
  for (const ch of name) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  return (seed ^ h) >>> 0;
}

const cents = (n: number) => Math.round(n * 100) / 100;
/** A synthetic id: the prefix (ending in a letter) and a five-digit number. */
const seq = (prefix: string, n: number) => `${prefix}${String(n).padStart(5, '0')}`;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** A moment as the support inbox writes it: 'YYYY-MM-DD HH:MM:SS', minutes after midnight of `day`. */
const momentAt = (day: string, minutes: number) => new Date(Date.parse(`${day}T00:00:00Z`) + minutes * 60_000).toISOString().slice(0, 19).replace('T', ' ');
/** Picks one of `values` with the given weights (in the same order), from one uniform draw. */
function pick<T>(u: number, values: readonly T[], weights: readonly number[]): T {
  const total = weights.reduce((t, w) => t + w, 0);
  let edge = 0;
  for (let i = 0; i < values.length; i++) { edge += weights[i]! / total; if (u < edge) return values[i]!; }
  return values[values.length - 1]!;
}

function days(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

const monthOf = (day: string) => Number(day.slice(5, 7));
const seasonOf = (day: string) => ({ salon: SEASON.salon[monthOf(day)]!, online: SEASON.online[monthOf(day)]! });
const FLAT = { salon: 1, online: 1 };

// Invented price bands (USD) and margins; not the business's real prices.
const LINE = {
  fortune: { price: [2400, 4200], margin: 0.48, perDay: 0.35 },
  mazali: { price: [950, 1900], margin: 0.42, perDay: 0.9 },
  tuni: { price: [420, 880], margin: 0.38, perDay: 0.8 },
  accessories: { price: [18, 85], margin: 0.55, perDay: 2.2 },
} as const;
const SERVICE = {
  wash_set: { price: [65, 95], minutes: 60, perDay: 6 },
  cut_style: { price: [180, 300], minutes: 90, perDay: 2 },
  repair: { price: [120, 450], minutes: 120, perDay: 1.2 },
  consignment_intake: { price: [30, 30], minutes: 30, perDay: 0.4 },
  color: { price: [220, 520], minutes: 150, perDay: 0.8 },
  fortune_appointment: { price: [600, 1200], minutes: 120, perDay: 0.5 },
} as const;
const KEYWORDS = {
  google: ['demo human hair wig', 'demo sheitel online', 'demo european hair wig', 'demo wig topper'],
  amazon: ['demo wig brush', 'demo wig travel case', 'demo wig stand'],
  meta: ['demo lookalike buyers', 'demo product viewers', 'demo new season reel'],
} as const;
const EMAILS = [
  { kind: 'flow', name: 'Welcome (demo)' }, { kind: 'flow', name: 'Checkout recovery (demo)' },
  { kind: 'flow', name: 'Post-purchase care (demo)' }, { kind: 'campaign', name: 'Weekly edit (demo)' },
] as const;
/** Invented monthly ad budgets at the base season; each month's cap follows the store's season. */
const BUDGET_BASE: Record<AdChannel, number> = { google: 2300, meta: 1300, amazon: 500 };

/**
 * Orders, appointments, Google and Amazon ad days and email days for every day from `from` to `to`, each
 * draw in a fixed order. `tag` goes right before an id's digits (history ids read demo-o-h00001), and
 * `lift` scales the day's order, appointment and ad volumes (1 for version 1's own days).
 */
function businessDays(seed: number, from: string, to: string, tag: '' | 'h', lift: (day: string) => { salon: number; online: number }) {
  const { r, between, count } = drawer(seed);
  const id = (prefix: string, n: number) => `${prefix}-${tag}${String(n).padStart(5, '0')}`;
  const orders: OnlineOrder[] = [];
  const appointments: SalonAppointment[] = [];
  const ads: AdDay[] = [];
  const email: EmailDay[] = [];
  let o = 0, a = 0, ad = 0, e = 0;

  for (const day of days(from, to)) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay(); // 6 = Saturday: salon closed, fewer orders
    const { salon, online } = lift(day);
    for (const line of PRODUCT_LINES) {
      const spec = LINE[line];
      const n = count(spec.perDay * (weekday === 6 ? 0.4 : 1) * online);
      for (let i = 0; i < n; i++) {
        const units = line === 'accessories' ? 1 + Math.floor(r() * 3) : 1;
        const gross = cents(between(spec.price[0], spec.price[1]) * units);
        const discount = r() < 0.25 ? cents(gross * (r() < 0.5 ? 0.1 : 0.15)) : 0;
        const channel = ONLINE_CHANNELS[Math.floor(r() * ONLINE_CHANNELS.length)]!;
        orders.push({
          order_id: id('demo-o', ++o), order_date: day, product_line: line, channel, units,
          gross_usd: gross, discount_usd: discount, net_usd: cents(gross - discount), cost_usd: cents(gross * (1 - spec.margin)),
        });
      }
    }
    if (weekday !== 6) {
      for (const service of SALON_SERVICES) {
        const spec = SERVICE[service];
        const n = count(spec.perDay * (weekday === 5 ? 0.5 : 1) * salon);
        for (let i = 0; i < n; i++) {
          appointments.push({
            appointment_id: id('demo-a', ++a), appointment_date: day, service,
            stylist_id: `demo-s-${1 + Math.floor(r() * 4)}`, price_usd: cents(between(spec.price[0], spec.price[1])),
            duration_min: spec.minutes, status: r() < 0.04 ? 'no_show' : 'completed',
          });
        }
      }
    }
    for (const channel of ['google', 'amazon'] as const) {
      for (const keyword of KEYWORDS[channel]) {
        const spend = cents(between(channel === 'google' ? 8 : 2, channel === 'google' ? 28 : 9) * online);
        const clicks = Math.max(1, Math.round(spend / between(0.6, 1.8)));
        const conversions = r() < (channel === 'google' ? 0.08 : 0.3) ? 1 : 0;
        const revenue = conversions ? cents(channel === 'google' ? between(450, 1900) : between(20, 70)) : 0;
        ads.push({ ad_id: id('demo-ad', ++ad), ad_date: day, channel, keyword, spend_usd: spend, clicks, conversions, revenue_usd: revenue });
      }
    }
    for (const m of EMAILS) {
      if (m.kind === 'campaign' && weekday !== 2) continue; // one campaign a week, Tuesdays
      const sends = m.kind === 'campaign' ? Math.round(between(1800, 2400)) : Math.round(between(8, 40));
      const opens = Math.round(sends * between(0.35, 0.55));
      const clicks = Math.round(opens * between(0.04, 0.12));
      email.push({ email_id: id('demo-em', ++e), send_date: day, kind: m.kind, name: m.name, sends, opens, clicks, revenue_usd: r() < 0.3 ? cents(between(90, 1400)) : 0 });
    }
  }
  return { orders, appointments, ads, email };
}

const GENERATED_FOR = 'Fortune AI Headquarters (synthetic)';

/** Version 1: Sept 1 to Oct 26, 2026, with three planted bad rows. Its draws never change. */
export function generateBusiness(seed = 20261026): SyntheticBusiness {
  const { orders, appointments, ads, email } = businessDays(seed, PERIODS['2026-09'].from, PERIODS['2026-10-mtd'].to, '', () => FLAT);

  // Deliberately bad rows for the data-quality rule (never valid business data).
  orders.push(
    { order_id: 'demo-o-bad-negative', order_date: '2026-09-14', product_line: 'mazali', channel: 'direct', units: 1, gross_usd: -1200, discount_usd: 0, net_usd: -1200, cost_usd: 500 },
    { order_id: 'demo-o-bad-line', order_date: '2026-10-03', product_line: 'unknown_line', channel: 'google', units: 1, gross_usd: 999, discount_usd: 0, net_usd: 999, cost_usd: 400 },
  );
  appointments.push({ appointment_id: 'demo-a-bad-price', appointment_date: '2026-09-22', service: 'wash_set', stylist_id: 'demo-s-1', price_usd: -80, duration_min: 60, status: 'completed' });

  return { generatedFor: GENERATED_FOR, seed, online: { orders }, salon: { appointments }, marketing: { ads, email } };
}

/** Oct 1, 2025 to Aug 31, 2026: the same sources at the season's pace, from their own stream (no bad rows). */
export function generateHistory(seed = 20251001): SyntheticBusiness {
  const { orders, appointments, ads, email } = businessDays(seed, PERIODS['2025-10'].from, PERIODS['2026-08'].to, 'h', seasonOf);
  return { generatedFor: GENERATED_FOR, seed, online: { orders }, salon: { appointments }, marketing: { ads, email } };
}

/** Meta ad days for all thirteen periods, from their own stream. Ids read demo-ad-m00001. */
function metaAds(seed: number): AdDay[] {
  const { r, between } = drawer(streamSeed(seed, 'meta'));
  const out: AdDay[] = [];
  for (const day of days(PERIODS['2025-10'].from, PERIODS['2026-10-mtd'].to)) {
    for (const keyword of KEYWORDS.meta) {
      const spend = cents(between(6, 22) * seasonOf(day).online);
      const clicks = Math.max(1, Math.round(spend / between(0.4, 1.2)));
      const conversions = r() < 0.1 ? 1 : 0;
      const revenue = conversions ? cents(between(300, 1600)) : 0;
      out.push({ ad_id: `demo-ad-m${String(out.length + 1).padStart(5, '0')}`, ad_date: day, channel: 'meta', keyword, spend_usd: spend, clicks, conversions, revenue_usd: revenue });
    }
  }
  return out;
}

/**
 * The finance owner's budget sheet: an approved cap per channel per month (rounded to $50, following the
 * store's season), one proposed raise for October that is not approved and must never count, and one
 * planted bad row.
 */
function budgetSheet(seed: number): BudgetRow[] {
  const { between } = drawer(streamSeed(seed, 'budgets'));
  const out: BudgetRow[] = [];
  for (const period of Object.keys(PERIODS) as Period[]) {
    const month = PERIODS[period].from;
    for (const channel of AD_CHANNELS) {
      const cap = Math.round((BUDGET_BASE[channel] * seasonOf(month).online * between(0.95, 1.1)) / 50) * 50;
      out.push({ budget_id: `demo-bu-${channel}${month.slice(0, 7).replace('-', '')}`, month_start: month, channel, cap_usd: cap, status: 'approved' });
    }
  }
  const october = out.find((b) => b.budget_id === 'demo-bu-google202610')!;
  out.push(
    { budget_id: 'demo-bu-proposed-google202610', month_start: october.month_start, channel: 'google', cap_usd: october.cap_usd + 500, status: 'proposed' },
    { budget_id: 'demo-bu-bad-negative', month_start: '2026-03-01', channel: 'meta', cap_usd: -900, status: 'approved' },
  );
  return out;
}

/** The sources version 2 adds beside version 1's, each from its own stream. */
/** The seed of every source version 2 adds; each source draws its own stream from it by name. */
const DIVISIONS_SEED = 20261027;

export function generateDivisions(seed = DIVISIONS_SEED): { metaAds: AdDay[]; budgets: BudgetRow[] } {
  return { metaAds: metaAds(seed), budgets: budgetSheet(seed) };
}

// ---- The day-to-day systems (version 2) ---------------------------------------------------
// Each draws from its own named stream. Order fees, refunds, recovered checkouts and messages that led to a
// sale read the year's orders (for real order ids) but never draw from the orders' stream. Every source has
// rows in all thirteen periods and exactly one planted bad row (ids demo-*-bad-*).

const isSale = (o: OnlineOrder) => o.net_usd > 0 && (PRODUCT_LINES as readonly string[]).includes(o.product_line);
const notLater = (day: string | null) => (day !== null && day <= AS_OF ? day : null);
const isSaturday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay() === 6;
const YEAR_DAYS = () => days(PERIODS['2025-10'].from, AS_OF);

/** Picks the first sale of `line` (any line when not given) dated within `within` days after `day`, each sale at most once. */
function salePicker(orders: readonly OnlineOrder[]) {
  const byDay = new Map<string, OnlineOrder[]>();
  for (const o of orders.filter(isSale)) byDay.set(o.order_date, [...(byDay.get(o.order_date) ?? []), o]);
  const used = new Set<string>();
  return (day: string, within: number, line?: string): string | null => {
    for (let i = 0; i <= within; i++) {
      const o = byDay.get(addDays(day, i))?.find((x) => !used.has(x.order_id) && (!line || x.product_line === line));
      if (o) { used.add(o.order_id); return o.order_id; }
    }
    return null;
  };
}

/** Each sale's payment fee and shipping label (invented rates); the bad row is a voided label exported as a negative cost. */
function orderCosts(seed: number, orders: readonly OnlineOrder[]): OrderCost[] {
  const { between } = drawer(streamSeed(seed, 'order_costs'));
  const out = orders.filter(isSale).map((o, i): OrderCost => {
    const [rate, label] = [between(0.026, 0.032), o.product_line === 'accessories' ? between(5, 11) : between(18, 42)];
    return { cost_id: seq('demo-oc-c', i + 1), order_id: o.order_id, order_date: o.order_date, payment_fee_usd: cents(o.net_usd * rate + 0.3), shipping_cost_usd: cents(label) };
  });
  const may = out.find((c) => c.order_date >= '2026-05-12')!;
  out.push({ cost_id: 'demo-oc-bad-negative', order_id: may.order_id, order_date: may.order_date, payment_fee_usd: 0, shipping_cost_usd: -31.4 });
  return out;
}

/** About one sale in seventeen refunded, four to twenty-four days later: returns in full, damage and other in part. */
function refunds(seed: number, orders: readonly OnlineOrder[]): Refund[] {
  const { r, between } = drawer(streamSeed(seed, 'refunds'));
  const out: Refund[] = [];
  for (const o of orders.filter(isSale)) {
    const [u, lag, share] = [r(), Math.round(between(4, 24)), between(0.15, 0.5)];
    const refund_date = addDays(o.order_date, lag);
    if (u >= 0.06 || refund_date > AS_OF) continue;
    const reason = u < 0.042 ? 'return' : u < 0.054 ? 'damage' : 'other';
    out.push({ refund_id: seq('demo-rf-r', out.length + 1), order_id: o.order_id, refund_date, amount_usd: reason === 'return' ? o.net_usd : cents(o.net_usd * share), reason });
  }
  const june = orders.find((o) => isSale(o) && o.order_date >= '2026-06-10')!;
  out.push({ refund_id: 'demo-rf-bad-zero', order_id: june.order_id, refund_date: '2026-06-18', amount_usd: 0, reason: 'other' });
  return out;
}

/** About five checkouts left a day at the store's season; some come back as an order of the same line within three days. */
function checkouts(seed: number, orders: readonly OnlineOrder[]): Checkout[] {
  const { r, between, count } = drawer(streamSeed(seed, 'checkouts'));
  const recover = salePicker(orders);
  const out: Checkout[] = [];
  for (const day of YEAR_DAYS()) {
    for (let i = count(5 * seasonOf(day).online); i > 0; i--) {
      const line = pick(r(), PRODUCT_LINES, [0.12, 0.38, 0.3, 0.2]);
      const [value, u, via] = [cents(between(LINE[line].price[0], LINE[line].price[1])), r(), r() < 0.8 ? 'email_flow' : 'sms'] as const;
      const order = u < 0.16 ? recover(day, 3, line) : null;
      out.push({ checkout_id: seq('demo-ck-k', out.length + 1), created_date: day, product_line: line, value_usd: value, recovered_via: order ? via : 'none', recovered_order_id: order });
    }
  }
  out.push({ checkout_id: 'demo-ck-bad-recovery', created_date: '2026-02-11', product_line: 'tuni', value_usd: 640, recovered_via: 'email_flow', recovered_order_id: null });
  return out;
}

/** Sixty products: how many of each per line, the reorder point's range and the week's usual views (all invented). */
const CATALOG = {
  fortune: { n: 12, reorder: [1, 2], views: 30 }, mazali: { n: 18, reorder: [2, 4], views: 48 },
  tuni: { n: 14, reorder: [2, 4], views: 32 }, accessories: { n: 16, reorder: [8, 15], views: 22 },
} as const;

/** Each product's stock on every period's last day (the month so far: the data date), with the week's views and carts. */
function inventory(seed: number): InventorySnapshot[] {
  const { r, between } = drawer(streamSeed(seed, 'inventory'));
  const skus = PRODUCT_LINES.flatMap((line) => Array.from({ length: CATALOG[line].n }, (_, i) => {
    const [lo, hi] = CATALOG[line].reorder;
    const reorder = Math.round(between(lo, hi));
    return { sku: `demo-sku-${line[0]}${String(i + 1).padStart(2, '0')}`, line, reorder, onHand: reorder + Math.round(between(1, 3 * reorder + 2)), interest: between(0.4, 1.8) };
  }));
  const out: InventorySnapshot[] = [];
  for (const { to: day } of Object.values(PERIODS)) {
    for (const s of skus) {
      const [sold, restockDraw, restockSize, look, carts] = [between(0, s.reorder + 2), r(), between(2, 4), between(0.5, 1.6), between(0.03, 0.09)];
      const restock = s.onHand <= s.reorder && restockDraw < 0.6 ? Math.round(restockSize * s.reorder) + 1 : 0;
      s.onHand = Math.max(0, s.onHand + restock - Math.round(sold));
      const views = Math.round(CATALOG[s.line].views * s.interest * seasonOf(day).online * look);
      out.push({ snapshot_id: seq('demo-iv-s', out.length + 1), snapshot_date: day, sku: s.sku, product_line: s.line, on_hand: s.onHand, reorder_point: s.reorder, views_7d: views, add_to_cart_7d: Math.round(views * carts) });
    }
  }
  out.push({ snapshot_id: 'demo-iv-bad-negative', snapshot_date: '2026-04-30', sku: 'demo-sku-t03', product_line: 'tuni', on_hand: -3, reorder_point: 3, views_7d: 41, add_to_cart_7d: 2 });
  return out;
}

/** Minutes to the shop's first answer, by channel: the usual range, a slow range and how often each happens (invented). */
const REPLY: Record<(typeof MESSAGE_CHANNELS)[number], { fast: [number, number]; slow: [number, number]; slowShare: number; lostShare: number }> = {
  email: { fast: [20, 600], slow: [600, 3000], slowShare: 0.25, lostShare: 0.02 },
  sms: { fast: [3, 180], slow: [180, 3600], slowShare: 0.15, lostShare: 0.07 },
  phone_text: { fast: [3, 240], slow: [240, 4000], slowShare: 0.2, lostShare: 0.09 },
  chat: { fast: [1, 25], slow: [25, 900], slowShare: 0.1, lostShare: 0.03 },
};

/** Minutes to the first answer for one message, or null when it is never answered. */
function replyMinutes(channel: (typeof MESSAGE_CHANNELS)[number], speed: number, within: number): number | null {
  const { fast, slow, slowShare, lostShare } = REPLY[channel];
  if (speed < lostShare) return null;
  const [lo, hi] = speed < lostShare + slowShare ? slow : fast;
  return Math.round(lo + (hi - lo) * within);
}

/**
 * About twelve customer messages a day at the store's season, each its own thread, answered by channel (texts
 * are the ones that get lost), and sometimes a follow-up the shop sends later in the thread. An answer after
 * the data date has not happened yet. A purchase question answered within the day often leads to an order.
 */
function supportInbox(seed: number, orders: readonly OnlineOrder[]): SupportMessage[] {
  const { r, between, count } = drawer(streamSeed(seed, 'messages'));
  const convert = salePicker(orders);
  const out: SupportMessage[] = [];
  const add = (m: Omit<SupportMessage, 'message_id'>) => out.push({ message_id: seq('demo-msg-m', out.length + 1), ...m });
  let threads = 0;
  for (const day of YEAR_DAYS()) {
    for (let i = count(12 * seasonOf(day).online); i > 0; i--) {
      const [cu, iu, at, speed, within, buy, follow, later] = [r(), r(), Math.round(between(7 * 60, 23 * 60)), r(), r(), r(), r(), Math.round(between(18 * 60, 72 * 60))];
      const channel = pick(cu, MESSAGE_CHANNELS, [0.35, 0.25, 0.15, 0.25]);
      const intent = pick(iu, MESSAGE_INTENTS, [0.25, 0.1, 0.08, 0.25, 0.15, 0.07, 0.1]);
      const minutes = replyMinutes(channel, speed, within);
      const replied = minutes === null ? null : momentAt(day, at + minutes);
      const first_reply_at = replied !== null && replied < AS_OF_END ? replied : null;
      const sameDay = first_reply_at !== null && minutes! <= 1440;
      const converted_order_id = intent === 'purchase' && buy < (sameDay ? 0.45 : 0.1) ? convert(day, 5) : null;
      const thread_id = seq('demo-th-t', ++threads);
      add({ thread_id, channel, direction: 'inbound', received_date: day, received_at: momentAt(day, at), first_reply_at, intent, converted_order_id });
      const sent = momentAt(day, at + later);
      if (follow < 0.12 && sent < AS_OF_END) add({ thread_id, channel, direction: 'outbound', received_date: sent.slice(0, 10), received_at: sent, first_reply_at: null, intent, converted_order_id: null });
    }
  }
  out.push({
    message_id: 'demo-msg-bad-reply', thread_id: 'demo-th-bad', channel: 'sms', direction: 'inbound', received_date: '2026-08-19',
    received_at: '2026-08-19 15:20:00', first_reply_at: '2026-08-19 14:05:00', intent: 'order_status', converted_order_id: null,
  });
  return out;
}

/** Each repair's usual quote range by type (invented). */
const REPAIR_QUOTE: Record<(typeof REPAIR_TYPES)[number], [number, number]> = {
  cap_repair: [150, 350], wefting: [120, 280], lace: [180, 420], restyle: [120, 300], color_fix: [200, 450],
};

/**
 * One repair ticket received on `received`: quoted within three days, paid within five (most are), repaired in
 * four to twenty-four days (one in ten takes about two weeks longer), shipped back within three when it came
 * from the online form (every online repair goes through Brooklyn). A step after the data date has not happened.
 */
function repairTicket(ticket_id: string, received: string, { r, between }: ReturnType<typeof drawer>): RepairTicket {
  const [tu, cu, lu, pays] = [r(), r(), r(), r() < 0.93];
  const repair_type = pick(tu, REPAIR_TYPES, [0.3, 0.2, 0.2, 0.2, 0.1]);
  const channel = cu < 0.55 ? 'online' : 'walk_in';
  const quote_usd = cents(between(...REPAIR_QUOTE[repair_type]));
  const [parts, labor, quoteLag, payLag, repairDays, shipLag] = [between(0.1, 0.3), between(0.25, 0.45), between(0, 3), between(0, 5), between(4, 24) + (r() < 0.1 ? 16 : 0), between(1, 3)];
  const after = (from: string | null, lag: number) => (from === null ? null : notLater(addDays(from, Math.round(lag))));
  const quoted_date = after(received, quoteLag);
  const paid_date = pays ? after(quoted_date, payLag) : null;
  const completed_date = after(paid_date, repairDays);
  const shipped_date = channel === 'online' ? after(completed_date, shipLag) : null;
  const declined = !pays && quoted_date !== null && addDays(quoted_date, 14) <= AS_OF;
  return {
    ticket_id, channel, location: channel === 'online' || lu < 0.6 ? 'brooklyn' : 'lakewood', repair_type,
    received_date: received, quoted_date, paid_date, completed_date, shipped_date,
    status: declined ? 'cancelled' : shipped_date ? 'shipped' : completed_date ? 'done' : paid_date ? 'in_repair' : 'open',
    quote_usd, parts_cost_usd: cents(quote_usd * parts), labor_cost_usd: cents(quote_usd * labor),
  };
}

/** About one repair a working day at the salon's season (closed Saturdays), and one ticket completed before it arrived. */
function repairTickets(seed: number): RepairTicket[] {
  const d = drawer(streamSeed(seed, 'repairs'));
  const out: RepairTicket[] = [];
  for (const day of YEAR_DAYS().filter((x) => !isSaturday(x))) {
    for (let i = d.count(1.2 * seasonOf(day).salon); i > 0; i--) out.push(repairTicket(seq('demo-rt-r', out.length + 1), day, d));
  }
  out.push({
    ticket_id: 'demo-rt-bad-dates', channel: 'walk_in', location: 'lakewood', repair_type: 'lace', received_date: '2026-07-14', quoted_date: '2026-07-14',
    paid_date: '2026-07-15', completed_date: '2026-07-02', shipped_date: null, status: 'done', quote_usd: 260, parts_cost_usd: 40, labor_cost_usd: 90,
  });
  return out;
}

/** Each factory makes one line; what a month's invoice usually comes to per business at the base season (invented). */
const SUPPLIER_LINE: Record<(typeof SUPPLIERS)[number], (typeof PRODUCT_LINES)[number]> = {
  'demo-sup-s1': 'fortune', 'demo-sup-s2': 'mazali', 'demo-sup-s3': 'tuni', 'demo-sup-s4': 'accessories',
};
const INVOICE_BASE = {
  online: { fortune: 9000, mazali: 7000, tuni: 4000, accessories: 1200 }, salon: { fortune: 5000, mazali: 3000, tuni: 2500, accessories: 800 },
} as const;

/**
 * One invoice dated in [from, to], due in thirty or forty-five days. Most are paid around the due date; about one
 * in seven due in the last seventy-five days is still unpaid; some not yet due are paid early.
 */
function invoice(
  invoice_id: string,
  { supplier_id, business, from, to }: { supplier_id: (typeof SUPPLIERS)[number]; business: (typeof INVOICE_BUSINESSES)[number]; from: string; to: string },
  { r, between }: ReturnType<typeof drawer>,
): SupplierInvoice {
  const product_line = SUPPLIER_LINE[supplier_id];
  const span = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
  const [at, size, terms, payDraw, payLag, earlyLag] = [Math.floor(between(0, span + 1)), between(0.7, 1.3), r() < 0.5 ? 30 : 45, r(), between(-6, 8), between(5, 20)];
  const invoice_date = addDays(from, Math.min(at, span));
  const due_date = addDays(invoice_date, terms);
  const unpaid = due_date < AS_OF ? payDraw >= 0.86 && due_date >= addDays(AS_OF, -75) : payDraw >= 0.2;
  const paid = unpaid ? null : addDays(due_date < AS_OF ? due_date : invoice_date, Math.round(due_date < AS_OF ? payLag : earlyLag));
  return {
    invoice_id, supplier_id, business, product_line, invoice_date, due_date,
    paid_date: paid === null ? null : notLater(paid < invoice_date ? invoice_date : paid),
    amount_usd: cents(INVOICE_BASE[business][product_line] * seasonOf(from)[business] * size),
  };
}

/** Every month, each factory invoices each business once or twice; the bad row falls due before it was issued. */
function supplierInvoices(seed: number): SupplierInvoice[] {
  const d = drawer(streamSeed(seed, 'invoices'));
  const out: SupplierInvoice[] = [];
  for (const { from, to } of Object.values(PERIODS)) {
    for (const supplier_id of SUPPLIERS) {
      for (const business of INVOICE_BUSINESSES) {
        for (let i = d.r() < 0.4 ? 2 : 1; i > 0; i--) out.push(invoice(seq('demo-inv-i', out.length + 1), { supplier_id, business, from, to }, d));
      }
    }
  }
  out.push({ invoice_id: 'demo-inv-bad-due', supplier_id: 'demo-sup-s2', business: 'online', product_line: 'mazali', invoice_date: '2026-01-20', due_date: '2026-01-05', paid_date: null, amount_usd: 4200 });
  return out;
}

/**
 * Version 2's appointments: each row of version 1 and history with its columns and values unchanged, plus its
 * location, how it was booked and the stylist's labor cost (none for a no-show), from their own stream; and one
 * planted row at a location the salon does not have.
 */
function salonVisits(seed: number, appointments: readonly SalonAppointment[]): SalonVisit[] {
  const { r, between } = drawer(streamSeed(seed, 'visits'));
  const out = appointments.map((a): SalonVisit => {
    const [lu, bu, share] = [r(), r(), between(0.3, 0.45)];
    const labor = a.status === 'no_show' ? 0 : cents(Math.max(0, a.price_usd) * share);
    return { ...a, location: lu < 0.6 ? 'brooklyn' : 'lakewood', booked_via: pick(bu, BOOKING_CHANNELS, [0.3, 0.5, 0.2]), labor_cost_usd: labor };
  });
  out.push({
    appointment_id: 'demo-a-bad-location', appointment_date: '2026-04-15', service: 'cut_style', stylist_id: 'demo-s-2', price_usd: 240, duration_min: 90,
    status: 'completed', location: 'manhattan', booked_via: 'phone', labor_cost_usd: 96,
  });
  return out;
}

/** The day-to-day systems version 2 adds, each from its own stream. `orders` are only read, for real order ids. */
export function generateOperations(orders: readonly OnlineOrder[], seed = DIVISIONS_SEED): Operations {
  return {
    orderCosts: orderCosts(seed, orders), refunds: refunds(seed, orders), checkouts: checkouts(seed, orders), inventory: inventory(seed),
    messages: supportInbox(seed, orders), repairs: repairTickets(seed), invoices: supplierInvoices(seed),
  };
}

/** Version 2's rows: history, then version 1's rows unchanged, then what generateDivisions and generateOperations add. */
export function generateYear(): SyntheticYear {
  const today = generateBusiness();
  const history = generateHistory();
  const added = generateDivisions();
  const orders = [...history.online.orders, ...today.online.orders];
  const ops = generateOperations(orders);
  return {
    generatedFor: GENERATED_FOR,
    seed: today.seed,
    online: { orders, orderCosts: ops.orderCosts, refunds: ops.refunds, checkouts: ops.checkouts, inventory: ops.inventory },
    salon: { appointments: salonVisits(DIVISIONS_SEED, [...history.salon.appointments, ...today.salon.appointments]), repairs: ops.repairs },
    marketing: { ads: [...history.marketing.ads, ...today.marketing.ads, ...added.metaAds], email: [...history.marketing.email, ...today.marketing.email] },
    support: { messages: ops.messages },
    finance: { budgets: added.budgets, invoices: ops.invoices },
  };
}
