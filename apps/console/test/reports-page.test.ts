import { describe, expect, it } from 'vitest';
import type { BriefDivision, RawDivisionReports, RawDivisions } from '../src/divisions.ts';
import { PAGE_CSP, PAGE_HTML } from '../src/page.ts';
import { shapeDivisions } from '../src/shape.ts';
import { drawPage } from './draw.ts';
import { approved, NOW, raw, reportsOf, state, weeklyReport, weeklyRow, weeklyRowId, workerReport, workerRow, workerRowId } from './reports-fixtures.ts';

// The page draws each division's reports for real against a tiny fake of the browser (see draw.ts): the page's own script runs and
// the text it drew comes back. The payload is what the server sends: the shaped view of rows built from the synthetic reports.

const payload = (r: RawDivisions = raw(), only?: BriefDivision) => JSON.parse(JSON.stringify(shapeDivisions(r, NOW, only)));
const withReports = (division: BriefDivision, over: Partial<RawDivisionReports>) =>
  raw({ divisions: [state('salon'), state('finance'), state('online')].map((s) => (s.division === division ? state(division, { reports: reportsOf(division, over) }) : s)) });
const finance = async () => (await drawPage('divisions/finance', payload())).text();

describe('the Divisions view: the division tabs', () => {
  it('opens on the company at a glance, with a tab for each division and each manager named', async () => {
    const page = await drawPage('divisions', payload());
    expect(page.fetched).toEqual(['/api/divisions']);
    expect(page.buttons()).toEqual(expect.arrayContaining(['Company', 'Finance', 'Online', 'Salon']));
    const text = page.text();
    expect(text).toContain('George, Finance, reports to Alan');
    expect(text).toContain('Georgette, Online, reports to Emma');
    expect(text).toContain('Cindy, Salon, reports to Esther');
    // The weekly report's standing is on the overview; the rest is on the division's own tab.
    expect(text).toContain('Weekly report for the week of Mon, Oct 26, 2026: needs a decision.');
    expect(text).not.toContain('Goal of the week');
  });

  it('opens a division\'s tab from the address, from the tab button, and from the overview, and remembers it in the address', async () => {
    const direct = await drawPage('divisions/online', payload());
    expect(direct.text()).toContain('Georgette, Online, reports to Emma');
    expect(direct.text()).not.toContain('George, Finance, reports to Alan');

    const page = await drawPage('divisions', payload());
    const after = await page.click('Finance');
    expect(after).toContain('George, Finance, reports to Alan');
    expect(after).toContain('Goal of the week');
    expect(page.hash()).toBe('#divisions/finance');
    await page.click('Company');
    expect(page.hash()).toBe('#divisions');

    expect(await page.click('Open the Salon tab')).toContain('Cindy, Salon, reports to Esther');
    expect(page.hash()).toBe('#divisions/salon');
  });

  it('styles its buttons with a class of their own: the page subtitle is `sub`, and a button must not look like it', async () => {
    const classes = (await drawPage('divisions', payload())).buttonClasses();
    expect(classes.length).toBeGreaterThan(4);
    expect(new Set(classes)).toEqual(new Set(['subtab']));
  });

  it('does not ask the server again when a tab is pressed: it draws from what it has', async () => {
    const page = await drawPage('divisions', payload());
    await page.click('Online');
    await page.click('Salon');
    expect(page.fetched).toEqual(['/api/divisions']);
  });

  it('falls back to the company view for a tab it does not know', async () => {
    const text = (await drawPage('divisions/hq', payload())).text();
    expect(text).toContain('Weekly report for the week of Mon, Oct 26, 2026');
    expect(text).not.toContain('Goal of the week');
  });
});

