import { describe, expect, it } from 'vitest';
import type { BriefDivision, DivisionsView, RawDivisionReports, RawDivisions } from '../src/divisions.ts';
import { shapeDivisions } from '../src/shape.ts';
import {
  approved, everything, NOW, noteId, raw, reportsOf, state, weeklyReport, weeklyRow, weeklyRowId, workerReport, workerRow, workerRowId, WORKERS_OF,
} from './reports-fixtures.ts';

// Wave 2 in the console: what the Divisions view shows of each division's manager, its workers' reports and its weekly report.
// Shaping only: no network, no database. The rows are the ones the worker writes, built from the delivery tests' synthetic reports.

const PHONE_LIKE = /\+?1?[\s.(-]*\d{3}[\s.)-]*\d{3}[\s.-]*\d{4}/;
const view = (r: RawDivisions, only?: BriefDivision): DivisionsView => shapeDivisions(r, NOW, only);
const div = (v: DivisionsView, id: BriefDivision) => v.divisions.find((d) => d.id === id)!;
const withReports = (division: BriefDivision, over: Partial<RawDivisionReports>) =>
  raw({ divisions: [state('salon'), state('finance'), state('online')].map((s) => (s.division === division ? state(division, { reports: reportsOf(division, over) }) : s)) });
const slot = (v: DivisionsView, division: BriefDivision, worker: string) => div(v, division).reports.workers.find((w) => w.workerId === worker)!;

describe('the Divisions view: each division\'s manager', () => {
  it('names the manager, the division and the head the manager reports to', () => {
    const v = view(raw());
    expect(div(v, 'finance').manager).toEqual({ name: 'George', title: 'Finance', reportsTo: 'Alan' });
    expect(div(v, 'online').manager).toEqual({ name: 'Georgette', title: 'Online', reportsTo: 'Emma' });
    expect(div(v, 'salon').manager).toEqual({ name: 'Cindy', title: 'Salon', reportsTo: 'Esther' });
  });

  it('keeps what the view had before, and adds only the manager and the reports to a division', () => {
    const v = view(raw());
    expect(Object.keys(v).sort()).toEqual(['digest', 'divisions', 'generatedAt', 'notes', 'unread']);
    expect(Object.keys(div(v, 'finance')).sort()).toEqual(['asked', 'brief', 'head', 'id', 'manager', 'name', 'received', 'reports', 'unread']);
    expect(Object.keys(div(v, 'finance').reports).sort()).toEqual(['unread', 'weekly', 'workers']);
  });
});

