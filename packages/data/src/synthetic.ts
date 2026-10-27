import type { Period } from '@fahq/contracts';

// Seeded, deterministic synthetic business data. Every value is invented; shapes are realistic. Salon and
// online are separate sources, as in the real business. A few rows are deliberately bad (ids demo-*-bad-*)
// so the Zetaris data-quality rules have something to catch.
// Version 1 (generateBusiness) is Sept 1 to Oct 26, 2026, exactly what the live worker reads. Version 2
// (generateYear) adds, each from its own seeded stream so not one version 1 row moves: eleven months of
// history before it (generateHistory), Meta as a third ad channel and the finance owner's monthly budget
// sheet (generateDivisions).

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

export const PRODUCT_LINES = ['fortune', 'mazali', 'tuni', 'accessories'] as const;
export const ONLINE_CHANNELS = ['google', 'amazon', 'email', 'direct'] as const;
export const SALON_SERVICES = ['wash_set', 'cut_style', 'repair', 'consignment_intake', 'color', 'fortune_appointment'] as const;
/** The ad channels: Google and Amazon since version 1, Meta from version 2. */
export const AD_CHANNELS = ['google', 'meta', 'amazon'] as const;
export type AdChannel = (typeof AD_CHANNELS)[number];

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
export type SyntheticBusiness = {
  generatedFor: string; seed: number;
  online: { orders: OnlineOrder[] };
  salon: { appointments: SalonAppointment[] };
  marketing: { ads: AdDay[]; email: EmailDay[] };
};
/** Version 2: thirteen months of every version 1 source, Meta among the ads, and the budget sheet. */
export type SyntheticYear = SyntheticBusiness & { finance: { budgets: BudgetRow[] } };

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
export function generateDivisions(seed = 20261027): { metaAds: AdDay[]; budgets: BudgetRow[] } {
  return { metaAds: metaAds(seed), budgets: budgetSheet(seed) };
}

/** Version 2's rows: history, then version 1's rows unchanged, then what generateDivisions adds. */
export function generateYear(): SyntheticYear {
  const today = generateBusiness();
  const history = generateHistory();
  const added = generateDivisions();
  return {
    generatedFor: GENERATED_FOR,
    seed: today.seed,
    online: { orders: [...history.online.orders, ...today.online.orders] },
    salon: { appointments: [...history.salon.appointments, ...today.salon.appointments] },
    marketing: { ads: [...history.marketing.ads, ...today.marketing.ads, ...added.metaAds], email: [...history.marketing.email, ...today.marketing.email] },
    finance: { budgets: added.budgets },
  };
}