describe('the Finance tab', () => {
  it('shows George\'s weekly report: the week, how it stands, the summary, the line to the CEO division', async () => {
    const text = await finance();
    for (const part of [
      'Weekly report', 'Week of Mon, Oct 26, 2026', 'needs a decision', 'Money is healthy: the online store made $112,400',
      'Line to the CEO division: Finance is healthy; Meta ads should be cut back.', 'Source: fortune_demo_marts#cccccccccccc, as of 2026-10-26',
    ]) expect(text).toContain(part);
  });

  it('shows the goal of the week and the three paths, each with its arithmetic, test, stop-loss and risks', async () => {
    const text = await finance();
    for (const part of [
      'Goal of the week', 'Lift online contribution by $2,700 this week',
      'Online contribution after ads, fees and shipping: from $21,300 to $24,000 by Sun, Nov 1, 2026',
      'Moving the Meta dollars to Google and keeping Amazon in stock protects profit without adding spend.',
      'Three paths to the goal',
      'Path 1. Move a quarter of the Meta budget to Google', 'Path 2. Restock the Amazon item that is out', 'Path 3. Send one campaign to engaged online customers',
      'Cut the Meta budget by a quarter for seven days',
      'Google ad return (revenue / spend)', '3.1x', 'm:online.ads.google.roas',
      'Meta spend after cutting a quarter: $4,100 x 0.75 = $3,075', 'Assumption: A quarter of the Meta spend moves to Google',
      'Test: Run seven days and compare contribution with the week before.', 'Stop-loss: Stop if the Google return falls below 2.5x.',
      'Risks: A higher Google spend may return less per dollar',
    ]) expect(text).toContain(part);
  });

  it('says where each path stands: a code waiting, the one the head approved, the others not approved', async () => {
    const waiting = (await drawPage('divisions/finance', payload(withReports('finance', { approval: { status: 'pending', expires_at: '2026-10-28T00:00:00Z', decided_at: null } })))).text();
    expect(waiting).toContain('waiting for a code');
    expect(waiting).toMatch(/A code is waiting\. It expires/);
    const used = { status: 'signed', expires_at: '2026-10-28T00:00:00Z', decided_at: '2026-10-27T12:40:00Z' };
    const decided = (await drawPage('divisions/finance', payload(withReports('finance', { approval: used, decisions: [approved(2)] })))).text();
    expect(decided).toContain('Where it stands: path 2 approved.');
    expect(decided).toMatch(/Approved /);
    expect(decided).toContain('not approved');
    const none = (await drawPage('divisions/finance', payload())).text();
    expect(none).toContain('no code sent');
    expect(none).toContain('Where it stands: no code has been sent for this report yet.');
  });

  it('says a report that was not sent yet has no code to approve against', async () => {
    const text = (await drawPage('divisions/finance', payload(withReports('finance', { weekly: weeklyRow('finance', weeklyReport('finance'), { message_id: null }) })))).text();
    expect(text).toContain('Where it stands: this report has not been sent to the head yet, so there is no code to approve against.');
  });

  it('shows what was asked of the other divisions, with the answer or that there was none', async () => {
    const text = await finance();
    expect(text).toContain('Asked of other divisions');
    expect(text).toContain('To Online: Which products earn the most profit, and which lose money on a sale?');
    expect(text).toContain('2 products were sold at a loss this month; the rest earned a profit.');
    const online = (await drawPage('divisions/online', payload())).text();
    expect(online).toContain('To Finance: How much stock does Amazon hold of our best sellers?');
    expect(online).toContain('No answer. Finance could not answer this week: the stock read was unavailable.');
    const salon = (await drawPage('divisions/salon', payload())).text();
    expect(salon).not.toContain('Asked of other divisions');
  });

  it('shows what each worker found, with the numbers it rests on', async () => {
    const text = await finance();
    expect(text).toContain('What each worker found');
    expect(text).toContain('Google Ads returns 3.1x, with $2,300 of budget left');
    expect(text).toContain('$9,200');
  });

  it('links the weekly report to its PDF, and each worker report to its own', async () => {
    const page = await drawPage('divisions/finance', payload());
    const links = page.links();
    expect(links.find((l) => l.text === 'Open the PDF packet')).toEqual({ text: 'Open the PDF packet', href: `/report/weekly/${weeklyRowId('finance')}.pdf` });
    const worker = links.find((l) => l.href === `/report/worker/${workerRowId('finance.meta', '2026-10-27')}.pdf`);
    expect(worker?.text).toBe('Open this report as a PDF');
    expect(links.filter((l) => l.text === 'Open this report as a PDF')).toHaveLength(7);
    expect(links.every((l) => /^\/report\/(weekly|worker)\/[0-9a-f-]{36}\.pdf$|^\/\?division=/.test(l.href))).toBe(true);
  });

  it('draws no PDF link for a report whose id is not an id', async () => {
    const odd = withReports('finance', { weekly: weeklyRow('finance', weeklyReport('finance'), { id: 'abc' }) });
    const links = (await drawPage('divisions/finance', payload(odd))).links();
    expect(links.some((l) => l.text === 'Open the PDF packet')).toBe(false);
  });
});