describe('the Divisions view: the workers', () => {
  it('lists every worker of the division in the registry\'s order, each with its latest report', () => {
    const v = view(raw());
    expect(div(v, 'finance').reports.workers.map((w) => [w.workerId, w.label, w.state])).toEqual([
      ['finance.email', 'Email', 'ok'], ['finance.google_ads', 'Google Ads', 'ok'], ['finance.meta', 'Meta ads', 'ok'], ['finance.amazon', 'Amazon', 'ok'],
      ['finance.walmart', 'Walmart', 'ok'], ['finance.online_money', 'Online store money', 'ok'], ['finance.salon_money', 'Salon money', 'ok'],
    ]);
    expect(div(v, 'online').reports.workers.map((w) => w.workerId)).toEqual(WORKERS_OF.online);
    expect(div(v, 'salon').reports.workers.map((w) => w.workerId)).toEqual(WORKERS_OF.salon);
  });

  it('shows a report\'s status, headline, findings with what they cite, and the rules that fired', () => {
    const w = slot(view(raw()), 'finance', 'finance.google_ads').latest!;
    expect(w).toMatchObject({
      id: workerRowId('finance.google_ads', '2026-10-27'), day: '2026-10-27', period: '2026-10-mtd', status: 'watch', writtenBy: 'model',
      headline: 'Google Ads returns 3.1x, with $2,300 of budget left', createdAt: '2026-10-27T11:00:07.000Z',
    });
    expect(w.findings).toEqual([
      { text: '$9,200 of spend brought $28,520 of revenue, a return of 3.1x.', cites: ['m:online.ads.google.spend', 'm:online.ads.google.revenue', 'm:online.ads.google.roas'] },
      { text: '80% of the approved Google budget is used.', cites: ['m:online.budget.google.used'] },
    ]);
    expect(w.rules).toEqual([{ level: 'watch', rule: 'The Google budget is mostly spent', metricId: 'm:online.budget.google.used' }]);
  });

  it('shows the key numbers written by their unit, the ones the words lean on first, each with its metric id', () => {
    const w = slot(view(raw()), 'finance', 'finance.google_ads').latest!;
    expect(w.numbers).toEqual([
      { id: 'm:online.ads.google.spend', label: 'Google ad spend', shown: '$9,200' },
      { id: 'm:online.ads.google.revenue', label: 'Google ad revenue', shown: '$28,520' },
      { id: 'm:online.ads.google.roas', label: 'Google ad return (revenue / spend)', shown: '3.1x' },
      { id: 'm:online.budget.google.used', label: 'Share of the approved Google ad budget spent', shown: '80%' },
    ]);
    expect(w.moreNumbers).toBe(0);
    const email = slot(view(raw()), 'finance', 'finance.email').latest!;
    expect(email.numbers.map((n) => n.shown)).toEqual(['$18,400', '$6,900', '0.3%', '61,200', '24,500']);
  });

  it('shows the row totals the port added up, and the data source with its date', () => {
    const w = slot(view(raw()), 'finance', 'finance.google_ads').latest!;
    expect(w.rows).toEqual([{ read: 'budget room', totals: [{ label: 'room', shown: '$2,300' }] }]);
    expect(w.source).toBe('fortune_demo_marts#cccccccccccc, as of 2026-10-26');
  });

  it('lists the last seven company days, newest first, one report a day (the newest of a day), and none older', () => {
    const w = 'finance.email' as const;
    const rows = [
      workerRow(w, '2026-10-27'),
      workerRow(w, '2026-10-26'),
      workerRow(w, '2026-10-26', workerReport(w, { day: '2026-10-26', headline: 'A later run by hand the same day' }), { id: 'd3d3d3d3-0000-4000-8000-aaaaaaaaaaa1', created_at: '2026-10-26T15:00:00.000Z' }),
      workerRow(w, '2026-10-25', workerReport(w, { day: '2026-10-25', status: 'act' })),
      workerRow(w, '2026-10-21'),
      workerRow(w, '2026-10-20'), // eight days back: outside the week
    ];
    const s = slot(view(withReports('finance', { workerReports: rows })), 'finance', w);
    expect(s.week.map((d) => [d.day, d.status])).toEqual([['2026-10-27', 'normal'], ['2026-10-26', 'normal'], ['2026-10-25', 'act'], ['2026-10-21', 'normal']]);
    expect(s.week.find((d) => d.day === '2026-10-26')!.headline).toBe('A later run by hand the same day');
    expect(s.latest!.day).toBe('2026-10-27');
    expect(s.stale).toBe(false);
  });

  it('counts the week in New York days: at 00:30 New York time on the 28th, the 22nd is the first day', () => {
    const w = 'finance.email' as const;
    const rows = [workerRow(w, '2026-10-28'), workerRow(w, '2026-10-22'), workerRow(w, '2026-10-21')];
    const v = shapeDivisions(withReports('finance', { workerReports: rows }), new Date('2026-10-28T04:30:00.000Z'));
    expect(slot(v, 'finance', w).week.map((d) => d.day)).toEqual(['2026-10-28', '2026-10-22']);
  });

  it('shows the latest report of a worker that is older than seven days, marked as old, with no days in the week', () => {
    const w = 'finance.email' as const;
    const s = slot(view(withReports('finance', { workerReports: [workerRow(w, '2026-10-15')] })), 'finance', w);
    expect(s).toMatchObject({ state: 'ok', stale: true, week: [] });
    expect(s.latest!.day).toBe('2026-10-15');
  });

  it('says a worker has not reported yet, rather than leaving it out', () => {
    const v = view(withReports('finance', { workerReports: [workerRow('finance.email')] }));
    expect(slot(v, 'finance', 'finance.meta')).toMatchObject({ state: 'none', latest: null, stale: false, week: [] });
    expect(div(v, 'finance').reports.workers).toHaveLength(7);
    expect(v.notes).toEqual([]);
  });

  it('says a report in the wrong shape is unreadable, with a note, and keeps the others', () => {
    const broken = workerRow('finance.meta', '2026-10-27', { headline: 'No findings, no numbers' });
    const v = view(withReports('finance', { workerReports: [workerRow('finance.email'), broken] }));
    expect(slot(v, 'finance', 'finance.meta')).toMatchObject({ state: 'unreadable', latest: null });
    expect(slot(v, 'finance', 'finance.email').state).toBe('ok');
    expect(v.notes).toEqual(['Some worker reports could not be read in full (unexpected shape). They are shown as unreadable.']);
  });

  it('does not trust a row whose report belongs to another worker', () => {
    const swapped = workerRow('finance.meta', '2026-10-27', workerReport('finance.email'));
    const v = view(withReports('finance', { workerReports: [swapped] }));
    expect(slot(v, 'finance', 'finance.meta')).toMatchObject({ state: 'unreadable', latest: null });
    expect(slot(v, 'finance', 'finance.email').state).toBe('none');
  });

  it('leaves out a row of another division or of a worker that does not exist', () => {
    const rows = [workerRow('online.messages'), workerRow('finance.email'), workerRow('finance.email', '2026-10-27', workerReport('finance.email'), { worker_id: 'finance.invented' })];
    const v = view(withReports('finance', { workerReports: rows }));
    expect(div(v, 'finance').reports.workers.map((w) => w.workerId)).toEqual(WORKERS_OF.finance);
    expect(slot(v, 'finance', 'finance.email').week).toHaveLength(1);
  });

  it('says the workers could not be read, for every worker, when the source could not read them', () => {
    const v = view(withReports('finance', { workerReports: [], unread: ['workers'] }));
    expect(div(v, 'finance').reports.workers.map((w) => w.state)).toEqual(Array(7).fill('unread'));
    expect(div(v, 'finance').reports.unread).toEqual(['workers']);
  });

  it('shows a division the source sent no reports for as unread, never as "nothing yet"', () => {
    const v = view(raw({ divisions: [state('salon', { reports: undefined }), state('finance'), state('online')] }));
    expect(div(v, 'salon').reports).toMatchObject({ weekly: null, unread: ['workers', 'weekly'] });
    expect(div(v, 'salon').reports.workers.map((w) => w.state)).toEqual(['unread', 'unread', 'unread']);
    expect(div(v, 'finance').reports.unread).toEqual([]);
  });

  it('shows a rule-written report as written by rules, and an id that is not an id as no link', () => {
    const w = 'finance.meta' as const;
    const rows = [workerRow(w, '2026-10-27', workerReport(w, { writtenBy: 'rule' }), { id: 'not-an-id' })];
    const s = slot(view(withReports('finance', { workerReports: rows })), 'finance', w).latest!;
    expect(s).toMatchObject({ writtenBy: 'rule', id: null, status: 'act' });
  });
});

