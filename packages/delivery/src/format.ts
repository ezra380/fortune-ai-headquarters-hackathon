import type { Metric, WorkerId } from '@fahq/contracts';

// How a number is written in a report, by its unit. The same words are used in the PDF and in the email,
// so a number reads the same wherever the head sees it.

/** What the head sees for each worker (every id has one: the record's type forces it). */
export const WORKER_LABEL: Record<WorkerId, string> = {
  'finance.email': 'Email',
  'finance.google_ads': 'Google Ads',
  'finance.meta': 'Meta ads',
  'finance.amazon': 'Amazon',
  'finance.walmart': 'Walmart',
  'finance.online_money': 'Online store money',
  'finance.salon_money': 'Salon money',
  'online.messages': 'Messages',
  'online.journey': 'Store journey',
  'online.inventory': 'Stock and products',
  'online.returns_reviews': 'Returns and reviews',
  'online.site_content': 'Site and blog',
  'salon.clients': 'Clients',
  'salon.turnaround': 'Repairs and personalization',
  'salon.appointments': 'Appointments',
};

/**
 * A ratio is shown as a percent (a share, a rate, a margin) except the few that are a multiple of what was
 * spent or of a typical month: "3.1x" is how a head reads an ad return, "310%" would mislead.
 */
const MULTIPLE = /\.(?:roas|mer|month_index|last_year_index)$/;

function plain(value: number, digits = 2): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function percent(value: number): string {
  // Whole percents from ten up, one decimal below (0.3%, 4.2%), so a small rate does not round to nothing.
  return `${plain(value, Math.abs(value) >= 10 ? 0 : 1)}%`;
}

export function money(value: number): string {
  const text = Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2, minimumFractionDigits: Number.isInteger(value) || Math.abs(value) >= 1000 ? 0 : 2 });
  return `${value < 0 ? '-' : ''}$${text}`;
}

/** A metric's value written for a person: dollars, counts, a ratio as a percent, minutes, days, seconds, a score. */
export function formatValue(m: Pick<Metric, 'id' | 'value' | 'unit'>): string {
  switch (m.unit) {
    case 'usd': return money(m.value);
    case 'count': return plain(m.value);
    case 'percent': return percent(m.value);
    case 'ratio': return MULTIPLE.test(m.id) ? `${plain(m.value)}x` : percent(m.value * 100);
    case 'minutes': return `${plain(m.value)} min`;
    case 'days': return `${plain(m.value, 1)} ${m.value === 1 ? 'day' : 'days'}`;
    case 'seconds': return `${plain(m.value)} s`;
    case 'score': return plain(m.value);
  }
}

/** The date a person reads ("Mon, Oct 26, 2026") for a YYYY-MM-DD day, in any time zone. */
export function longDate(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  return date.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