describe('the workers on a division\'s tab', () => {
  it('draws every worker with its status and headline, and opens the ones that need a look', async () => {
    const text = await finance();
    expect(text).toContain('Daily workers');
    for (const label of ['Email', 'Google Ads', 'Meta ads', 'Amazon', 'Walmart', 'Online store money', 'Salon money']) expect(text).toContain(label);
    expect(text).toContain('Email earned $25,300 so far this month, most of it from flows');
    expect(text).toContain('Meta ads return 1.4x, below the level that pays for them');
    expect(text).toContain('7 workers read their part of the division\'s numbers each morning at 7:00. George writes the weekly report for Alan on Mondays at 7:30 from what they found.');
  });

  it('draws a worker\'s findings with what they cite, the rules that fired, the key numbers by unit and the data source', async () => {
    const text = await finance();
    for (const part of [
      '$9,200 of spend brought $28,520 of revenue, a return of 3.1x.', 'Based on m:online.ads.google.spend, m:online.ads.google.revenue, m:online.ads.google.roas',
      'Worth a look: The Google budget is mostly spent (m:online.budget.google.used)',
      'Key numbers', 'Google ad spend', '$9,200', 'Share of the approved Google ad budget spent', '80%', 'm:online.budget.google.used',
      'Row totals: budget room', 'room', '$2,300',
      'Report for Tue, Oct 27, 2026', 'numbers from 2026-10-mtd',
    ]) expect(text).toContain(part);
    expect(text).toContain('Needs action: Meta ads return less than they cost to be worth keeping (m:online.ads.meta.roas)');
  });

  it('draws the last seven days of a worker, newest first, with each day\'s status', async () => {
    const w = 'finance.email' as const;
    const rows = [workerRow(w, '2026-10-27'), workerRow(w, '2026-10-26', workerReport(w, { day: '2026-10-26', headline: 'Yesterday email was steady' })), workerRow(w, '2026-10-25', workerReport(w, { day: '2026-10-25', status: 'act', headline: 'Sunday email had a problem' }))];
    const text = (await drawPage('divisions/finance', payload(withReports('finance', { workerReports: rows })))).text();
    expect(text).toContain('Last seven days');
    expect(text.indexOf('Yesterday email was steady')).toBeGreaterThan(-1);
    expect(text.indexOf('Sunday email had a problem')).toBeGreaterThan(text.indexOf('Yesterday email was steady'));
    expect(text).toContain('Sun, Oct 25, 2026');
  });

  it('says a worker has no report yet, has an old one, cannot be read, or was not read', async () => {
    const w = 'finance.email' as const;
    const none = (await drawPage('divisions/finance', payload(withReports('finance', { workerReports: [workerRow(w)] })))).text();
    expect(none).toContain('No report yet. This worker reports each morning at 7:00.');

    const old = (await drawPage('divisions/finance', payload(withReports('finance', { workerReports: [workerRow(w, '2026-10-15')] })))).text();
    expect(old).toContain('older than seven days');

    const bad = (await drawPage('divisions/finance', payload(withReports('finance', { workerReports: [workerRow(w, '2026-10-27', { headline: 'x' })] })))).text();
    expect(bad).toContain('Its latest report could not be read in full. See the notes above.');
    expect(bad).toContain('Some worker reports could not be read in full');

    const unread = (await drawPage('divisions/finance', payload(withReports('finance', { workerReports: [], unread: ['workers'] })))).text();
    expect(unread).toContain('Its reports could not be read right now. See the notes above.');
  });

  it('says there is no weekly report yet, and when it could not be read', async () => {
    const none = (await drawPage('divisions/finance', payload(withReports('finance', { weekly: null })))).text();
    expect(none).toContain('No weekly report yet. It is written on Mondays at 7:30, or when the owner or the head texts REPORT.');
    const unread = (await drawPage('divisions/finance', payload(withReports('finance', { weekly: null, unread: ['weekly'] })))).text();
    expect(unread).toContain('The latest weekly report could not be read right now. See the notes above.');
    const wrong = (await drawPage('divisions/finance', payload(withReports('finance', { weekly: weeklyRow('finance', { summary: 'x' }) })))).text();
    expect(wrong).toContain('The latest weekly report could not be read right now. See the notes above.');
    expect(wrong).toContain('A weekly report could not be read in full');
  });

  it('shows a report the program wrote from the rules as that', async () => {
    const byRule = weeklyReport('finance', { writtenBy: 'rule', goal: null, paths: null });
    const text = (await drawPage('divisions/finance', payload(withReports('finance', { weekly: weeklyRow('finance', byRule, { written_by: 'rule' }) })))).text();
    expect(text).toContain('written by rules');
    expect(text).not.toContain('Goal of the week');
    expect(text).toContain('A program wrote this report from the rules, because the model\'s words did not pass their number check, so it has no goal and no paths.');
  });
});

