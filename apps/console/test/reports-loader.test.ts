import { describe, expect, it } from 'vitest';
import type { Call } from './recorder.ts';
import { recorder } from './recorder.ts';
import { createDivisionsLoader, createReportLoader } from '../src/loader.ts';
import { shapeDivisions } from '../src/shape.ts';
import { approved, NOW, noteId, weeklyReport, weeklyRow, weeklyRowId, workerReport, workerRow, workerRowId, WORKERS_OF } from './reports-fixtures.ts';

// The wave-2 reads against a recording fake of the database: which tables, which named columns, which filters and limits,
// and what happens when a read fails. (reports-db.test.ts runs the same reads against the real local database.)

const WORKER_COLUMNS = 'id,worker_id,division,report_date,status,written_by,report,created_at';
const WEEKLY_COLUMNS = 'id,division,week_of,status,written_by,report,ceo_line,message_id,created_at';
const NOT_SAFE = /\*|code_hash|decided_by|payload|phone|idempotency|lease|task_id|data_source/;
const op = (call: Call, name: string) => call.ops.find((x) => x.startsWith(`${name}(`));
const divisionOf = (call: Call) => op(call, 'eq')!.match(/^eq\(division,(\w+)\)$/)?.[1];

function happy(call: Call) {
  if (call.table === 'worker_reports') {
    const division = call.ops.find((x) => /^eq\(division,/.test(x))?.slice('eq(division,'.length, -1) as 'finance' | 'online' | 'salon' | undefined;
    if (division) {
      // Finance's Meta worker has not reported this week; the others have.
      return { data: WORKERS_OF[division].filter((w) => w !== 'finance.meta').map((w) => workerRow(w)) };
    }
    const worker = call.ops.find((x) => /^eq\(worker_id,/.test(x))!.slice('eq(worker_id,'.length, -1);
    return { data: [workerRow(worker as 'finance.meta', '2026-10-15')] };
  }
  if (call.table === 'weekly_reports') {
    const division = divisionOf(call) as 'finance' | 'online' | 'salon';
    return { data: [weeklyRow(division)] };
  }
  if (call.table === 'approvals') return { data: [{ status: 'signed', expires_at: '2026-10-28T00:00:00Z', decided_at: '2026-10-27T12:40:00Z' }] };
  if (call.table === 'assistant_messages' && call.ops.includes('eq(kind,decision)')) return { data: [approved(2)] };
  return { data: [] };
}

const load = (r: ReturnType<typeof recorder>, only?: 'finance' | 'online' | 'salon') => createDivisionsLoader({ db: r.db, now: () => NOW })(only);

describe('the loader reads each division\'s worker reports and weekly report', () => {
  it('reads named columns only, the last seven days newest first, one weekly report, with small limits', async () => {
    const r = recorder(happy);
    await load(r);

    const workers = r.calls.filter((c) => c.table === 'worker_reports' && /^eq\(division,/.test(c.ops[0] ?? ''));
    expect(workers.map((c) => divisionOf(c))).toEqual(['salon', 'finance', 'online']);
    for (const c of workers) {
      expect(c.select).toBe(WORKER_COLUMNS);
      expect(c.ops).toContain('gte(report_date,2026-10-21)');
      expect(c.ops.filter((x) => x.startsWith('order('))).toEqual(['order(report_date,{"ascending":false})', 'order(created_at,{"ascending":false})']);
      expect(c.ops).toContain('limit(100)');
    }

    const weekly = r.calls.filter((c) => c.table === 'weekly_reports');
    expect(weekly.map((c) => divisionOf(c))).toEqual(['salon', 'finance', 'online']);
    for (const c of weekly) {
      expect(c.select).toBe(WEEKLY_COLUMNS);
      expect(c.ops.filter((x) => x.startsWith('order('))).toEqual(['order(week_of,{"ascending":false})', 'order(created_at,{"ascending":false})']);
      expect(c.ops).toContain('limit(1)');
    }

    // Nothing but the named columns, and nothing small-limited above a hundred.
    for (const c of r.calls) {
      expect(c.select, c.table).not.toMatch(NOT_SAFE);
      expect(Number(op(c, 'limit')?.slice(6, -1)), `${c.table} limit`).toBeLessThanOrEqual(100);
    }
  });

  it('reads the newest report of a worker that has none in the last seven days, one worker at a time', async () => {
    const r = recorder(happy);
    const loaded = await load(r);
    const single = r.calls.filter((c) => c.table === 'worker_reports' && c.ops.some((x) => /^eq\(worker_id,/.test(x)));
    expect(single.map((c) => op(c, 'eq'))).toEqual(['eq(worker_id,finance.meta)']);
    expect(single[0]!.select).toBe(WORKER_COLUMNS);
    expect(single[0]!.ops).toContain('limit(1)');
    expect(single[0]!.ops.filter((x) => x.startsWith('order('))).toEqual(['order(report_date,{"ascending":false})', 'order(created_at,{"ascending":false})']);

    const finance = loaded.divisions.find((d) => d.division === 'finance')!.reports!;
    expect(finance.workerReports).toHaveLength(7);
    const view = shapeDivisions(loaded, NOW).divisions.find((d) => d.id === 'finance')!;
    expect(view.reports.workers.find((w) => w.workerId === 'finance.meta')).toMatchObject({ state: 'ok', stale: true, week: [] });
  });

  it('reads the code and the decisions of a weekly report against its own note only', async () => {
    const r = recorder(happy);
    const loaded = await load(r);
    const approvals = r.calls.filter((c) => c.table === 'approvals');
    expect(approvals).toHaveLength(3);
    for (const c of approvals) {
      expect(c.select).toBe('status,expires_at,decided_at');
      expect(c.ops).toContain('eq(action,approve_action)');
      expect(c.ops).toContain('limit(1)');
      expect(c.ops.some((x) => x.startsWith('order(created_at'))).toBe(true);
    }
    expect(approvals.map((c) => op(c, 'eq')).sort()).toEqual([`eq(message_id,${noteId('salon')})`, `eq(message_id,${noteId('finance')})`, `eq(message_id,${noteId('online')})`].sort());

    const decisions = r.calls.filter((c) => c.table === 'assistant_messages' && c.ops.includes('eq(kind,decision)'));
    expect(decisions).toHaveLength(3);
    for (const c of decisions) {
      expect(c.select).toBe('created_at,body');
      expect(c.ops).toContain('like(dedupe_key,action-decision:%)');
      expect(c.ops.some((x) => x.startsWith('eq(reply_to,'))).toBe(true);
      expect(c.ops).toContain('limit(30)');
    }
    const finance = loaded.divisions.find((d) => d.division === 'finance')!.reports!;
    expect(finance.approval).toEqual({ status: 'signed', expires_at: '2026-10-28T00:00:00Z', decided_at: '2026-10-27T12:40:00Z' });
    expect(finance.decisions).toHaveLength(1);
    expect(shapeDivisions(loaded, NOW).divisions.find((d) => d.id === 'finance')!.reports.weekly!.options.map((o) => o.approval.state)).toEqual(['not_approved', 'approved', 'not_approved']);
  });

  it('asks nothing about approvals when the weekly report has no note to approve against, or there is no weekly report', async () => {
    const r = recorder((call) => {
      if (call.table === 'weekly_reports') return { data: divisionOf(call) === 'finance' ? [weeklyRow('finance', weeklyReport('finance'), { message_id: null })] : [] };
      return happy(call);
    });
    const loaded = await load(r);
    expect(r.calls.some((c) => c.table === 'approvals')).toBe(false);
    expect(r.calls.some((c) => c.ops.includes('eq(kind,decision)'))).toBe(false);
    expect(loaded.divisions.map((d) => [d.division, d.reports!.weekly === null, d.reports!.unread])).toEqual([['salon', true, []], ['finance', false, []], ['online', true, []]]);
  });

  it('shows a division with nothing yet as empty, not unread', async () => {
    const r = recorder(() => ({ data: [] }));
    const loaded = await load(r);
    for (const d of loaded.divisions) expect(d.reports).toEqual({ workerReports: [], weekly: null, approval: null, decisions: [], unread: [] });
    expect(loaded.notes).toEqual([]);
    expect(shapeDivisions(loaded, NOW).divisions.flatMap((d) => d.reports.workers.map((w) => w.state)).every((s) => s === 'none')).toBe(true);
  });

  it('says how many workers there are to read for the newest-of-each fallback, one read for each worker that has none', async () => {
    const r = recorder((call) => (call.table === 'worker_reports' || call.table === 'weekly_reports' ? { data: [] } : happy(call)));
    await load(r);
    const single = r.calls.filter((c) => c.table === 'worker_reports' && c.ops.some((x) => /^eq\(worker_id,/.test(x)));
    expect(single).toHaveLength(15);
  });

  it('notes it when the last seven days hold more reports than it reads', async () => {
    const many = Array.from({ length: 100 }, (_, i) => workerRow('finance.email', '2026-10-27', workerReport('finance.email'), { id: `e${i}`.padEnd(36, '0') }));
    const r = recorder((call) => (call.table === 'worker_reports' && divisionOf(call) === 'finance' ? { data: many } : happy(call)));
    const loaded = await load(r);
    expect(loaded.notes).toEqual(['The Finance worker reports: more than 100 were written in the last seven days; the newest 100 are read.']);
  });
});

describe('the loader names what it could not read', () => {
  const fail = (match: (c: Call) => boolean, code = '57014') => recorder((call) => (match(call) ? { data: null, error: { message: 'relation boom does not exist', code } } : happy(call)));

  it('shows a division\'s workers as unread, with the part and the code, and keeps everything else', async () => {
    const loaded = await load(fail((c) => c.table === 'worker_reports' && c.ops.includes('eq(division,finance)')));
    expect(loaded.notes).toEqual(['The Finance worker reports could not be read right now (57014).']);
    expect(loaded.divisions.map((d) => [d.division, d.reports!.unread])).toEqual([['salon', []], ['finance', ['workers']], ['online', []]]);
    expect(loaded.divisions.find((d) => d.division === 'finance')!.reports!.weekly).not.toBeNull();
  });

  it('shows the weekly report as unread when only it failed, and then reads no approvals', async () => {
    const r = fail((c) => c.table === 'weekly_reports' && c.ops.includes('eq(division,online)'), '42P01');
    const loaded = await load(r);
    expect(loaded.notes).toEqual(['The Online weekly report could not be read right now (42P01).']);
    expect(loaded.divisions.map((d) => [d.division, d.reports!.unread])).toEqual([['salon', []], ['finance', []], ['online', ['weekly']]]);
    expect(r.calls.filter((c) => c.table === 'approvals')).toHaveLength(2);
  });

  it('shows where a path or an action stands as unknown when the code or the decisions could not be read', async () => {
    // What was read still counts: a decision that was read is an approval, even when the code's standing could not be.
    for (const [label, match, expected] of [
      ['The Finance weekly report approvals', (c: Call) => c.table === 'approvals' && c.ops.includes(`eq(message_id,${noteId('finance')})`), ['unknown', 'approved', 'unknown']],
      ['The Finance weekly report decisions', (c: Call) => c.ops.includes('eq(kind,decision)') && c.ops.includes(`eq(reply_to,${noteId('finance')})`), ['unknown', 'unknown', 'unknown']],
    ] as const) {
      const loaded = await load(fail(match));
      expect(loaded.notes, label).toEqual([`${label} could not be read right now (57014).`]);
      expect(loaded.divisions.find((d) => d.division === 'finance')!.reports!.unread, label).toEqual(['approvals']);
      const states = shapeDivisions(loaded, NOW).divisions.find((d) => d.id === 'finance')!.reports.weekly!.options.map((o) => o.approval.state);
      expect(states, label).toEqual(expected);
    }
  });

  it('shows a worker\'s fallback read failing as the workers being unread, and not the old reports as missing', async () => {
    const loaded = await load(fail((c) => c.ops.includes('eq(worker_id,finance.meta)')));
    expect(loaded.divisions.find((d) => d.division === 'finance')!.reports!.unread).toEqual(['workers']);
    expect(loaded.notes).toEqual(['The Finance worker reports could not be read right now (57014).']);
  });

  it('says so for every part when the database is down, without its words', async () => {
    const loaded = await load(recorder(() => ({ data: null, error: { message: 'connection refused', code: '08006' } })));
    expect(loaded.divisions.map((d) => d.reports!.unread)).toEqual(Array(3).fill(['workers', 'weekly']));
    const view = shapeDivisions(loaded, NOW);
    expect(view.divisions.flatMap((d) => d.reports.workers.map((w) => w.state)).every((s) => s === 'unread')).toBe(true);
    expect(JSON.stringify(view.notes)).not.toContain('connection refused');
  });
});

describe('the loader for a head\'s own view', () => {
  it('reads one division only: its brief, its reports, its questions, and no CEO digest', async () => {
    const r = recorder(happy);
    const loaded = await load(r, 'finance');
    expect(loaded.divisions.map((d) => d.division)).toEqual(['finance']);
    expect(r.calls.filter((c) => c.table === 'division_briefs').map((c) => op(c, 'eq'))).toEqual(['eq(division,finance)']);
    expect(r.calls.filter((c) => c.table === 'worker_reports').every((c) => c.ops.includes('eq(division,finance)') || c.ops.some((x) => x.startsWith('eq(worker_id,finance.')))).toBe(true);
    expect(r.calls.filter((c) => c.table === 'weekly_reports').map((c) => op(c, 'eq'))).toEqual(['eq(division,finance)']);
    expect(r.calls.some((c) => c.ops.includes('like(dedupe_key,digestdoc:%)'))).toBe(false);
    expect(loaded.digest).toBeNull();
    expect(loaded.unread).toEqual([]);
    // Only the questions this division asked or was asked.
    const asked = r.calls.find((c) => c.ops.includes('like(dedupe_key,datareq:%)'))!;
    expect(asked.ops).toContain('or(from_assistant.eq.finance,to_assistant.eq.finance)');
  });

  it('reads everything for the owner, as before', async () => {
    const r = recorder(happy);
    await load(r);
    expect(r.calls.some((c) => c.ops.includes('like(dedupe_key,digestdoc:%)'))).toBe(true);
    const asked = r.calls.find((c) => c.ops.includes('like(dedupe_key,datareq:%)'))!;
    expect(asked.ops.some((x) => x.startsWith('or('))).toBe(false);
  });
});

describe('the report loader (what a PDF is made from)', () => {
  const finance = weeklyReport('finance');
  const packet = (call: Call) => {
    if (call.table === 'weekly_reports') return { data: { id: weeklyRowId('finance'), division: 'finance', report: finance } };
    // The packet's worker reports come back in any order, plus a stray row that belongs to another division.
    if (call.table === 'worker_reports') return { data: [...WORKERS_OF.finance].reverse().map((w) => ({ worker_id: w, report: workerReport(w) })) };
    return { data: null };
  };

  it('reads a weekly report by its id with named columns, then its worker reports of the same division', async () => {
    const r = recorder(packet);
    const doc = await createReportLoader({ db: r.db })('weekly', weeklyRowId('finance'));
    expect(doc).toMatchObject({ kind: 'weekly', division: 'finance' });
    const [first, second] = r.calls;
    expect(first).toMatchObject({ table: 'weekly_reports', select: 'id,division,report' });
    expect(first!.ops).toContain(`eq(id,${weeklyRowId('finance')})`);
    expect(second).toMatchObject({ table: 'worker_reports', select: 'worker_id,report' });
    expect(second!.ops).toContain('eq(division,finance)');
    expect(second!.ops.some((x) => x.startsWith('in(id,'))).toBe(true);
    for (const c of r.calls) expect(c.select).not.toMatch(NOT_SAFE);
    // In the registry's order, whatever order the database sent.
    if (doc?.kind !== 'weekly') throw new Error('expected a weekly packet');
    expect(doc.workers.map((w) => w.workerId)).toEqual(WORKERS_OF.finance);
    expect(doc.weekly.division).toBe('finance');
  });

  it('leaves out a worker report that is not in its shape, so the PDF says it could not be loaded', async () => {
    const r = recorder((call) => (call.table === 'worker_reports' ? { data: [{ worker_id: 'finance.email', report: workerReport('finance.email') }, { worker_id: 'finance.meta', report: { headline: 'nope' } }] } : packet(call)));
    const doc = await createReportLoader({ db: r.db })('weekly', weeklyRowId('finance'));
    if (doc?.kind !== 'weekly') throw new Error('expected a weekly packet');
    expect(doc.workers.map((w) => w.workerId)).toEqual(['finance.email']);
  });

  it('reads one worker report by its id', async () => {
    const r = recorder((call) => ({ data: { division: 'finance', report: workerReport('finance.meta') } }));
    const doc = await createReportLoader({ db: r.db })('worker', workerRowId('finance.meta', '2026-10-27'));
    expect(doc).toMatchObject({ kind: 'worker', division: 'finance' });
    expect(r.calls[0]).toMatchObject({ table: 'worker_reports', select: 'division,report' });
  });

  it('returns null for an id with no report', async () => {
    const loader = createReportLoader({ db: recorder(() => ({ data: null })).db });
    expect(await loader('weekly', weeklyRowId('finance'))).toBeNull();
    expect(await loader('worker', workerRowId('finance.meta', '2026-10-27'))).toBeNull();
  });

  it('refuses a report that is not in its shape, or whose division disagrees with its row, without showing it', async () => {
    await expect(createReportLoader({ db: recorder(() => ({ data: { id: 'x', division: 'finance', report: { summary: 'x' } } })).db })('weekly', weeklyRowId('finance'))).rejects.toThrow('not in the shape');
    await expect(createReportLoader({ db: recorder(() => ({ data: { division: 'online', report: workerReport('finance.meta') } })).db })('worker', workerRowId('finance.meta', '2026-10-27'))).rejects.toThrow('not in the shape');
    await expect(createReportLoader({ db: recorder(() => ({ data: { id: 'x', division: 'online', report: finance } })).db })('weekly', weeklyRowId('finance'))).rejects.toThrow('not in the shape');
  });

  it('fails plainly when the database does, with the code and none of its words', async () => {
    const loader = createReportLoader({ db: recorder(() => ({ data: null, error: { message: 'relation boom does not exist', code: '42P01' } })).db });
    await expect(loader('weekly', weeklyRowId('finance'))).rejects.toThrow('read failed (42P01)');
  });
});