describe('the Divisions view: the weekly report', () => {
  it('shows the latest weekly report: the week, the status, the summary, the line to the CEO division', () => {
    const wk = div(view(raw()), 'finance').reports.weekly!;
    expect(wk).toMatchObject({
      id: weeklyRowId('finance'), weekOf: '2026-10-26', createdAt: '2026-10-26T11:30:12.000Z', period: '2026-10-mtd', status: 'act', writtenBy: 'model',
      ceoLine: 'Finance is healthy; Meta ads should be cut back.', sent: true,
    });
    expect(wk.summary).toMatch(/^Money is healthy: the online store made \$112,400/);
    expect(wk.source).toBe('fortune_demo_marts#cccccccccccc, as of 2026-10-26');
  });

  it('shows one section for each worker with its status, its words and the numbers it cites', () => {
    const wk = div(view(raw()), 'finance').reports.weekly!;
    expect(wk.sections.map((s) => [s.workerId, s.label, s.status])).toEqual([
      ['finance.email', 'Email', 'normal'], ['finance.google_ads', 'Google Ads', 'watch'], ['finance.meta', 'Meta ads', 'act'], ['finance.amazon', 'Amazon', 'act'],
      ['finance.walmart', 'Walmart', 'watch'], ['finance.online_money', 'Online store money', 'watch'], ['finance.salon_money', 'Salon money', 'normal'],
    ]);
    expect(wk.sections[0]).toMatchObject({ summary: 'Email earned $25,300 so far this month, most of it from flows' });
    expect(wk.sections[0]!.numbers).toEqual([
      { id: 'm:online.email.flow.revenue', label: 'Revenue from flow emails', shown: '$18,400' },
      { id: 'm:online.email.campaign.revenue', label: 'Revenue from campaign emails', shown: '$6,900' },
      { id: 'm:online.email.unsubscribe_rate', label: 'Unsubscribes over sends', shown: '0.3%' },
    ]);
  });

  it('shows what was asked of the other divisions, and the answer or that there was none', () => {
    const asked = div(view(raw()), 'online').reports.weekly!.asked;
    expect(asked).toEqual([{ division: 'finance', question: 'How much stock does Amazon hold of our best sellers?', answer: 'Finance could not answer this week: the stock read was unavailable.', ok: false }]);
    expect(div(view(raw()), 'finance').reports.weekly!.asked.map((a) => [a.division, a.ok])).toEqual([['online', true], ['salon', true]]);
    expect(div(view(raw()), 'salon').reports.weekly!.asked).toEqual([]);
  });

  it('shows George\'s goal of the week, written by the unit of its metric', () => {
    const wk = div(view(raw()), 'finance').reports.weekly!;
    expect(wk.goal).toEqual({
      title: 'Lift online contribution by $2,700 this week', metric: 'Online contribution after ads, fees and shipping', from: '$21,300', to: '$24,000',
      by: 'Sun, Nov 1, 2026', why: 'Moving the Meta dollars to Google and keeping Amazon in stock protects profit without adding spend.',
    });
    expect(div(view(raw()), 'online').reports.weekly!.goal).toBeNull();
  });

  it('shows his three paths with what to do, the numbers behind each, the arithmetic, the test, the stop-loss and the risks', () => {
    const paths = div(view(raw()), 'finance').reports.weekly!.options;
    expect(paths.map((p) => [p.kind, p.rank, p.title])).toEqual([
      ['path', 1, 'Move a quarter of the Meta budget to Google'], ['path', 2, 'Restock the Amazon item that is out'], ['path', 3, 'Send one campaign to engaged online customers'],
    ]);
    expect(paths[0]).toMatchObject({
      why: expect.stringMatching(/^Google returns 3\.1x and Meta 1\.4x/),
      steps: ['Cut the Meta budget by a quarter for seven days', 'Add the same dollars to the Google budget'],
      numbers: [
        { id: 'm:online.ads.google.roas', label: 'Google ad return (revenue / spend)', shown: '3.1x' },
        { id: 'm:online.ads.meta.roas', label: 'Meta ad return (revenue / spend)', shown: '1.4x' },
      ],
      projections: [{ text: 'Meta spend after cutting a quarter: $4,100 x 0.75 = $3,075', assumption: 'A quarter of the Meta spend moves to Google' }],
      test: 'Run seven days and compare contribution with the week before.',
      stopLoss: 'Stop if the Google return falls below 2.5x.',
      risks: ['A higher Google spend may return less per dollar'],
    });
  });

  it('shows an online or salon report\'s actions, with the numbers each rests on', () => {
    const actions = div(view(raw()), 'online').reports.weekly!.options;
    expect(actions.map((a) => [a.kind, a.rank, a.title])).toEqual([
      ['action', 1, 'Answer the 6 waiting messages today'], ['action', 2, 'Fix the broken link on the site'], ['action', 3, 'Reorder the 3 popular products that are low'],
    ]);
    expect(actions[0]).toMatchObject({ why: expect.stringMatching(/^Six customers have waited/), steps: [expect.stringMatching(/^Emma works the oldest first/)], test: null, stopLoss: null, risks: [], projections: [] });
    expect(div(view(raw()), 'salon').reports.weekly!.options).toHaveLength(1);
  });

  it('shows a number a path cites that is not in the report\'s data by its id, with the value the path gave', () => {
    const odd = weeklyReport('finance', { metrics: weeklyReport('finance').metrics.filter((m) => m.id !== 'm:online.ads.meta.roas') });
    const paths = div(view(withReports('finance', { weekly: weeklyRow('finance', odd) })), 'finance').reports.weekly!.options;
    expect(paths[0]!.numbers[1]).toEqual({ id: 'm:online.ads.meta.roas', label: 'm:online.ads.meta.roas', shown: '1.4' });
  });

  it('shows a report the program wrote from the rules as that, with no goal and no paths for finance', () => {
    const byRule = weeklyReport('finance', { writtenBy: 'rule', goal: null, paths: null });
    const wk = div(view(withReports('finance', { weekly: weeklyRow('finance', byRule, { written_by: 'rule' }) })), 'finance').reports.weekly!;
    expect(wk).toMatchObject({ writtenBy: 'rule', goal: null, options: [] });
  });

  it('says there is no weekly report yet, and says when it could not be read', () => {
    const none = div(view(withReports('finance', { weekly: null })), 'finance').reports;
    expect(none).toMatchObject({ weekly: null, unread: [] });
    const unread = div(view(withReports('finance', { weekly: null, unread: ['weekly'] })), 'finance').reports;
    expect(unread).toMatchObject({ weekly: null, unread: ['weekly'] });
  });

  it('turns a weekly report of the wrong shape into a note and an unread part', () => {
    const v = view(withReports('finance', { weekly: weeklyRow('finance', { summary: 'Only a summary' }) }));
    expect(div(v, 'finance').reports).toMatchObject({ weekly: null, unread: ['weekly'] });
    expect(v.notes).toEqual(['A weekly report could not be read in full (unexpected shape). It is not shown.']);
  });

  it('shows no link for a weekly report whose id is not an id', () => {
    const v = view(withReports('finance', { weekly: weeklyRow('finance', weeklyReport('finance'), { id: 'abc' }) }));
    expect(div(v, 'finance').reports.weekly!.id).toBeNull();
  });
});

