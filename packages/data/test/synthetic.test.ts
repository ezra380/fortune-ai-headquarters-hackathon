import { describe, expect, it } from 'vitest';
import { generateBusiness, PRODUCT_LINES, SALON_SERVICES } from '../src/synthetic.ts';

describe('synthetic business', () => {
  const data = generateBusiness();

  it('is deterministic for a seed and different for another', () => {
    expect(JSON.stringify(generateBusiness())).toBe(JSON.stringify(data));
    expect(JSON.stringify(generateBusiness(7))).not.toBe(JSON.stringify(data));
  });

  it('uses only synthetic ids and stays inside Sept 1 to Oct 26, 2026', () => {
    const ids = [
      ...data.online.orders.map((o) => o.order_id), ...data.salon.appointments.map((a) => a.appointment_id),
      ...data.marketing.ads.map((a) => a.ad_id), ...data.marketing.email.map((m) => m.email_id),
    ];
    expect(ids.every((id) => id.startsWith('demo-'))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    const dates = [...data.online.orders.map((o) => o.order_date), ...data.salon.appointments.map((a) => a.appointment_date)];
    expect(dates.every((d) => d >= '2026-09-01' && d <= '2026-10-26')).toBe(true);
  });

  it('has every product line and service, closes the salon on Saturdays, and plants exactly three bad rows', () => {
    for (const line of PRODUCT_LINES) expect(data.online.orders.some((o) => o.product_line === line)).toBe(true);
    for (const s of SALON_SERVICES) expect(data.salon.appointments.some((a) => a.service === s)).toBe(true);
    expect(data.salon.appointments.filter((a) => !a.appointment_id.includes('bad')).every((a) => new Date(`${a.appointment_date}T00:00:00Z`).getUTCDay() !== 6)).toBe(true);
    const bad = [...data.online.orders, ...data.salon.appointments].filter((x) => ('order_id' in x ? x.order_id : x.appointment_id).includes('-bad-'));
    expect(bad).toHaveLength(3);
  });
});
