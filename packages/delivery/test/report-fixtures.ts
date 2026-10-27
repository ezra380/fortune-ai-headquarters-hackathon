import { MANAGERS, WeeklyReport, WorkerReport, type ManagedDivision, type Metric, type WorkerId } from '@fahq/contracts';

// SYNTHETIC reports for the delivery tests and the sample PDFs in docs/samples. No real customer, address, phone
// number or message text: only invented numbers shaped like the ones the data lane serves. Every report here is
// parsed with its real schema, so a fixture that drifts from the contract fails the tests that use it.

const source = { system: 'zetaris' as const, view: 'fortune_demo_marts', queryHash: 'c'.repeat(64), asOf: '2026-10-26T11:00:00Z' };
export const PERIOD = '2026-10-mtd';

const metric = (id: string, label: string, value: number, unit: Metric['unit']): Metric => ({
  id, label, value, unit, business: id.split('.')[0]!.slice(2) as Metric['business'], period: PERIOD, source,
});

type Spec = {
  status: WorkerReport['status'];
  headline: string;
  findings: [text: string, ...cites: string[]][];
  metrics: Metric[];
  attention?: { metricId: string; level: 'watch' | 'act'; rule: string }[];
  rows?: { read: string; totals: Record<string, number> }[];
};

const SPECS: Record<WorkerId, Spec> = {
  'finance.email': {
    status: 'normal',
    headline: 'Email earned $25,300 so far this month, most of it from flows',
    findings: [
      ['Flows earned $18,400 from 61,200 sends; campaigns earned $6,900 from 24,500.', 'm:online.email.flow.revenue', 'm:online.email.campaign.revenue'],
      ['Unsubscribes stayed at 0.3% of sends.', 'm:online.email.unsubscribe_rate'],
    ],
    metrics: [
      metric('m:online.email.flow.revenue', 'Revenue from flow emails', 18400, 'usd'),
      metric('m:online.email.campaign.revenue', 'Revenue from campaign emails', 6900, 'usd'),
      metric('m:online.email.flow.sends', 'Flow emails sent', 61200, 'count'),
      metric('m:online.email.campaign.sends', 'Campaign emails sent', 24500, 'count'),
      metric('m:online.email.unsubscribe_rate', 'Unsubscribes over sends', 0.003, 'ratio'),
    ],
  },
  'finance.google_ads': {
    status: 'watch',
    headline: 'Google Ads returns 3.1x, with $2,300 of budget left',
    findings: [
      ['$9,200 of spend brought $28,520 of revenue, a return of 3.1x.', 'm:online.ads.google.spend', 'm:online.ads.google.revenue', 'm:online.ads.google.roas'],
      ['80% of the approved Google budget is used.', 'm:online.budget.google.used'],
    ],
    metrics: [
      metric('m:online.ads.google.spend', 'Google ad spend', 9200, 'usd'),
      metric('m:online.ads.google.revenue', 'Google ad revenue', 28520, 'usd'),
      metric('m:online.ads.google.roas', 'Google ad return (revenue / spend)', 3.1, 'ratio'),
      metric('m:online.budget.google.used', 'Share of the approved Google ad budget spent', 0.8, 'ratio'),
    ],
    attention: [{ metricId: 'm:online.budget.google.used', level: 'watch', rule: 'The Google budget is mostly spent' }],
    rows: [{ read: 'budget room', totals: { room_usd: 2300 } }],
  },
  'finance.meta': {
    status: 'act',
    headline: 'Meta ads return 1.4x, below the level that pays for them',
    findings: [
      ['$4,100 of Meta spend brought $5,740 of revenue, a return of 1.4x.', 'm:online.ads.meta.spend', 'm:online.ads.meta.revenue', 'm:online.ads.meta.roas'],
    ],
    metrics: [
      metric('m:online.ads.meta.spend', 'Meta ad spend', 4100, 'usd'),
      metric('m:online.ads.meta.revenue', 'Meta ad revenue', 5740, 'usd'),
      metric('m:online.ads.meta.roas', 'Meta ad return (revenue / spend)', 1.4, 'ratio'),
      metric('m:online.budget.meta.used', 'Share of the approved Meta ad budget spent', 0.82, 'ratio'),
    ],
    attention: [{ metricId: 'm:online.ads.meta.roas', level: 'act', rule: 'Meta ads return less than they cost to be worth keeping' }],
    rows: [{ read: 'budget room', totals: { room_usd: 900 } }],
  },
  'finance.amazon': {
    status: 'act',
    headline: 'Amazon sold $21,300, and one item is out of stock',
    findings: [
      ['412 orders brought $21,300; Amazon fees were $3,195.', 'm:online.amazon.orders.count', 'm:online.amazon.revenue', 'm:online.amazon.fees'],
      ['3 items have under three weeks of cover and 1 is out.', 'm:online.amazon.stock.low_cover.count', 'm:online.amazon.stock.out.count'],
    ],
    metrics: [
      metric('m:online.amazon.revenue', 'Amazon revenue', 21300, 'usd'),
      metric('m:online.amazon.orders.count', 'Amazon orders', 412, 'count'),
      metric('m:online.amazon.fees', 'Amazon fees', 3195, 'usd'),
      metric('m:online.amazon.stock.low_cover.count', 'Amazon items with under three weeks of cover', 3, 'count'),
      metric('m:online.amazon.stock.out.count', 'Amazon items out of stock', 1, 'count'),
    ],
    attention: [{ metricId: 'm:online.amazon.stock.out.count', level: 'act', rule: 'An Amazon item is out of stock' }],
    rows: [{ read: 'marketplace stock', totals: { low_cover_items: 3, out_items: 1, inbound_units: 600 } }],
  },
  'finance.walmart': {
    status: 'watch',
    headline: 'Walmart sold $6,800 and one item has low cover',
    findings: [['133 orders brought $6,800; fees were $1,020.', 'm:online.walmart.orders.count', 'm:online.walmart.revenue', 'm:online.walmart.fees']],
    metrics: [
      metric('m:online.walmart.revenue', 'Walmart revenue', 6800, 'usd'),
      metric('m:online.walmart.orders.count', 'Walmart orders', 133, 'count'),
      metric('m:online.walmart.fees', 'Walmart fees', 1020, 'usd'),
      metric('m:online.ads.walmart.roas', 'Walmart ad return (revenue / spend)', 2.9, 'ratio'),
      metric('m:online.walmart.stock.low_cover.count', 'Walmart items with under three weeks of cover', 1, 'count'),
    ],
    attention: [{ metricId: 'm:online.walmart.stock.low_cover.count', level: 'watch', rule: 'A Walmart item is running low' }],
  },
  'finance.online_money': {
    status: 'watch',
    headline: 'The online store made $112,400, and supplier bills are open',
    findings: [
      ['Gross profit was $58,400 and contribution $21,300 on $112,400 of revenue.', 'm:online.revenue', 'm:online.gross_profit', 'm:online.contribution'],
      ['Every ad dollar brought back 3.4x across all channels.', 'm:online.mer'],
    ],
    metrics: [
      metric('m:online.revenue', 'Online revenue', 112400, 'usd'),
      metric('m:online.gross_profit', 'Online gross profit', 58400, 'usd'),
      metric('m:online.contribution', 'Online contribution after ads, fees and shipping', 21300, 'usd'),
      metric('m:online.mer', 'Online revenue per ad dollar, all channels', 3.4, 'ratio'),
      metric('m:online.refund_rate', 'Online refunds against online revenue', 0.043, 'ratio'),
    ],
    attention: [{ metricId: 'm:online.contribution', level: 'watch', rule: 'Online supplier invoices are open' }],
    rows: [{ read: 'invoices (online)', totals: { open_count: 4, open_usd: 12800 } }],
  },
  'finance.salon_money': {
    status: 'normal',
    headline: 'The salon made $96,500, kept apart from the online store',
    findings: [
      ['Gross profit was $52,100 after labor of $31,800 on $96,500 of revenue.', 'm:salon.revenue', 'm:salon.gross_profit', 'm:salon.labor_cost'],
      ['Repairs brought $7,400 at a margin of 46%.', 'm:salon.repairs.revenue', 'm:salon.repairs.margin'],
    ],
    metrics: [
      metric('m:salon.revenue', 'Salon revenue', 96500, 'usd'),
      metric('m:salon.gross_profit', 'Salon gross profit', 52100, 'usd'),
      metric('m:salon.labor_cost', 'Salon labor cost', 31800, 'usd'),
      metric('m:salon.repairs.revenue', 'Salon repair fees paid', 7400, 'usd'),
      metric('m:salon.repairs.margin', 'Margin on finished, paid repairs', 0.46, 'ratio'),
    ],
  },
  'online.messages': {
    status: 'watch',
    headline: 'Replies are slower than last week and 6 messages are still waiting',
    findings: [
      ['Half of all messages were answered within the hour; the first reply took 85 minutes at the median.', 'm:online.service.replied_1h.share', 'm:online.service.first_reply_minutes'],
      ['7 buyers wrote on two channels about the same thing.', 'm:online.service.duplicate.count'],
    ],
    metrics: [
      metric('m:online.service.replied_1h.share', 'Customer messages answered within the hour', 0.52, 'ratio'),
      metric('m:online.service.first_reply_minutes', 'Median minutes to a first reply', 85, 'minutes'),
      metric('m:online.service.duplicate.count', 'Buyers who wrote twice on two channels', 7, 'count'),
      metric('m:online.service.waiting.count', 'Messages still waiting for a first reply', 6, 'count'),
    ],
    attention: [{ metricId: 'm:online.service.duplicate.count', level: 'watch', rule: 'Some customers wrote on two channels about one thing' }],
    rows: [{ read: 'waiting conversations', totals: { waiting: 6, oldest_hours: 31 } }],
  },
  'online.journey': {
    status: 'normal',
    headline: 'Visits converted at 2.4%, and 312 checkouts were left',
    findings: [['The store had 48,300 sessions and converted 2.4% of them.', 'm:online.web.sessions', 'm:online.web.conversion_rate']],
    metrics: [
      metric('m:online.web.sessions', 'Store sessions', 48300, 'count'),
      metric('m:online.web.conversion_rate', 'Sessions that ended in an order', 0.024, 'ratio'),
      metric('m:online.web.cart_rate', 'Sessions that added to cart', 0.071, 'ratio'),
      metric('m:online.checkouts.abandoned.count', 'Checkouts left behind', 312, 'count'),
      metric('m:online.checkouts.recovery_rate', 'Share of left checkouts that came back as an order', 0.14, 'ratio'),
    ],
  },
  'online.inventory': {
    status: 'watch',
    headline: 'Three popular products are nearly out of stock',
    findings: [['3 products are at or below their reorder point and viewed often.', 'm:online.inventory.low_stock.count']],
    metrics: [
      metric('m:online.inventory.low_stock.count', 'Products at or below their reorder point', 3, 'count'),
      metric('m:online.products.cogs', 'Cost of the goods sold', 54000, 'usd'),
      metric('m:online.products.negative_margin.count', 'Products sold at a loss', 2, 'count'),
    ],
    attention: [{ metricId: 'm:online.inventory.low_stock.count', level: 'watch', rule: 'Products that customers view are running low' }],
    rows: [{ read: 'low stock interest', totals: { products: 3, views_28d: 1840 } }],
  },
  'online.returns_reviews': {
    status: 'watch',
    headline: 'Returns are steady, and 2 buyers returned more than once',
    findings: [
      ['Refunds were 4.3% of revenue.', 'm:online.refund_rate'],
      ['2 customers have two or more refunds in a year.', 'm:online.returns.repeat_customers.count'],
    ],
    metrics: [
      metric('m:online.refund_rate', 'Online refunds against online revenue', 0.043, 'ratio'),
      metric('m:online.returns.repeat_customers.count', 'Customers with two or more refunds in 365 days', 2, 'count'),
      metric('m:online.reviews.avg_rating', 'Average review rating', 4.6, 'score'),
      metric('m:online.reviews.low_rating.count', 'Reviews of two stars or less', 4, 'count'),
    ],
    attention: [{ metricId: 'm:online.returns.repeat_customers.count', level: 'watch', rule: 'Some customers return again and again' }],
  },
  'online.site_content': {
    status: 'act',
    headline: 'One link on the site is broken, and the page speed is slow',
    findings: [['The weekly crawl found 1 broken link; pages load in 2.8 s on average.', 'm:online.web.broken_links.count', 'm:online.web.lcp_avg_seconds']],
    metrics: [
      metric('m:online.web.broken_links.count', 'Broken links in the latest crawl', 1, 'count'),
      metric('m:online.web.lcp_avg_seconds', 'Average time to the main picture', 2.8, 'seconds'),
      metric('m:online.web.slow_pages.count', 'Pages slower than the speed bar', 4, 'count'),
      metric('m:online.blog.stale.count', 'Blog posts not updated in 180 days', 9, 'count'),
    ],
    attention: [{ metricId: 'm:online.web.broken_links.count', level: 'act', rule: 'A link on the site is broken' }],
  },
  'salon.clients': {
    status: 'normal',
    headline: '1,240 clients are active, and the frequent ones bring the most',
    findings: [['Frequent clients spent $48,200 of the $96,500 the salon made.', 'm:salon.clients.frequent.revenue', 'm:salon.revenue']],
    metrics: [
      metric('m:salon.clients.active.count', 'Clients with a visit in the last year', 1240, 'count'),
      metric('m:salon.clients.frequent.count', 'Frequent clients', 210, 'count'),
      metric('m:salon.clients.frequent.revenue', 'Spend by frequent clients', 48200, 'usd'),
      metric('m:salon.clients.sale_only.count', 'Clients who only buy during sales', 180, 'count'),
      metric('m:salon.revenue', 'Salon revenue', 96500, 'usd'),
    ],
  },
  'salon.turnaround': {
    status: 'act',
    headline: 'Personalization is slow: 3 pieces have been open over three weeks',
    findings: [
      ['3 personalization pieces are open over 21 days.', 'm:salon.personalization.open_over_21d.count'],
      ['A repair takes 11.5 days on average.', 'm:salon.repairs.avg_days'],
    ],
    metrics: [
      metric('m:salon.personalization.open_over_21d.count', 'Personalization pieces open over 21 days', 3, 'count'),
      metric('m:salon.personalization.avg_days', 'Average days a personalization takes', 17.2, 'days'),
      metric('m:salon.repairs.avg_days', 'Average days a repair takes', 11.5, 'days'),
      metric('m:salon.repairs.within_14d.share', 'Repairs finished within two weeks of arrival', 0.68, 'ratio'),
    ],
    attention: [{ metricId: 'm:salon.personalization.open_over_21d.count', level: 'act', rule: 'Personalization work has been open too long' }],
    rows: [{ read: 'repair tickets', totals: { open: 22, late: 5 } }],
  },
  'salon.appointments': {
    status: 'normal',
    headline: 'The salon had 640 visits, and 9% of them were no-shows',
    findings: [['640 visits were booked; 9% were no-shows.', 'm:salon.appointments.count', 'm:salon.no_show_rate']],
    metrics: [
      metric('m:salon.appointments.count', 'Salon appointments', 640, 'count'),
      metric('m:salon.no_show_rate', 'No-shows over booked visits', 0.09, 'ratio'),
      metric('m:salon.booked_online.share', 'Visits booked through the online store', 0.31, 'ratio'),
    ],
  },
};