describe('the Online and Salon tabs', () => {
  it('shows Georgette\'s actions for Emma, with the numbers each rests on and no goal', async () => {
    const text = (await drawPage('divisions/online', payload())).text();
    for (const part of [
      'Georgette, Online, reports to Emma', 'Actions for Emma', 'Action 1. Answer the 6 waiting messages today', 'Action 2. Fix the broken link on the site',
      'Six customers have waited for a first reply and the oldest has waited 31 hours.', 'Messages still waiting for a first reply', 'm:online.service.waiting.count',
      'Daily workers', 'Messages', 'Store journey', 'Returns and reviews', 'Site and blog',
    ]) expect(text).toContain(part);
    expect(text).not.toContain('Goal of the week');
    expect(text).not.toContain('Three paths to the goal');
  });

  it('shows Cindy\'s one action for Esther', async () => {
    const text = (await drawPage('divisions/salon', payload())).text();
    expect(text).toContain('Cindy, Salon, reports to Esther');
    expect(text).toContain('Actions for Esther');
    expect(text).toContain('Action 1. Finish the 3 personalization pieces that are over three weeks');
    expect(text).toContain('Repairs and personalization');
  });

  it('keeps the daily brief and the questions on the tab', async () => {
    const text = (await drawPage('divisions/online', payload())).text();
    expect(text).toContain('Daily brief');
    expect(text).toContain('No brief yet. It is written each morning');
    expect(text).toContain('Questions it asked');
    expect(text).toContain('Questions it was asked');
  });
});

describe('a head\'s own page', () => {
  const head = (division: BriefDivision, over?: RawDivisions) => drawPage('divisions', payload(over ?? raw(), division), { search: `?division=${division}`, noTabs: true });

  it('asks the server for its division only, and draws that division without any tab to the others', async () => {
    const page = await head('finance');
    expect(page.fetched).toEqual(['/api/divisions?division=finance']);
    const text = page.text();
    expect(text).toContain('George, Finance, reports to Alan');
    expect(text).toContain('Goal of the week');
    expect(page.buttons()).toEqual([]);
    expect(text).not.toMatch(/Cindy|Georgette|CEO digest|Company/);
  });

  it('puts the division\'s id on every PDF link, so the server refuses any other division\'s report', async () => {
    const links = (await head('online')).links();
    const pdfs = links.filter((l) => l.href.startsWith('/report/'));
    expect(pdfs.length).toBeGreaterThan(5);
    expect(pdfs.every((l) => l.href.endsWith('.pdf?division=online'))).toBe(true);
    expect(links.some((l) => l.href.startsWith('/?division='))).toBe(false);
  });

  it('is the same for each of the three heads', async () => {
    expect((await head('salon')).text()).toContain('Cindy, Salon, reports to Esther');
    expect((await head('online')).text()).toContain('Georgette, Online, reports to Emma');
  });

  it('does not take a division from the address that is not one of the three: it draws the owner\'s view', async () => {
    const page = await drawPage('divisions', payload(), { search: '?division=hq', noTabs: false });
    expect(page.fetched).toEqual(['/api/divisions']);
  });
});

describe('the page stays text, and under the same policy', () => {
  it('draws markup in a report as text, never as markup', async () => {
    const hostile = workerReport('finance.meta', { headline: '<img src=x onerror=alert(1)> Meta is fine', findings: [{ text: '<script>alert(2)</script>', cites: ['m:online.ads.meta.roas'] }] });
    const text = (await drawPage('divisions/finance', payload(withReports('finance', { workerReports: [workerRow('finance.meta', '2026-10-27', hostile)] })))).text();
    expect(text).toContain('<img src=x onerror=alert(1)> Meta is fine');
    expect(text).toContain('<script>alert(2)</script>');
    const script = /<script>([\s\S]*?)<\/script>/.exec(PAGE_HTML)?.[1] ?? '';
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  });

  it('draws no phone number, code or key even when a report held one', async () => {
    const dirty = workerReport('finance.meta', { headline: 'Call +15559876543 about code 482915' });
    const text = (await drawPage('divisions/finance', payload(withReports('finance', { workerReports: [workerRow('finance.meta', '2026-10-27', dirty)] })))).text();
    expect(text).not.toMatch(/5559876543|482915/);
    expect(text).toContain('Call …6543 about code ••••••');
  });

  it('keeps one script and one style block, allowed by hash, with no new place to connect to', () => {
    expect(PAGE_CSP).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(PAGE_CSP).toContain("connect-src 'self'");
    expect(PAGE_CSP).toContain("form-action 'none'");
    expect(PAGE_HTML.match(/<script/g)).toHaveLength(1);
    expect(PAGE_HTML.match(/<style>/g)).toHaveLength(1);
  });
});
