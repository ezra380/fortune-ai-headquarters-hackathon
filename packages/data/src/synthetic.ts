import type { Period } from '@fahq/contracts';

// Seeded, deterministic synthetic business data. Every value is invented; shapes are realistic. Salon and
// online are separate sources, as in the real business. A few rows are deliberately bad (ids demo-*-bad-*)
// so the Zetaris data-quality rules have something to catch.
// Version 1 (generateBusiness) is Sept 1 to Oct 26, 2026, exactly what the live worker reads. Version 2
// (generateYear) adds, each from its own seeded stream so not one version 1 row moves: eleven months of
// history before it (generateHistory), Meta as a third ad channel and the finance owner's monthly budget
// sheet (generateDivisions), and the day-to-day systems each division runs on (generateOperations): order
// fees and shipping labels, refunds, abandoned checkouts, inventory with product interest, the support
// inbox, salon repair tickets and supplier invoices. Wave 2 adds the channels (generateChannels): Amazon's and
// Walmart's sales, Walmart's ads and both warehouses' stock, the email rows split into their messages, and each
// store order split into its lines.
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
/** The marketplaces the store also sells on, each from its own warehouse (Amazon FBA, Walmart WFS). */
export const MARKETPLACES = ['amazon', 'walmart'] as const;
export type Marketplace = (typeof MARKETPLACES)[number];
/** Each email flow's messages in order, and the weekly campaign: the fixed list of names an email row may carry. */
export const EMAIL_STEPS: Record<string, readonly string[]> = {
  'Welcome (demo)': ['Welcome: hello (demo)', 'Welcome: the three lines (demo)', 'Welcome: meet the salon (demo)'],
  'Checkout recovery (demo)': ['Checkout recovery: reminder (demo)', 'Checkout recovery: questions answered (demo)'],
  'Post-purchase care (demo)': ['Care: first wash (demo)', 'Care: styling at home (demo)'],
  'Weekly edit (demo)': ['Weekly edit (demo)'],
};
export const EMAIL_NAMES = Object.keys(EMAIL_STEPS);
/** What a review is about, from a fixed list; a review has a rating and a topic, never text. */
export const REVIEW_TOPICS = ['fit', 'color', 'quality', 'shipping', 'service', 'other'] as const;
/** Who sent the first answer to a customer's message: Emma (the online assistant), the salon, an automatic reply, someone else. */
export const ANSWERERS = ['emma', 'salon', 'auto', 'other'] as const;
/** The store site's pages the page days and the crawl cover (invented): each with its type, its share of a day's visits and how fast it usually draws (ms). */
export const SITE_PAGES = [
  { page: '/', type: 'home', share: 0.32, lcp: [1600, 2300] },
  { page: '/collections/mazali', type: 'collection', share: 0.2, lcp: [1900, 2600] },
  { page: '/collections/tuni', type: 'collection', share: 0.12, lcp: [1800, 2500] },
  { page: '/collections/accessories', type: 'collection', share: 0.1, lcp: [1500, 2200] },
  { page: '/products/demo-mazali-feature', type: 'product', share: 0.16, lcp: [2300, 3300] },
  { page: '/blogs/journal', type: 'blog', share: 0.1, lcp: [2000, 2900] },
] as const;
export const PAGE_TYPES = ['home', 'collection', 'product', 'blog'] as const;
/** Where a site visit came from. */
export const WEB_SOURCES = ['organic', 'google', 'meta', 'email', 'direct', 'social'] as const;
/** What a blog post is about, from a fixed list (no health topic). */
export const BLOG_TOPICS = ['care', 'styling', 'buying_guide', 'salon_news', 'consignment'] as const;

