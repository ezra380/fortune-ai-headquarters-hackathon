import type { Division } from '@fahq/contracts';
import type { MetricDef } from './finance-sql.ts';
import { inDays } from './operations.ts';
import { ONE, counted, isNull, num, oneOf, quoted, type Cond, type Field, type Row, type SourceSpec } from './sql.ts';
import { AS_OF, BLOG_TOPICS, PAGE_TYPES, SITE_PAGES, WEB_SOURCES } from './synthetic.ts';

// The store's site wave 2 adds for Online (docs/wave2.md, item 6): each page's day by where its visitors came from
// (sessions, carts, checkouts, orders and how fast the page drew), the weekly crawl of the site's links, and the blog's
// posts. Each its own source with its data-quality rule and a rejected-rows metric. The page days re-count the store's
// orders, so each day's orders add up to the online order count exactly (a test). Who reads what: the site is Online's;
// HQ reads what the attention list watches (broken links, slow pages, stale posts).

export const WEB_SOURCE_NAMES = ['page_days', 'crawl', 'blog_posts'] as const;
export type WebSource = (typeof WEB_SOURCE_NAMES)[number];

const str = (r: Row, k: string) => String(r[k]);
const PAGE_NAMES = SITE_PAGES.map((p) => p.page);

export const WEB_SOURCES_SPEC: Record<WebSource, SourceSpec> = {
  page_days: {
    table: 'web_page_days', date: 'visit_date',
    // Each step of the journey is at most the one before it.
    validSql: `orders >= 0 AND checkouts >= orders AND carts >= checkouts AND sessions >= carts AND lcp_ms > 0 AND source IN (${quoted(WEB_SOURCES)}) AND page IN (${quoted(PAGE_NAMES)}) AND page_type IN (${quoted(PAGE_TYPES)})`,
    valid: (r) => num(r, 'orders') >= 0 && num(r, 'checkouts') >= num(r, 'orders') && num(r, 'carts') >= num(r, 'checkouts') && num(r, 'sessions') >= num(r, 'carts')
      && num(r, 'lcp_ms') > 0 && oneOf(WEB_SOURCES, r.source) && oneOf(PAGE_NAMES, r.page) && oneOf(PAGE_TYPES, r.page_type),
  },
  crawl: {
    table: 'web_crawl', date: 'crawl_date',
    validSql: `http_status >= 100 AND http_status <= 599 AND page IN (${quoted(PAGE_NAMES)}) AND link LIKE '/%'`,
    valid: (r) => num(r, 'http_status') >= 100 && num(r, 'http_status') <= 599 && oneOf(PAGE_NAMES, r.page) && !isNull(r.link) && str(r, 'link').startsWith('/'),
  },
  blog_posts: {
    table: 'web_blog_posts', date: 'published_date',
    validSql: `last_updated >= published_date AND sessions_28d >= 0 AND topic IN (${quoted(BLOG_TOPICS)})`,
    valid: (r) => str(r, 'last_updated') >= str(r, 'published_date') && num(r, 'sessions_28d') >= 0 && oneOf(BLOG_TOPICS, r.topic),
  },
};

// ---- Conditions ---------------------------------------------------------------------------

/** A page counts as slow when its rows' average LCP over the period is above 2.5 seconds (Google's "good" line). */
export const SLOW_LCP_MS = 2500;
/** A post is stale when it was not updated in the 180 days to the data date. */
export const STALE_DAYS = 180;
/** A link is broken when the crawl got a 404 or a server error. */
export const BROKEN: Cond = { sql: '(http_status = 404 OR http_status >= 500)', js: (r) => num(r, 'http_status') === 404 || num(r, 'http_status') >= 500 };
export const STALE: Cond = { sql: `last_updated < '${inDays(-STALE_DAYS)}'`, js: (r) => str(r, 'last_updated') < inDays(-STALE_DAYS) };
const LCP_SECONDS: Field = { sql: '(lcp_ms / 1000)', js: (r) => num(r, 'lcp_ms') / 1000 };
/** The weekly crawl runs on Mondays; the data date is one, so the latest crawl is the data date's. */
const LATEST_CRAWL = { from: AS_OF, to: AS_OF } as const;

// ---- Metrics ------------------------------------------------------------------------------

const ROWS = ['row', 'rows'] as const;
const ONLINE: readonly Division[] = ['online'];
const ONLINE_HQ: readonly Division[] = ['online', 'hq'];

type Def = Omit<MetricDef, 'layer' | 'since' | 'business'>;
const ofLayer = (layer: MetricDef['layer']) => (d: Def): MetricDef => ({ business: 'online', ...d, layer, since: 2 });
const period = ofLayer('period');
const standing = ofLayer('standing');