export const WORKERS_OF: Record<ManagedDivision, WorkerId[]> = {
  finance: ['finance.email', 'finance.google_ads', 'finance.meta', 'finance.amazon', 'finance.walmart', 'finance.online_money', 'finance.salon_money'],
  online: ['online.messages', 'online.journey', 'online.inventory', 'online.returns_reviews', 'online.site_content'],
  salon: ['salon.clients', 'salon.turnaround', 'salon.appointments'],
};

export function workerReport(id: WorkerId, change: Partial<WorkerReport> = {}): WorkerReport {
  const spec = SPECS[id];
  return WorkerReport.parse({
    workerId: id,
    day: '2026-10-26',
    period: PERIOD,
    status: spec.status,
    writtenBy: 'model',
    headline: spec.headline,
    findings: spec.findings.map(([text, ...cites]) => ({ text, cites })),
    metrics: spec.metrics,
    attention: spec.attention ?? [],
    rows: spec.rows ?? [],
    dataSource: `fortune_demo_marts#${'c'.repeat(12)}`,
    ...change,
  });
}

export const workerReportsOf = (division: ManagedDivision): WorkerReport[] => WORKERS_OF[division].map((id) => workerReport(id));

const plan = (rank: number, title: string, summary: string, actions: string[], evidence: [string, number][], projection: [string, string, number, number, string], test: string, stopLoss: string, risks: string[]) => ({
  rank, title, summary, actions,
  evidence: evidence.map(([metricId, value]) => ({ metricId, value })),
  projections: [{ label: projection[0], baseMetricId: projection[1], factor: projection[2], result: projection[3], assumption: projection[4] }],
  levers: [],
  test, stopLoss, businesses: ['online' as const], risks,
});