describe('the Divisions view: where each path or action of a weekly report stands', () => {
  const standing = (over: Partial<RawDivisionReports>, division: BriefDivision = 'finance') =>
    div(view(withReports(division, over)), division).reports.weekly!.options.map((o) => [o.approval.state, o.approval.at]);

  it('says no code was sent until the report has the note a head approves against, and that nothing was sent', () => {
    const noNote = withReports('finance', { weekly: weeklyRow('finance', weeklyReport('finance'), { message_id: null }) });
    expect(div(view(noNote), 'finance').reports.weekly!.sent).toBe(false);
    expect(standing({ weekly: weeklyRow('finance', weeklyReport('finance'), { message_id: null }) })).toEqual(Array(3).fill(['no_code', null]));
    expect(standing({})).toEqual(Array(3).fill(['no_code', null]));
  });

  it('says a code is waiting, with when it ends, until the clock passes it', () => {
    expect(standing({ approval: { status: 'pending', expires_at: '2026-10-28T00:00:00Z', decided_at: null } })).toEqual(Array(3).fill(['awaiting', '2026-10-28T00:00:00.000Z']));
    expect(standing({ approval: { status: 'pending', expires_at: '2026-10-27T13:00:00Z', decided_at: null } })).toEqual(Array(3).fill(['code_expired', '2026-10-27T13:00:00.000Z']));
  });

  it('marks the path the head approved, and the others as not approved once the code was used', () => {
    const used = { status: 'signed', expires_at: '2026-10-28T00:00:00Z', decided_at: '2026-10-27T12:40:00Z' };
    expect(standing({ approval: used, decisions: [approved(2)] })).toEqual([['not_approved', '2026-10-27T12:40:00.000Z'], ['approved', '2026-10-27T12:40:00.000Z'], ['not_approved', '2026-10-27T12:40:00.000Z']]);
    expect(standing({ approval: used, decisions: [approved(1), approved(3, '2026-10-27T12:41:00.000Z')] }, 'online').map((x) => x[0])).toEqual(['approved', 'not_approved', 'approved']);
  });

  it('counts only an approved verdict and a rank the report has', () => {
    const declined = { ...approved(1), body: { ...approved(1).body, verdict: 'declined' } };
    expect(standing({ approval: { status: 'expired', expires_at: '2026-10-27T10:00:00Z', decided_at: null }, decisions: [declined, approved(9), approved(0)] }).map((x) => x[0])).toEqual(Array(3).fill('code_expired'));
  });

  it('says it cannot tell when the approvals could not be read, but shows what it did read as approved', () => {
    expect(standing({ unread: ['approvals'], decisions: [approved(3)] }).map((x) => x[0])).toEqual(['unknown', 'unknown', 'approved']);
  });

  it('never reads who approved: no person id, code hash or note id leaves', () => {
    const v = view(withReports('finance', {
      approval: { status: 'signed', expires_at: '2026-10-28T00:00:00Z', decided_at: '2026-10-27T12:40:00Z', code_hash: 'a'.repeat(64), message_id: noteId('finance') } as never,
      decisions: [approved(1)],
    }));
    expect(everything(v)).not.toMatch(/demo-p-|a{40}|code_hash/);
    expect(everything(v)).not.toContain(noteId('finance'));
  });
});