/** Every enumerated column of every source, by column name, with its allowed values (the no-medical guard reads it). */
export const SOURCE_ENUMS = {
  product_line: PRODUCT_LINES, channel: [...ONLINE_CHANNELS, ...AD_CHANNELS, ...MESSAGE_CHANNELS, ...REPAIR_CHANNELS, 'walmart'],
  service: SALON_SERVICES, reason: REFUND_REASONS, recovered_via: RECOVERY_CHANNELS, direction: MESSAGE_DIRECTIONS, booked_via: BOOKING_CHANNELS,
  intent: MESSAGE_INTENTS, repair_type: REPAIR_TYPES, status: [...REPAIR_STATUSES, 'completed', 'no_show', 'approved', 'proposed'],
  location: SALON_LOCATIONS, business: INVOICE_BUSINESSES, supplier_id: SUPPLIERS, kind: ['flow', 'campaign'],
  marketplace: MARKETPLACES, name: EMAIL_NAMES, step: Object.values(EMAIL_STEPS).flat(), topic: [...REVIEW_TOPICS, ...BLOG_TOPICS], answered_by: ANSWERERS,
  page_type: PAGE_TYPES, source: WEB_SOURCES, page: SITE_PAGES.map((p) => p.page),
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
/** One marketplace order of one listing, sold and shipped from the marketplace's warehouse: what it brought in and the marketplace's fees. */
export type MarketplaceSale = {
  sale_id: string; sale_date: string; marketplace: Marketplace; sku: string; product_line: string; units: number; revenue_usd: number; fees_usd: number;
};
/** A day of one Walmart ad keyword (the marketplace's own ads; Amazon's are among the marketing ads since version 1). */
export type MarketplaceAdDay = Omit<AdDay, 'channel'> & { channel: 'walmart' };
/** A listing's stock in the marketplace's warehouse on a snapshot date: on hand, on its way in, and units sold in the 28 days to it. */
export type MarketplaceStock = {
  stock_id: string; snapshot_date: string; marketplace: Marketplace; sku: string; product_line: string; on_hand: number; inbound: number; units_28d: number;
};
/** One message of a flow, or a campaign, sent on one day: its part of that day's email row, and the unsubscribes it caused. */
export type EmailMessage = {
  message_id: string; email_id: string; send_date: string; kind: 'flow' | 'campaign'; name: string; step: string; sends: number; revenue_usd: number; unsubscribes: number;
};
/**
 * One unit of one product in a store order: what it sold for (its part of the order's revenue after the discount),
 * its cost, and what has been refunded on it by the data date. An order of three accessories is three lines.
 */
export type OrderLine = {
  line_id: string; order_id: string; order_date: string; sku: string; product_line: string; units: number; price_usd: number; unit_cost_usd: number; refunded_usd: number;
};
/** A store customer's synthetic id (demo-cu-…): never a name, an address or a phone number. */
type CustomerId = { customer_id: string };
/** Version 2's order: every version 1 column and value unchanged, plus the customer who placed it. */
export type StoreOrder = OnlineOrder & CustomerId;
/** Version 2's refund: issued to the customer who placed the order. */
export type CustomerRefund = Refund & CustomerId;
/** Version 2's support message: the customer it came from (or the shop's follow-up went to) and who first answered it (none when unanswered). */
export type InboxMessage = SupportMessage & CustomerId & { answered_by: (typeof ANSWERERS)[number] | null };
/** A customer's review of one product of an order: a rating from 1 to 5 and a topic from a fixed list. No text. */
export type Review = { review_id: string; review_date: string; order_id: string; customer_id: string; sku: string; rating: number; topic: (typeof REVIEW_TOPICS)[number] };
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
/** The selling and marketing sources wave 2 adds for Finance (generateChannels). */
export type Channels = {
  marketplace: { sales: MarketplaceSale[]; ads: MarketplaceAdDay[]; stock: MarketplaceStock[] };
  emailMessages: EmailMessage[];
  orderLines: OrderLine[];
};
/** One page's day for one source of visits: sessions, carts, checkouts and orders (each at most the one before), and how fast it drew. */
export type PageDay = {
  page_day_id: string; visit_date: string; page: string; page_type: string; source: (typeof WEB_SOURCES)[number];
  sessions: number; carts: number; checkouts: number; orders: number; lcp_ms: number;
};
/** One link on one page in a weekly crawl of the site, and the HTTP status the crawler got. */
export type CrawlRow = { crawl_id: string; crawl_date: string; page: string; link: string; http_status: number };
/** A blog post: when it was published and last updated, its topic and its visits in the last 28 days. No text. */
export type BlogPost = { post_id: string; published_date: string; last_updated: string; topic: (typeof BLOG_TOPICS)[number]; sessions_28d: number };
/** The store site wave 2 adds (generateWeb). */
export type Web = { pageDays: PageDay[]; crawl: CrawlRow[]; blogPosts: BlogPost[] };
/** The store's customers wave 2 adds (generateCustomers): who placed each order, got each refund and sent each message, and their reviews. */
export type Customers = { orders: StoreOrder[]; refunds: CustomerRefund[]; messages: InboxMessage[]; reviews: Review[] };
/** Version 2: thirteen months of every version 1 source, Meta among the ads, the budget sheet, the operations, the channels and the customers. */
export type SyntheticYear = Omit<SyntheticBusiness, 'salon' | 'online'> & {
  online: { orders: StoreOrder[]; refunds: CustomerRefund[]; reviews: Review[] } & Pick<Operations, 'orderCosts' | 'checkouts' | 'inventory'> & Pick<Channels, 'orderLines'>;
  salon: { appointments: SalonVisit[] } & Pick<Operations, 'repairs'>;
  support: { messages: InboxMessage[] };
  finance: { budgets: BudgetRow[] } & Pick<Operations, 'invoices'>;
  marketing: Pick<Channels, 'emailMessages'>;
  marketplace: Channels['marketplace'];
  web: Web;
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

// ---- The channels (wave 2, for Finance) ---------------------------------------------------
// Amazon and Walmart sell some of the store's products from their own warehouses; the email rows split into the
// flows' messages and the campaign; each store order splits into its lines. Each source draws from its own named
// stream. The email split and the order lines only re-divide rows that already exist, so they add up to them to
// the cent; every source has exactly one planted bad row (ids demo-*-bad-*).

/** A store product's id, as the inventory names it: the line's first letter and a two-digit number. */
const skuOf = (line: (typeof PRODUCT_LINES)[number], i: number) => `demo-sku-${line[0]}${String(i + 1).padStart(2, '0')}`;
const lineOfSku = (sku: string) => PRODUCT_LINES.find((l) => sku.startsWith(`demo-sku-${l[0]}`))!;
const skusOf = (line: (typeof PRODUCT_LINES)[number], n: number) => Array.from({ length: n }, (_, i) => skuOf(line, i));
const isPlanted = (id: string) => id.includes('-bad-');

/** What each marketplace lists (invented): the accessories on both, four Tuni pieces on Amazon too. */
export const LISTINGS: Record<Marketplace, readonly string[]> = {
  amazon: [...skusOf('accessories', 16), ...skusOf('tuni', 4)],
  walmart: skusOf('accessories', 10),
};

/** Splits a whole number by weights (the last part takes what is left), so the parts add up to it exactly. */
function split(total: number, weights: readonly number[]): number[] {
  const all = weights.reduce((t, w) => t + w, 0);
  const parts = weights.map((w) => Math.floor((total * w) / all));
  parts[parts.length - 1]! += total - parts.reduce((t, p) => t + p, 0);
  return parts;
}

/** Spreads a whole number over parts in proportion to their caps, never above a cap (the total is at most the caps' sum). */
function spread(total: number, caps: readonly number[]): number[] {
  const all = caps.reduce((t, c) => t + c, 0);
  if (total > all) throw new Error('spread: more than the parts can hold');
  const out = caps.map((c) => (all === 0 ? 0 : Math.floor((total * c) / all)));
  let left = total - out.reduce((t, x) => t + x, 0);
  for (let i = 0; left > 0; i = (i + 1) % caps.length) if (out[i]! < caps[i]!) { out[i]! += 1; left -= 1; }
  return out;
}

const toCents = (usd: number) => Math.round(usd * 100);

/**
 * Each listing's orders at the store's season: its usual units a day, price and warehouse fee per unit are drawn
 * once (invented); the marketplace keeps a referral fee of 15% plus the fee per unit. The bad row is a fee
 * reversal exported as a negative fee.
 */
function marketplaceSales(seed: number): MarketplaceSale[] {
  const { r, between, count } = drawer(streamSeed(seed, 'marketplace_sales'));
  const listings = MARKETPLACES.flatMap((marketplace) => LISTINGS[marketplace].map((sku) => {
    const line = lineOfSku(sku);
    const piece = line !== 'accessories';
    const rate = piece ? between(0.03, 0.08) : marketplace === 'amazon' ? between(0.15, 0.6) : between(0.05, 0.3);
    return { marketplace, sku, line, rate, price: cents(between(LINE[line].price[0], LINE[line].price[1])), perUnit: piece ? between(7, 9.5) : between(3.8, 6.2) };
  }));
  const out: MarketplaceSale[] = [];
  for (const day of YEAR_DAYS()) {
    for (const l of listings) {
      for (let i = count(l.rate * seasonOf(day).online); i > 0; i--) {
        const units = l.line === 'accessories' && r() < 0.2 ? 2 : 1;
        const revenue = cents(l.price * units);
        out.push({
          sale_id: seq('demo-mk-s', out.length + 1), sale_date: day, marketplace: l.marketplace, sku: l.sku, product_line: l.line, units,
          revenue_usd: revenue, fees_usd: cents(revenue * 0.15 + units * l.perUnit),
        });
      }
    }
  }
  out.push({ sale_id: 'demo-mk-bad-fees', sale_date: '2026-06-09', marketplace: 'walmart', sku: 'demo-sku-a02', product_line: 'accessories', units: 1, revenue_usd: 34.5, fees_usd: -9.9 });
  return out;
}

/** Walmart's own ads, two keywords a day at the store's season (invented); the bad row is a negative spend. */
function walmartAds(seed: number): MarketplaceAdDay[] {
  const { r, between } = drawer(streamSeed(seed, 'walmart_ads'));
  const out: MarketplaceAdDay[] = [];
  for (const day of YEAR_DAYS()) {
    for (const keyword of ['demo wig care kit', 'demo wig stand']) {
      const spend = cents(between(1.5, 6) * seasonOf(day).online);
      const clicks = Math.max(1, Math.round(spend / between(0.4, 1.1)));
      const conversions = r() < 0.22 ? 1 : 0;
      out.push({ ad_id: seq('demo-wa-w', out.length + 1), ad_date: day, channel: 'walmart', keyword, spend_usd: spend, clicks, conversions, revenue_usd: conversions ? cents(between(20, 75)) : 0 });
    }
  }
  out.push({ ad_id: 'demo-wa-bad-negative', ad_date: '2026-01-21', channel: 'walmart', keyword: 'demo wig stand', spend_usd: -14.2, clicks: 3, conversions: 0, revenue_usd: 0 });
  return out;
}

/**
 * Each listing's warehouse stock on every period's last day (the month so far: the data date), as the marketplace's
 * inventory report gives it: units sold in the 28 days to that day (from the sales, the planted row left out), on
 * hand (sometimes none) and, when it runs low, a shipment on its way in.
 */
function marketplaceStock(seed: number, sales: readonly MarketplaceSale[]): MarketplaceStock[] {
  const { r, between } = drawer(streamSeed(seed, 'marketplace_stock'));
  const sold = sales.filter((s) => !isPlanted(s.sale_id));
  const out: MarketplaceStock[] = [];
  for (const { to: day } of Object.values(PERIODS)) {
    const from = addDays(day, -27);
    for (const marketplace of MARKETPLACES) {
      for (const sku of LISTINGS[marketplace]) {
        const units_28d = sold.filter((s) => s.marketplace === marketplace && s.sku === sku && s.sale_date >= from && s.sale_date <= day).reduce((t, s) => t + s.units, 0);
        const [outDraw, cover, shipDraw, shipDays, idle] = [r(), between(4, 75), r(), between(20, 45), between(1, 8)];
        const daily = units_28d / 28;
        const on_hand = outDraw < 0.07 ? 0 : daily === 0 ? Math.round(idle) : Math.max(1, Math.round(daily * cover));
        const inbound = (on_hand === 0 || on_hand < daily * 25) && shipDraw < 0.55 ? Math.round(daily * shipDays) + 2 : 0;
        out.push({ stock_id: seq('demo-ms-k', out.length + 1), snapshot_date: day, marketplace, sku, product_line: lineOfSku(sku), on_hand, inbound, units_28d });
      }
    }
  }
  out.push({ stock_id: 'demo-ms-bad-negative', snapshot_date: '2026-05-31', marketplace: 'amazon', sku: 'demo-sku-a03', product_line: 'accessories', on_hand: -4, inbound: 0, units_28d: 9 });
  return out;
}

/**
 * Each email row split into the messages that made it (a flow's steps; a campaign is one message): its sends and
 * revenue to the cent, and the unsubscribes each message caused (invented rates). The bad row has negative sends.
 */
function emailMessages(seed: number, email: readonly EmailDay[]): EmailMessage[] {
  const { between } = drawer(streamSeed(seed, 'email_messages'));
  const out: EmailMessage[] = [];
  for (const e of email) {
    const steps = EMAIL_STEPS[e.name]!;
    const weights = steps.map(() => between(0.5, 1.5));
    const [sends, revenue] = [split(e.sends, weights), split(toCents(e.revenue_usd), weights)];
    const [lo, hi] = e.kind === 'campaign' ? [0.001, 0.004] : [0.002, 0.008];
    steps.forEach((step, i) => {
      const unsubscribes = Math.min(sends[i]!, Math.round(sends[i]! * between(lo, hi)));
      out.push({ message_id: seq('demo-ems-e', out.length + 1), email_id: e.email_id, send_date: e.send_date, kind: e.kind, name: e.name, step, sends: sends[i]!, revenue_usd: revenue[i]! / 100, unsubscribes });
    });
  }
  const march = email.find((e) => e.send_date >= '2026-03-10' && e.name === 'Welcome (demo)')!;
  out.push({ message_id: 'demo-ems-bad-negative', email_id: march.email_id, send_date: march.send_date, kind: 'flow', name: march.name, step: EMAIL_STEPS[march.name]![0]!, sends: -40, revenue_usd: 0, unsubscribes: 0 });
  return out;
}

/**
 * Each sale's lines, one per unit (distinct products of its line), with the order's revenue, cost and refunds (as
 * of the data date) shared out by weight to the cent, so a line never carries more refund than it sold for. The bad
 * row is a line of no units.
 */
function orderLines(seed: number, orders: readonly OnlineOrder[], refunded: readonly Refund[]): OrderLine[] {
  const { r, between } = drawer(streamSeed(seed, 'order_lines'));
  const back = new Map<string, number>();
  for (const f of refunded) if (!isPlanted(f.refund_id) && f.amount_usd > 0) back.set(f.order_id, (back.get(f.order_id) ?? 0) + toCents(f.amount_usd));
  const out: OrderLine[] = [];
  for (const o of orders.filter(isSale)) {
    const line = o.product_line as (typeof PRODUCT_LINES)[number];
    const size = CATALOG[line].n;
    const picked: number[] = [];
    for (let u = 0; u < o.units; u++) {
      let i = Math.floor(r() * size);
      while (picked.includes(i)) i = (i + 1) % size;
      picked.push(i);
    }
    const weights = picked.map(() => between(0.6, 1.4));
    const price = split(toCents(o.net_usd), weights);
    const cost = split(toCents(o.cost_usd), weights);
    const refund = spread(back.get(o.order_id) ?? 0, price);
    picked.forEach((i, n) => out.push({
      line_id: seq('demo-ol-l', out.length + 1), order_id: o.order_id, order_date: o.order_date, sku: skuOf(line, i), product_line: line, units: 1,
      price_usd: price[n]! / 100, unit_cost_usd: cost[n]! / 100, refunded_usd: refund[n]! / 100,
    }));
  }
  const august = orders.find((o) => isSale(o) && o.order_date >= '2026-08-12')!;
  out.push({
    line_id: 'demo-ol-bad-units', order_id: august.order_id, order_date: august.order_date, sku: skuOf(august.product_line as (typeof PRODUCT_LINES)[number], 0),
    product_line: august.product_line, units: 0, price_usd: 120, unit_cost_usd: 60, refunded_usd: 0,
  });
  return out;
}

/** The channels, each from its own stream. `orders`, `email` and `refunds` are only read: the lines and messages re-divide them. */
export function generateChannels(orders: readonly OnlineOrder[], email: readonly EmailDay[], refunded: readonly Refund[], seed = DIVISIONS_SEED): Channels {
  const sales = marketplaceSales(seed);
  return {
    marketplace: { sales, ads: walmartAds(seed), stock: marketplaceStock(seed, sales) },
    emailMessages: emailMessages(seed, email),
    orderLines: orderLines(seed, orders, refunded),
  };
}

// ---- The customers (wave 2, for Online) ------------------------------------------------------
// Who placed each store order, got each refund and sent each message, and the reviews customers left. Each draws from
// its own named stream and only reads the rows that already exist: no order, refund or message moves, and no number
// counted before changes. A customer is a synthetic id (demo-cu-…), never a name, an address or a phone number.

/** Six customers who send back again and again (invented), so the repeat returners have someone to count. */
const RETURNERS = Array.from({ length: 6 }, (_, i) => seq('demo-cu-r', i + 1));
const sorted = <T>(xs: readonly T[], key: (x: T) => string) => [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

/**
 * Who placed each order (they come in date order): a quarter of the refunded orders go to the six returners; of the
 * rest, about one in three comes from a customer who ordered before, the others from a new customer.
 */
function orderCustomers(seed: number, orders: readonly OnlineOrder[], refunded: readonly Refund[]): StoreOrder[] {
  const { r } = drawer(streamSeed(seed, 'customers'));
  const back = new Set(refunded.filter((f) => !isPlanted(f.refund_id)).map((f) => f.order_id));
  const known: string[] = [];
  return orders.map((o) => {
    const [u, which, again] = [r(), r(), r()];
    if (back.has(o.order_id) && u < 0.25) return { ...o, customer_id: RETURNERS[Math.floor(which * RETURNERS.length)]! };
    if (again < 0.3 && known.length > 0) return { ...o, customer_id: known[Math.floor(which * known.length)]! };
    known.push(seq('demo-cu-c', known.length + 1));
    return { ...o, customer_id: known[known.length - 1]! };
  });
}

/** Minutes between two inbox moments. */
const minutesBetween = (from: string, to: string) => (Date.parse(`${to.replace(' ', 'T')}Z`) - Date.parse(`${from.replace(' ', 'T')}Z`)) / 60_000;

/**
 * Who each message came from and who first answered it. A message that led to an order is that order's customer; a
 * question about a return comes from a customer refunded within two weeks of it; others from a customer who ordered
 * before, or someone who has not ordered yet (demo-cu-p…). Planted duplicates: now and then a customer writes again on
 * another channel about the same thing within a day, before the first message was answered. The shop's follow-ups go
 * to the thread's customer. A chat answered within two minutes is the automatic reply; otherwise Emma answers most,
 * the salon many repair and consignment questions.
 */
function inboxPeople(seed: number, messages: readonly SupportMessage[], orders: readonly StoreOrder[], refunds: readonly CustomerRefund[]): InboxMessage[] {
  const { r } = drawer(streamSeed(seed, 'message_people'));
  const ofOrder = new Map(orders.map((o) => [o.order_id, o.customer_id]));
  const refunded = refunds.filter((f) => !isPlanted(f.refund_id));
  const who = new Map<string, string>();
  let prospects = 0;
  const inbound = sorted(messages.filter((m) => m.direction === 'inbound'), (m) => `${m.received_at}|${m.message_id}`);
  inbound.forEach((m, i) => {
    const [u, which, dup] = [r(), r(), r()];
    if (m.converted_order_id) return who.set(m.message_id, ofOrder.get(m.converted_order_id)!);
    // An earlier message on the same topic, from another channel, in the day before, still unanswered when this one came.
    const first = inbound.slice(Math.max(0, i - 40), i).reverse().find((e) => e.intent === m.intent && e.channel !== m.channel
      && minutesBetween(e.received_at, m.received_at) <= 1440 && (e.first_reply_at === null || e.first_reply_at > m.received_at));
    if (first && dup < 0.07) return who.set(m.message_id, who.get(first.message_id)!);
    const near = m.intent === 'return' ? refunded.filter((f) => Math.abs(minutesBetween(`${f.refund_date} 00:00:00`, m.received_at)) <= 14 * 1440) : [];
    if (near.length > 0) return who.set(m.message_id, near[Math.floor(which * near.length)]!.customer_id);
    const before = orders.filter((o) => o.order_date < m.received_date);
    if (u < 0.55 && before.length > 0) return who.set(m.message_id, before[Math.floor(which * before.length)]!.customer_id);
    return who.set(m.message_id, seq('demo-cu-p', ++prospects));
  });
  const ofThread = new Map(inbound.map((m) => [m.thread_id, who.get(m.message_id)!]));
  return messages.map((m) => {
    const [u, au] = [r(), r()];
    const customer_id = who.get(m.message_id) ?? ofThread.get(m.thread_id) ?? seq('demo-cu-p', ++prospects);
    if (m.first_reply_at === null) return { ...m, customer_id, answered_by: null };
    const instant = m.channel === 'chat' && minutesBetween(m.received_at, m.first_reply_at) <= 2;
    const salonish = m.intent === 'repair' || m.intent === 'consignment';
    const answered_by = instant && u < 0.8 ? 'auto' : pick(au, ['emma', 'salon', 'other'] as const, salonish ? [0.45, 0.45, 0.1] : [0.72, 0.16, 0.12]);
    return { ...m, customer_id, answered_by };
  });
}

/**
 * About one sale in seven gets a review five to thirty days after the order (two in five of the refunded ones), of
 * the order's first product: refunded orders are rated low and mostly about fit, color or quality. The bad row has a
 * rating of zero.
 */
function reviews(seed: number, orders: readonly StoreOrder[], lines: readonly OrderLine[], refunds: readonly CustomerRefund[]): Review[] {
  const { r, between } = drawer(streamSeed(seed, 'reviews'));
  const back = new Set(refunds.filter((f) => !isPlanted(f.refund_id)).map((f) => f.order_id));
  const firstSku = new Map<string, string>();
  for (const l of lines) if (!isPlanted(l.line_id) && !firstSku.has(l.order_id)) firstSku.set(l.order_id, l.sku);
  const out: Review[] = [];
  for (const o of orders.filter(isSale)) {
    const [u, lag, ru, tu] = [r(), Math.round(between(5, 30)), r(), r()];
    const refunded = back.has(o.order_id);
    const review_date = addDays(o.order_date, lag);
    if (u >= (refunded ? 0.4 : 0.14) || review_date > AS_OF) continue;
    out.push({
      review_id: seq('demo-rv-v', out.length + 1), review_date, order_id: o.order_id, customer_id: o.customer_id, sku: firstSku.get(o.order_id)!,
      rating: pick(ru, [1, 2, 3, 4, 5], refunded ? [0.35, 0.3, 0.2, 0.1, 0.05] : [0.02, 0.04, 0.12, 0.32, 0.5]),
      topic: pick(tu, REVIEW_TOPICS, refunded ? [0.35, 0.25, 0.25, 0.05, 0.05, 0.05] : [0.2, 0.2, 0.25, 0.15, 0.15, 0.05]),
    });
  }
  const feb = out.find((v) => v.review_date >= '2026-02-09')!;
  out.push({ ...feb, review_id: 'demo-rv-bad-rating', rating: 0 });
  return out;
}

/**
 * The customers, each from its own stream. `orders`, `refunds`, `messages` and `lines` are only read: every row comes
 * back with each of its columns and values unchanged, plus its customer (and, for a message, who answered it).
 */
export function generateCustomers(
  orders: readonly OnlineOrder[], refunds: readonly Refund[], messages: readonly SupportMessage[], lines: readonly OrderLine[], seed = DIVISIONS_SEED,
): Customers {
  const placed = orderCustomers(seed, orders, refunds);
  const ofOrder = new Map(placed.map((o) => [o.order_id, o.customer_id]));
  const refunded = refunds.map((f): CustomerRefund => ({ ...f, customer_id: ofOrder.get(f.order_id)! }));
  return { orders: placed, refunds: refunded, messages: inboxPeople(seed, messages, placed, refunded), reviews: reviews(seed, placed, lines, refunded) };
}

// ---- The store site (wave 2, for Online) -----------------------------------------------------
// Each page's day by where its visits came from, the weekly crawl of the site's links, and the blog's posts, each from
// its own named stream. The page days share out the day's store orders, so they add up to the order count exactly.

/** Each source's usual share of a day's visits, and how likely a visit from it is to end in an order against the average (invented). */
const VISIT_SOURCES: Record<(typeof WEB_SOURCES)[number], { share: number; buys: number }> = {
  organic: { share: 0.34, buys: 1 }, google: { share: 0.2, buys: 1.4 }, meta: { share: 0.14, buys: 0.8 },
  email: { share: 0.1, buys: 1.6 }, direct: { share: 0.16, buys: 1.3 }, social: { share: 0.06, buys: 0.5 },
};

/**
 * About six hundred visits a day at the store's season, shared over the pages and sources; each of the day's sales is
 * placed on one page and source by its chance of selling; carts and checkouts follow, never fewer than the orders. The
 * bad row has more carts than visits.
 */
function pageDays(seed: number, orders: readonly OnlineOrder[]): PageDay[] {
  const { r, between } = drawer(streamSeed(seed, 'page_days'));
  const sold = new Map<string, number>();
  for (const o of orders.filter(isSale)) sold.set(o.order_date, (sold.get(o.order_date) ?? 0) + 1);
  const out: PageDay[] = [];
  for (const day of YEAR_DAYS()) {
    const visits = between(520, 680) * seasonOf(day).online;
    const cells = SITE_PAGES.flatMap((p) => WEB_SOURCES.map((source) => {
      const sessions = Math.max(1, Math.round(visits * p.share * VISIT_SOURCES[source].share * between(0.7, 1.3)));
      return { p, source, sessions, weight: sessions * VISIT_SOURCES[source].buys * (p.type === 'blog' ? 0.3 : 1) };
    }));
    const placed = cells.map(() => 0);
    const at = cells.map((_, i) => i);
    for (let k = sold.get(day) ?? 0; k > 0; k--) placed[pick(r(), at, cells.map((c) => c.weight))]! += 1;
    cells.forEach((c, i) => {
      const [cartShare, checkShare, lcp] = [between(0.04, 0.09), between(0.35, 0.6), between(c.p.lcp[0], c.p.lcp[1])];
      const checkouts = Math.max(placed[i]!, Math.round(c.sessions * cartShare * checkShare));
      const carts = Math.max(checkouts, Math.round(c.sessions * cartShare));
      out.push({
        page_day_id: seq('demo-pd-d', out.length + 1), visit_date: day, page: c.p.page, page_type: c.p.type, source: c.source,
        sessions: Math.max(c.sessions, carts), carts, checkouts, orders: placed[i]!, lcp_ms: Math.round(lcp),
      });
    });
  }
  out.push({ page_day_id: 'demo-pd-bad-carts', visit_date: '2026-04-14', page: '/', page_type: 'home', source: 'social', sessions: 3, carts: 9, checkouts: 0, orders: 0, lcp_ms: 1900 });
  return out;
}

/** Six links on each page, crawled every Monday from 2025-10-06: now and then one breaks (mostly a 404) and stays broken a few weeks. */
function siteCrawl(seed: number): CrawlRow[] {
  const { r } = drawer(streamSeed(seed, 'crawl'));
  const links = SITE_PAGES.flatMap((p) => Array.from({ length: 6 }, (_, i) => ({ page: p.page, link: `${p.page === '/' ? '' : p.page}/demo-link-${i + 1}` })));
  const brokenUntil = new Map<string, string>();
  const out: CrawlRow[] = [];
  for (let day = '2025-10-06'; day <= AS_OF; day = addDays(day, 7)) {
    for (const l of links) {
      const [u, weeks, kind] = [r(), r(), r()];
      if (brokenUntil.has(l.link) && day >= brokenUntil.get(l.link)!) brokenUntil.delete(l.link);
      if (!brokenUntil.has(l.link) && u < 0.02) brokenUntil.set(l.link, addDays(day, 7 * (1 + Math.floor(weeks * 6))));
      const http_status = brokenUntil.has(l.link) ? (kind < 0.8 ? 404 : 503) : kind < 0.08 ? 301 : 200;
      out.push({ crawl_id: seq('demo-cr-c', out.length + 1), crawl_date: day, page: l.page, link: l.link, http_status });
    }
  }
  out.push({ crawl_id: 'demo-cr-bad-status', crawl_date: '2026-05-04', page: '/', link: '/demo-link-1', http_status: 0 });
  return out;
}

/** A post every six to fourteen days since January 2024; about a third are updated later. The bad row was updated before it was published. */
function blogPosts(seed: number): BlogPost[] {
  const { r, between } = drawer(streamSeed(seed, 'blog_posts'));
  const out: BlogPost[] = [];
  for (let day = '2024-01-03'; day <= AS_OF; day = addDays(day, Math.round(between(6, 14)))) {
    const [tu, uu, gap, visits] = [r(), r(), Math.round(between(20, 400)), between(40, 900)];
    const updated = addDays(day, gap);
    out.push({
      post_id: seq('demo-bp-p', out.length + 1), published_date: day, last_updated: uu < 0.35 && updated <= AS_OF ? updated : day,
      topic: pick(tu, BLOG_TOPICS, [0.3, 0.3, 0.2, 0.1, 0.1]), sessions_28d: Math.round(visits),
    });
  }
  out.push({ post_id: 'demo-bp-bad-dates', published_date: '2026-03-18', last_updated: '2026-03-02', topic: 'care', sessions_28d: 120 });
  return out;
}

/** The store site, each source from its own stream. `orders` are only read: the page days share out each day's sales. */
export function generateWeb(orders: readonly OnlineOrder[], seed = DIVISIONS_SEED): Web {
  return { pageDays: pageDays(seed, orders), crawl: siteCrawl(seed), blogPosts: blogPosts(seed) };
}

/** Version 2's rows: history, then version 1's rows unchanged, then what generateDivisions, generateOperations, generateChannels, generateCustomers and generateWeb add. */
export function generateYear(): SyntheticYear {
  const today = generateBusiness();
  const history = generateHistory();
  const added = generateDivisions();
  const plain = [...history.online.orders, ...today.online.orders];
  const email = [...history.marketing.email, ...today.marketing.email];
  const ops = generateOperations(plain);
  const channels = generateChannels(plain, email, ops.refunds);
  const people = generateCustomers(plain, ops.refunds, ops.messages, channels.orderLines);
  return {
    generatedFor: GENERATED_FOR,
    seed: today.seed,
    online: {
      orders: people.orders, orderCosts: ops.orderCosts, refunds: people.refunds, checkouts: ops.checkouts, inventory: ops.inventory, orderLines: channels.orderLines,
      reviews: people.reviews,
    },
    salon: { appointments: salonVisits(DIVISIONS_SEED, [...history.salon.appointments, ...today.salon.appointments]), repairs: ops.repairs },
    marketing: { ads: [...history.marketing.ads, ...today.marketing.ads, ...added.metaAds], email, emailMessages: channels.emailMessages },
    support: { messages: people.messages },
    finance: { budgets: added.budgets, invoices: ops.invoices },
    marketplace: channels.marketplace,
    web: generateWeb(plain),
  };
}
