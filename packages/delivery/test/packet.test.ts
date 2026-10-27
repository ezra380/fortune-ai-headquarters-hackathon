import { describe, expect, it } from 'vitest';
import { checkedWeeklyReport, checkedWorkerReport, packetWorkers, reportContext } from '../src/index.ts';
import { weeklyReport, workerReport, workerReportsOf, WORKERS_OF } from './report-fixtures.ts';

// The one way a stored report is read back before it is drawn (the console's PDF link and the emailed and printed packet both use it).

const row = (id: Parameters<typeof workerReport>[0], over: Record<string, unknown> = {}) => ({ worker_id: id, division: id.split('.')[0], report: workerReport(id), ...over });

describe('checkedWorkerReport', () => {
  it('returns the report of a row whose report is in its shape and is the worker (and division) the row names', () => {
    expect(checkedWorkerReport(row('finance.meta'))).toEqual(workerReport('finance.meta'));
    // The packet read names the worker only; the division is then checked by the packet.
    expect(checkedWorkerReport({ worker_id: 'finance.meta', report: workerReport('finance.meta') })).toEqual(workerReport('finance.meta'));
  });

  it('refuses a report that is not in its shape', () => {
    expect(checkedWorkerReport(row('finance.meta', { report: { headline: 'secret words' } }))).toBeNull();
    expect(checkedWorkerReport(row('finance.meta', { report: null }))).toBeNull();
  });

  it('refuses a report that belongs to another worker than its row says, or to another division', () => {
    expect(checkedWorkerReport(row('finance.meta', { report: workerReport('finance.email') }))).toBeNull();
    expect(checkedWorkerReport(row('finance.meta', { worker_id: 'finance.email' }))).toBeNull();
    expect(checkedWorkerReport(row('finance.meta', { division: 'salon' }))).toBeNull();
    expect(checkedWorkerReport({ report: workerReport('finance.meta') })).toBeNull();
  });
});

describe('checkedWeeklyReport', () => {
  it('returns a weekly report whose division is the row\'s, and nothing else', () => {
    expect(checkedWeeklyReport({ division: 'finance', report: weeklyReport('finance') })).toEqual(weeklyReport('finance'));
    expect(checkedWeeklyReport({ division: 'online', report: weeklyReport('finance') })).toBeNull();
    expect(checkedWeeklyReport({ division: 'finance', report: { summary: 'x' } })).toBeNull();
    expect(checkedWeeklyReport({ report: weeklyReport('finance') })).toBeNull();
  });
});

describe('packetWorkers', () => {
  it('keeps the reports of the packet\'s own division in the registry\'s order, whatever order the rows came in', () => {
    const rows = [...WORKERS_OF.finance].reverse().map((id) => ({ worker_id: id, report: workerReport(id) }));
    expect(packetWorkers('finance', rows).map((r) => r.workerId)).toEqual(WORKERS_OF.finance);
  });

  it('never lets another division\'s report into the packet, even when its id was listed', () => {
    const rows = [...workerReportsOf('finance'), workerReport('salon.clients'), workerReport('online.messages')].map((report) => ({ worker_id: report.workerId, report }));
    const kept = packetWorkers('finance', rows);
    expect(kept.map((r) => r.workerId)).toEqual(WORKERS_OF.finance);
    expect(JSON.stringify(kept)).not.toContain('Clients');
    expect(packetWorkers('salon', rows).map((r) => r.workerId)).toEqual(['salon.clients']);
  });

  it('leaves out, without failing, a row that is malformed or whose report is another worker\'s', () => {
    const rows = [
      { worker_id: 'finance.email', report: workerReport('finance.email') },
      { worker_id: 'finance.meta', report: { headline: 'nope' } },
      { worker_id: 'finance.amazon', report: workerReport('finance.walmart') },
      { worker_id: 'finance.google_ads', report: workerReport('finance.google_ads') },
    ];
    expect(packetWorkers('finance', rows).map((r) => r.workerId)).toEqual(['finance.email', 'finance.google_ads']);
    expect(packetWorkers('finance', [])).toEqual([]);
  });
});

describe('reportContext', () => {
  it('comes from the registry', () => {
    expect(reportContext('finance')).toEqual({ manager: 'George', head: 'Alan', divisionTitle: 'Finance' });
    expect(reportContext('online')).toEqual({ manager: 'Georgette', head: 'Emma', divisionTitle: 'Online' });
    expect(reportContext('salon')).toEqual({ manager: 'Cindy', head: 'Esther', divisionTitle: 'Salon' });
  });
});