describe('the Divisions view: scrubbing and limits for the reports', () => {
  it('lets no phone number, code, key or hash out in any text of a report, and never the row\'s own bookkeeping', () => {
    const dirty = workerReport('finance.meta', {
      headline: 'Call +15559876543 about code 482915 and key sb_secret_abc123',
      findings: [{ text: 'Reach 555-123-4567 with code 99887766', cites: ['m:online.ads.meta.roas'] }],
      attention: [{ metricId: 'm:online.ads.meta.roas', level: 'act', rule: 'Ring (555) 987-6543 now' }],
      dataSource: 'fortune_demo_marts#cccccccccccc',
    });
    const v = view(withReports('finance', { workerReports: [workerRow('finance.meta', '2026-10-27', dirty, { status: 'normal' })] }));
    const text = everything(v);
    expect(text).not.toMatch(/\d{6}/);
    expect(text).not.toMatch(PHONE_LIKE);
    expect(text).not.toMatch(/sb_secret|service_role|code_hash|eyJ/);
    expect(text).not.toContain('task_id');
    // The status comes from the report itself, not from a column that could disagree with it.
    expect(slot(v, 'finance', 'finance.meta').latest!.status).toBe('act');
  });

  it('cuts every list to its limit', () => {
    const long = workerReport('finance.email', {
      findings: Array.from({ length: 5 }, (_, i) => ({ text: `Finding ${i + 1}`, cites: ['m:online.email.flow.revenue'] })),
    });
    const w = slot(view(withReports('finance', { workerReports: [workerRow('finance.email', '2026-10-27', long)] })), 'finance', 'finance.email').latest!;
    expect(w.findings).toHaveLength(5);
    expect(w.numbers.length).toBeLessThanOrEqual(12);
    const days = Array.from({ length: 12 }, (_, i) => workerRow('finance.email', `2026-10-${27 - i}`, workerReport('finance.email', { day: `2026-10-${27 - i}` })));
    const week = slot(view(withReports('finance', { workerReports: days })), 'finance', 'finance.email').week;
    expect(week.map((d) => d.day)).toEqual(['2026-10-27', '2026-10-26', '2026-10-25', '2026-10-24', '2026-10-23', '2026-10-22', '2026-10-21']);
  });

  it('survives a source that sends lists of the wrong kind', () => {
    const bad = { workerReports: 'nope', weekly: 42, approval: 'x', decisions: {}, unread: 'y' } as never;
    const v = view(raw({ divisions: [state('salon', { reports: bad }), state('finance'), state('online')] }));
    expect(div(v, 'salon').reports.workers.map((w) => w.state)).toEqual(['none', 'none', 'none']);
    expect(div(v, 'salon').reports.weekly).toBeNull();
  });
});

