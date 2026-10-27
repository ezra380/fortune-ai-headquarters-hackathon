import { PERIOD_KEYS, type Period } from '@fahq/contracts';
import { describe, expect, it } from 'vitest';
import { attentionFor } from '../src/divisions.ts';
import { SOURCES, financeViewBody, specOf } from '../src/finance-sql.ts';
import { computeLayers, standingViewBody } from '../src/layers.ts';
import { AS_OF, PERIODS, SITE_PAGES, generateYear } from '../src/synthetic.ts';
import { BROKEN, SLOW_LCP_MS, STALE_DAYS, WEB_METRICS, WEB_SOURCE_NAMES, WEB_STANDING } from '../src/web.ts';

// The store site wave 2 adds for Online (docs/wave2.md, item 6): the page days, the weekly crawl and the blog posts.
// Each number is counted again here straight from the rows; the page days' orders add up to the store's order count.

const year = generateYear();
const layers = computeLayers(year);
const at = (p: Period, id: string) => layers.period.get(p)!.get(id);
const standing = (id: string) => layers.standing.get(id);
const inPeriod = (p: Period, day: string) => day >= PERIODS[p].from && day <= PERIODS[p].to;
const rows = { page_days: year.web.pageDays, crawl: year.web.crawl, blog_posts: year.web.blogPosts } as const;
const dateOf = { page_days: 'visit_date', crawl: 'crawl_date', blog_posts: 'published_date' } as const;
const good = <K extends keyof typeof rows>(k: K) => (rows[k] as readonly Record<string, unknown>[]).filter((r) => SOURCES[k].valid(r)) as unknown as (typeof rows)[K];

describe('the store site: data-quality rules', () => {
  it('reject exactly the one planted row of each source, and count it in its own month only', () => {
    const rejected = { page_days: 'm:online.dq.rejected_page_days', crawl: 'm:online.dq.rejected_crawl', blog_posts: 'm:online.dq.rejected_blog_posts' } as const;
    for (const source of WEB_SOURCE_NAMES) {
      const all = rows[source] as readonly Record<string, unknown>[];
      const bad = all.filter((r) => String(Object.values(r)[0]).includes('-bad-'));
      expect(bad, source).toHaveLength(1);
      expect(all.filter((r) => !SOURCES[source].valid(r)), source).toEqual(bad);
      const month = PERIOD_KEYS.find((p) => inPeriod(p, String(bad[0]![dateOf[source]])))!;
      for (const p of PERIOD_KEYS) expect(at(p, rejected[source]), `${source} ${p}`).toBe(p === month ? 1 : 0);
    }
  });

  it('serve every new metric in every one of the thirteen periods, each source read once by the period view', () => {
    for (const p of PERIOD_KEYS) for (const m of WEB_METRICS) expect(layers.period.get(p)!.has(m.id), `${m.id} ${p}`).toBe(true);
    for (const m of WEB_STANDING) expect(layers.standing.has(m.id), m.id).toBe(true);
    const body = financeViewBody(2);
    for (const source of WEB_SOURCE_NAMES) expect(body.split(`fortune_hq_v2.${SOURCES[source].table} `).length - 1, source).toBe(1);
    expect(body).toContain('END, page) g_page_days GROUP BY period');
  });
});

describe('the page days', () => {
  const days = good('page_days');

  it("share out each day's store orders exactly: a day's orders are the day's online orders", () => {
    const sold = new Map<string, number>();
    for (const o of year.online.orders.filter((x) => specOf('orders', 2).valid(x))) sold.set(o.order_date, (sold.get(o.order_date) ?? 0) + 1);
    const placed = new Map<string, number>();
    for (const d of days) placed.set(d.visit_date, (placed.get(d.visit_date) ?? 0) + d.orders);
    for (const [day, n] of placed) expect(n, day).toBe(sold.get(day) ?? 0);
    for (const p of PERIOD_KEYS) expect(days.filter((d) => inPeriod(p, d.visit_date)).reduce((t, d) => t + d.orders, 0), p).toBe(at(p, 'm:online.orders.count'));
  });

  it('total the visits, carts and orders of each period, and count the pages that drew slowly on average', () => {
    let slowSeen = 0;
    for (const p of PERIOD_KEYS) {
      const mine = days.filter((d) => inPeriod(p, d.visit_date));
      const add = (k: 'sessions' | 'carts' | 'orders' | 'lcp_ms') => mine.reduce((t, d) => t + d[k], 0);
      expect(at(p, 'm:online.web.sessions'), p).toBe(add('sessions'));
      expect(at(p, 'm:online.web.cart_rate'), p).toBe(Math.round((add('carts') / add('sessions')) * 10_000) / 10_000);
      expect(at(p, 'm:online.web.conversion_rate'), p).toBe(Math.round((add('orders') / add('sessions')) * 10_000) / 10_000);
      expect(at(p, 'm:online.web.lcp_avg_seconds'), p).toBe(Math.round((add('lcp_ms') / 1000 / mine.length) * 10_000) / 10_000);
      const slow = SITE_PAGES.filter((pg) => {
        const own = mine.filter((d) => d.page === pg.page);
        return own.reduce((t, d) => t + d.lcp_ms, 0) / own.length > SLOW_LCP_MS;
      });
      expect(at(p, 'm:online.web.slow_pages.count'), p).toBe(slow.length);
      slowSeen += slow.length;
    }
    expect(slowSeen).toBeGreaterThan(0);
    expect(at('2026-09', 'm:online.web.slow_pages.count')).toBeLessThan(SITE_PAGES.length);
  });
});

describe('the crawl and the blog', () => {
  it('count the broken links of the latest crawl (the data date, a Monday), and the rule acts', () => {
    expect(new Date(`${AS_OF}T00:00:00Z`).getUTCDay()).toBe(1);
    const latest = good('crawl').filter((c) => c.crawl_date === AS_OF);
    expect(latest).toHaveLength(SITE_PAGES.length * 6);
    const broken = latest.filter((c) => c.http_status === 404 || c.http_status >= 500).length;
    expect(standing('m:online.web.broken_links.count')).toBe(broken);
    expect(broken).toBeGreaterThan(0);
    expect(attentionFor([{ id: 'm:online.web.broken_links.count', value: broken }])[0]).toMatchObject({ level: 'act' });
    expect(standingViewBody()).toContain(`crawl_date >= '${AS_OF}' AND crawl_date <= '${AS_OF}'`);
    // Broken: a 404 or any server error; a redirect or a success is not.
    for (const [status, broken] of [[404, true], [500, true], [503, true], [301, false], [200, false], [410, false]] as const) expect(BROKEN.js({ http_status: status }), String(status)).toBe(broken);
    expect(BROKEN.sql).toBe('(http_status = 404 OR http_status >= 500)');
    // Some link of the year's crawls answered with a server error.
    expect(good('crawl').some((c) => c.http_status >= 500)).toBe(true);
  });

  it('count the posts published each period, and the posts not updated in half a year', () => {
    const posts = good('blog_posts');
    for (const p of PERIOD_KEYS) expect(at(p, 'm:online.blog.published.count'), p).toBe(posts.filter((b) => inPeriod(p, b.published_date)).length);
    const cutoff = new Date(Date.parse(`${AS_OF}T00:00:00Z`) - STALE_DAYS * 86_400_000).toISOString().slice(0, 10);
    const stale = posts.filter((b) => b.last_updated < cutoff).length;
    expect(standing('m:online.blog.stale.count')).toBe(stale);
    expect(stale).toBeGreaterThan(0);
    expect(stale).toBeLessThan(posts.length);
  });
});