const FINANCE_PATHS = {
  plans: [
    plan(1, 'Move a quarter of the Meta budget to Google', 'Google returns 3.1x and Meta 1.4x, so a dollar on Google brings back more than twice as much. Google has $2,300 of budget left.',
      ['Cut the Meta budget by a quarter for seven days', 'Add the same dollars to the Google budget'],
      [['m:online.ads.google.roas', 3.1], ['m:online.ads.meta.roas', 1.4]],
      ['Meta spend after cutting a quarter', 'm:online.ads.meta.spend', 0.75, 3075, 'A quarter of the Meta spend moves to Google'],
      'Run seven days and compare contribution with the week before.', 'Stop if the Google return falls below 2.5x.', ['A higher Google spend may return less per dollar']),
    plan(2, 'Restock the Amazon item that is out', 'One Amazon item is out of stock and 3 more have under three weeks of cover; 600 units are already inbound.',
      ['Ship the inbound units to the Amazon warehouse', 'Order the low-cover items now'],
      [['m:online.amazon.stock.out.count', 1], ['m:online.amazon.revenue', 21300]],
      ['Amazon revenue held by staying in stock', 'm:online.amazon.revenue', 0.05, 1065, 'About 5% of revenue is at risk while items are out'],
      'Check stock cover again in seven days.', 'Stop ordering if cover passes 60 days.', ['Cash tied up in stock']),
    plan(3, 'Send one campaign to engaged online customers', 'Campaigns earned $6,900 and flows $18,400, and unsubscribes are low at 0.3%, so there is room for one more campaign.',
      ['Send one campaign to engaged online customers', 'Keep the seven-day rule for every person'],
      [['m:online.email.campaign.revenue', 6900], ['m:online.email.unsubscribe_rate', 0.003]],
      ['A campaign like this month\'s average', 'm:online.email.campaign.revenue', 0.5, 3450, 'One more campaign earns half the month so far'],
      'Send once and read revenue and unsubscribes after three days.', 'Stop if unsubscribes pass 0.6%.', ['Fatigue for the people who hear from us often']),
  ],
  memoryConflicts: [],
};

