// Seeded, deterministic synthetic business data, Sept 1 to Oct 26, 2026. Every value is invented;
// shapes are realistic. Salon and online are separate sources, as in the real business. A few rows
// are deliberately bad (ids demo-*-bad-*) so the Zetaris data-quality rule has something to catch.

export const PERIODS = {
  '2026-09': { from: '2026-09-01', to: '2026-09-30' },
  '2026-10-mtd': { from: '2026-10-01', to: '2026-10-26' },
} as const;
export type Period = keyof typeof PERIODS;

export const PRODUCT_LINES = ['fortune', 'mazali', 'tuni', 'accessories'] as const;
export const ONLINE_CHANNELS = ['google', 'amazon', 'email', 'direct'] as const;
export const SALON_SERVICES = ['wash_set', 'cut_style', 'repair', 'consignment_intake', 'color', 'fortune_appointment'] as const;

export type OnlineOrder = {
  order_id: string; order_date: string; product_line: string; channel: string;
  units: number; gross_usd: number; discount_usd: number; net_usd: number; cost_usd: number;
};
export type SalonAppointment = {
  appointment_id: string; appointment_date: string; service: string; stylist_id: string;
  price_usd: number; duration_min: number; status: 'completed' | 'no_show';
};
export type AdDay = {
  ad_id: string; ad_date: string; channel: 'google' | 'amazon'; keyword: string;
  spend_usd: number; clicks: number; conversions: number; revenue_usd: number;
};
export type EmailDay = {
  email_id: string; send_date: string; kind: 'flow' | 'campaign'; name: string;
  sends: number; opens: number; clicks: number; revenue_usd: number;
};
export type SyntheticBusiness = {
  generatedFor: string; seed: number;
  online: { orders: OnlineOrder[] };
  salon: { appointments: SalonAppointment[] };
  marketing: { ads: AdDay[]; email: EmailDay[] };
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

const cents = (n: number) => Math.round(n * 100) / 100;

function days(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

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
} as const;
const EMAILS = [
  { kind: 'flow', name: 'Welcome (demo)' }, { kind: 'flow', name: 'Checkout recovery (demo)' },
  { kind: 'flow', name: 'Post-purchase care (demo)' }, { kind: 'campaign', name: 'Weekly edit (demo)' },
] as const;

export function generateBusiness(seed = 20261026): SyntheticBusiness {
  const r = rng(seed);
  const between = (lo: number, hi: number) => lo + (hi - lo) * r();
  const count = (mean: number) => { let n = 0; let p = Math.exp(-mean); let s = p; const u = r(); while (u > s) { n += 1; p *= mean / n; s += p; } return n; };
  const all = days(PERIODS['2026-09'].from, PERIODS['2026-10-mtd'].to);

  const orders: OnlineOrder[] = [];
  const appointments: SalonAppointment[] = [];
  const ads: AdDay[] = [];
  const email: EmailDay[] = [];
  let o = 0, a = 0, ad = 0, e = 0;

  for (const day of all) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay(); // 6 = Saturday: salon closed, fewer orders
    for (const line of PRODUCT_LINES) {
      const spec = LINE[line];
      const n = count(spec.perDay * (weekday === 6 ? 0.4 : 1));
      for (let i = 0; i < n; i++) {
        const units = line === 'accessories' ? 1 + Math.floor(r() * 3) : 1;
        const gross = cents(between(spec.price[0], spec.price[1]) * units);
        const discount = r() < 0.25 ? cents(gross * (r() < 0.5 ? 0.1 : 0.15)) : 0;
        const channel = ONLINE_CHANNELS[Math.floor(r() * ONLINE_CHANNELS.length)]!;
        orders.push({
          order_id: `demo-o-${String(++o).padStart(5, '0')}`, order_date: day, product_line: line, channel, units,
          gross_usd: gross, discount_usd: discount, net_usd: cents(gross - discount), cost_usd: cents(gross * (1 - spec.margin)),
        });
      }
    }
    if (weekday !== 6) {
      for (const service of SALON_SERVICES) {
        const spec = SERVICE[service];
        const n = count(spec.perDay * (weekday === 5 ? 0.5 : 1));
        for (let i = 0; i < n; i++) {
          appointments.push({
            appointment_id: `demo-a-${String(++a).padStart(5, '0')}`, appointment_date: day, service,
            stylist_id: `demo-s-${1 + Math.floor(r() * 4)}`, price_usd: cents(between(spec.price[0], spec.price[1])),
            duration_min: spec.minutes, status: r() < 0.04 ? 'no_show' : 'completed',
          });
        }
      }
    }
    for (const channel of ['google', 'amazon'] as const) {
      for (const keyword of KEYWORDS[channel]) {
        const spend = cents(between(channel === 'google' ? 8 : 2, channel === 'google' ? 28 : 9));
        const clicks = Math.max(1, Math.round(spend / between(0.6, 1.8)));
        const conversions = r() < (channel === 'google' ? 0.08 : 0.3) ? 1 : 0;
        const revenue = conversions ? cents(channel === 'google' ? between(450, 1900) : between(20, 70)) : 0;
        ads.push({ ad_id: `demo-ad-${String(++ad).padStart(5, '0')}`, ad_date: day, channel, keyword, spend_usd: spend, clicks, conversions, revenue_usd: revenue });
      }
    }
    for (const m of EMAILS) {
      if (m.kind === 'campaign' && weekday !== 2) continue; // one campaign a week, Tuesdays
      const sends = m.kind === 'campaign' ? Math.round(between(1800, 2400)) : Math.round(between(8, 40));
      const opens = Math.round(sends * between(0.35, 0.55));
      const clicks = Math.round(opens * between(0.04, 0.12));
      email.push({ email_id: `demo-em-${String(++e).padStart(5, '0')}`, send_date: day, kind: m.kind, name: m.name, sends, opens, clicks, revenue_usd: r() < 0.3 ? cents(between(90, 1400)) : 0 });
    }
  }

  // Deliberately bad rows for the data-quality rule (never valid business data).
  orders.push(
    { order_id: 'demo-o-bad-negative', order_date: '2026-09-14', product_line: 'mazali', channel: 'direct', units: 1, gross_usd: -1200, discount_usd: 0, net_usd: -1200, cost_usd: 500 },
    { order_id: 'demo-o-bad-line', order_date: '2026-10-03', product_line: 'unknown_line', channel: 'google', units: 1, gross_usd: 999, discount_usd: 0, net_usd: 999, cost_usd: 400 },
  );
  appointments.push({ appointment_id: 'demo-a-bad-price', appointment_date: '2026-09-22', service: 'wash_set', stylist_id: 'demo-s-1', price_usd: -80, duration_min: 60, status: 'completed' });

  return { generatedFor: 'Fortune AI Headquarters (synthetic)', seed, online: { orders }, salon: { appointments }, marketing: { ads, email } };
}