/** Period totals: the page days by visit day, the crawl's rejected rows by crawl day, the posts by the day they were published. */
export const WEB_METRICS: MetricDef[] = [
  period({ id: 'm:online.web.sessions', label: 'Store site visits (sessions)', unit: 'count', divisions: ONLINE, source: 'page_days', agg: { kind: 'sum', field: 'sessions' }, nouns: counted(['session', 'sessions', 'visit', 'visits'], ['site', 'store']) }),
  period({ id: 'm:online.web.cart_rate', label: 'Site visits that added to the cart', unit: 'ratio', divisions: ONLINE, source: 'page_days', agg: { kind: 'ratio', num: 'carts', den: 'sessions' } }),
  period({ id: 'm:online.web.conversion_rate', label: 'Site visits that ended in an order', unit: 'ratio', divisions: ONLINE, source: 'page_days', agg: { kind: 'ratio', num: 'orders', den: 'sessions' } }),
  period({
    id: 'm:online.web.slow_pages.count', label: 'Site pages that drew slowly', unit: 'count', divisions: ONLINE_HQ, source: 'page_days',
    agg: { kind: 'above', by: 'page', field: 'lcp_ms', over: SLOW_LCP_MS }, nouns: counted(['page', 'pages'], ['slow', 'slow-loading']),
    about: 'Pages whose average largest contentful paint over the period was above 2.5 seconds.',
  }),
  period({
    id: 'm:online.web.lcp_avg_seconds', label: 'Average time for a page to draw (largest contentful paint)', unit: 'seconds', divisions: ONLINE, source: 'page_days',
    agg: { kind: 'ratio', num: LCP_SECONDS, den: ONE }, planUse: false, about: 'In seconds, averaged over every page and source of every day in the period.',
  }),
  period({ id: 'm:online.dq.rejected_page_days', label: 'Site page rows rejected by data checks', unit: 'count', divisions: ONLINE_HQ, source: 'page_days', agg: { kind: 'rejected' }, nouns: counted(ROWS, ['page', 'site']) }),
  period({ id: 'm:online.dq.rejected_crawl', label: 'Site crawl rows rejected by data checks', unit: 'count', divisions: ONLINE_HQ, source: 'crawl', agg: { kind: 'rejected' }, nouns: counted(ROWS, ['crawl', 'link']) }),
  period({ id: 'm:online.blog.published.count', label: 'Blog posts published', unit: 'count', divisions: ONLINE, source: 'blog_posts', agg: { kind: 'count' }, nouns: counted(['post', 'posts'], ['published', 'new']) }),
  period({ id: 'm:online.dq.rejected_blog_posts', label: 'Blog post rows rejected by data checks', unit: 'count', divisions: ONLINE_HQ, source: 'blog_posts', agg: { kind: 'rejected' }, nouns: counted(ROWS, ['blog', 'post']) }),
];

/** Standing numbers: the latest crawl's broken links, and the posts not updated in half a year. */
export const WEB_STANDING: MetricDef[] = [
  standing({
    id: 'm:online.web.broken_links.count', label: 'Broken links on the site', unit: 'count', divisions: ONLINE_HQ, source: 'crawl', agg: { kind: 'count' }, test: BROKEN,
    window: LATEST_CRAWL, nouns: counted(['link', 'links'], ['broken', 'dead']), about: `In the latest weekly crawl, on the data date, ${AS_OF}: a 404 or a server error.`,
  }),
  standing({
    id: 'm:online.blog.stale.count', label: 'Blog posts not updated in half a year', unit: 'count', divisions: ONLINE_HQ, source: 'blog_posts', agg: { kind: 'count' }, test: STALE,
    nouns: counted(['post', 'posts'], ['stale', 'old', 'outdated']), about: `Last updated more than ${STALE_DAYS} days before the data date, ${AS_OF}.`,
  }),
];

/** The oracle's twin of the 'above' aggregate: how many groups' field averages above `over` (exactly, as SQL compares). */
export function groupsAbove(rows: readonly Row[], by: string, field: Field, over: number): number {
  const f = typeof field === 'string' ? (r: Row) => num(r, field) : field.js;
  const sums = new Map<string, { total: number; n: number }>();
  for (const r of rows) {
    const s = sums.get(str(r, by)) ?? { total: 0, n: 0 };
    sums.set(str(r, by), { total: s.total + f(r), n: s.n + 1 });
  }
  return [...sums.values()].filter((s) => s.total / s.n > over).length;
}