const ONLINE_ACTIONS = [
  { rank: 1, title: 'Answer the 6 waiting messages today', why: 'Six customers have waited for a first reply and the oldest has waited 31 hours.', steps: 'Emma works the oldest first; Georgette checks the queue at the end of the day.', cites: ['m:online.service.waiting.count'] },
  { rank: 2, title: 'Fix the broken link on the site', why: 'The weekly crawl found one broken link, and the speed is slow on 4 pages.', steps: 'Find the page that links to it and repoint the link; look at the 4 slow pages next.', cites: ['m:online.web.broken_links.count', 'm:online.web.slow_pages.count'] },
  { rank: 3, title: 'Reorder the 3 popular products that are low', why: 'Three products customers view often are at their reorder point.', steps: 'Ask the supplier for dates; hold promotions on those products until they arrive.', cites: ['m:online.inventory.low_stock.count'] },
];

const SALON_ACTIONS = [
  { rank: 1, title: 'Finish the 3 personalization pieces that are over three weeks', why: 'Three pieces have been open longer than 21 days.', steps: 'Cindy lists the stage each is stuck in and Esther picks the order.', cites: ['m:salon.personalization.open_over_21d.count'] },
];

const SUMMARY: Record<ManagedDivision, string> = {
  finance: 'Money is healthy: the online store made $112,400 and the salon $96,500, kept apart. Meta ads return 1.4x and should be cut back; one Amazon item is out of stock.',
  online: 'Customers are served, but replies slowed to 85 minutes and 6 messages are waiting. One site link is broken and three popular products are low.',
  salon: 'The salon had 640 visits and no-shows were 9%. Personalization is slow: 3 pieces are open over three weeks.',
};