describe('a head\'s own view', () => {
  const everyone = raw({
    requests: [
      { id: 'r1', from_assistant: 'finance', to_assistant: 'online', created_at: '2026-10-27T12:00:30Z', body: { type: 'data_request', question: 'What did Mazali bring in?' } },
      { id: 'r2', from_assistant: 'salon', to_assistant: 'online', created_at: '2026-10-27T12:01:30Z', body: { type: 'data_request', question: 'How long do returns take?' } },
    ],
    replies: [{ reply_to: 'r1', created_at: '2026-10-27T12:00:50Z', ok: 'true', reason: null }],
    digest: { created_at: '2026-10-27T12:30:05Z', body: { type: 'ceo_digest', date: '2026-10-27', text: 'Company status: Salon is steady.', reports: [] } },
    notes: ['The Salon worker reports could not be read right now (57014).', 'The Finance weekly report could not be read right now (57014).', 'The data requests could not be read right now.'],
    unread: ['digest'],
  });

  it('shows one division only, with the report of that division and nothing of the others', () => {
    const v = view(everyone, 'finance');
    expect(v.only).toBe('finance');
    expect(v.divisions.map((d) => d.id)).toEqual(['finance']);
    expect(div(v, 'finance').reports.weekly).not.toBeNull();
    expect(everything(v)).not.toMatch(/Cindy|Georgette|Esther|Emma/);
    expect(everything(v)).not.toContain('Company status');
  });

  it('has no CEO digest: it is the owner\'s', () => {
    const v = view(everyone, 'finance');
    expect(v.digest).toBeNull();
    expect(v.unread).toEqual([]);
  });

  it('shows only the questions this division asked or was asked', () => {
    const v = view(everyone, 'salon');
    expect(div(v, 'salon').asked.map((q) => q.question)).toEqual(['How long do returns take?']);
    expect(div(v, 'salon').received).toEqual([]);
    expect(everything(v)).not.toContain('What did Mazali bring in');
  });

  it('leaves out the notes about other divisions\' parts and keeps its own', () => {
    expect(view(everyone, 'finance').notes).toEqual(['The Finance weekly report could not be read right now (57014).', 'The data requests could not be read right now.']);
    expect(view(everyone, 'salon').notes).toEqual(['The Salon worker reports could not be read right now (57014).', 'The data requests could not be read right now.']);
  });

  it('is the whole company, with no `only`, when no division is asked for', () => {
    const v = view(everyone);
    expect(v.only).toBeUndefined();
    expect(v.divisions).toHaveLength(3);
    expect(v.digest).not.toBeNull();
  });
});