const ASKED: Record<ManagedDivision, WeeklyReport['asked']> = {
  finance: [
    { division: 'online', question: 'Which products earn the most profit, and which lose money on a sale?', answer: '2 products were sold at a loss this month; the rest earned a profit.', ok: true },
    { division: 'salon', question: 'How much of the salon revenue comes from frequent clients?', answer: 'Frequent clients spent $48,200 of the salon revenue.', ok: true },
  ],
  online: [{ division: 'finance', question: 'How much stock does Amazon hold of our best sellers?', answer: 'Finance could not answer this week: the stock read was unavailable.', ok: false }],
  salon: [],
};

export function weeklyReport(division: ManagedDivision, change: Record<string, unknown> = {}): WeeklyReport {
  const reports = workerReportsOf(division);
  const finance = division === 'finance';
  return WeeklyReport.parse({
    division,
    weekOf: '2026-10-26',
    manager: MANAGERS[division].manager,
    head: MANAGERS[division].head,
    period: PERIOD,
    status: reports.some((r) => r.status === 'act') ? 'act' : reports.some((r) => r.status === 'watch') ? 'watch' : 'normal',
    writtenBy: 'model',
    summary: SUMMARY[division],
    sections: reports.map((r) => ({ workerId: r.workerId, status: r.status, summary: r.headline, cites: r.findings.flatMap((f) => f.cites).slice(0, 3) })),
    asked: ASKED[division],
    goal: finance ? { title: 'Lift online contribution by $2,700 this week', metricId: 'm:online.contribution', from: 21300, to: 24000, by: '2026-11-01', why: 'Moving the Meta dollars to Google and keeping Amazon in stock protects profit without adding spend.' } : null,
    paths: finance ? FINANCE_PATHS : null,
    actions: division === 'online' ? ONLINE_ACTIONS : division === 'salon' ? SALON_ACTIONS : [],
    ceoLine: finance ? 'Finance is healthy; Meta ads should be cut back.' : division === 'online' ? 'Online is steady; replies are slowing.' : 'Salon is steady; personalization is late.',
    metrics: reports.flatMap((r) => r.metrics).filter((m, i, all) => all.findIndex((x) => x.id === m.id) === i),
    workerReportIds: reports.map((_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`),
    dataSource: `fortune_demo_marts#${'c'.repeat(12)}`,
    ...change,
  });
}
