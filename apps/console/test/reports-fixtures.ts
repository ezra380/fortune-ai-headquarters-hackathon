import { workerDivision, WORKER_IDS } from '@fahq/contracts';
import type { ManagedDivision, WeeklyReport, WorkerId, WorkerReport } from '@fahq/contracts';
import type {
  BriefDivision, RawDivisionReports, RawDivisionState, RawDivisions, RawWeeklyReportRow, RawWorkerReportRow,
} from '../src/divisions.ts';
import { weeklyReport, workerReport, WORKERS_OF } from '../../../packages/delivery/test/report-fixtures.ts';

// Rows shaped like the ones the worker writes into worker_reports and weekly_reports, built from the SYNTHETIC reports the
// delivery tests use (every one parsed with its real contract). Shared by the wave-2 console tests.

export const NOW = new Date('2026-10-27T13:30:00.000Z'); // Tuesday 09:30 in New York: the last seven days start 2026-10-21
export { weeklyReport, workerReport, WORKERS_OF };

const hex = (n: number, width: number) => n.toString(16).padStart(width, '0');
/** A stable, well-formed row id for a worker's report on a day. */
export const workerRowId = (worker: WorkerId, day: string) => `a0a0a0a0-0000-4000-8000-ab${hex(WORKER_IDS.indexOf(worker) + 1, 2)}c${day.slice(5, 7)}d${day.slice(8, 10)}ef`;
export const weeklyRowId = (division: ManagedDivision) => `b1b1b1b1-0000-4000-8000-bbbbbbbbbb0${['salon', 'finance', 'online'].indexOf(division) + 1}`;
export const noteId = (division: ManagedDivision) => `c2c2c2c2-0000-4000-8000-cccccccccc0${['salon', 'finance', 'online'].indexOf(division) + 1}`;

export function workerRow(worker: WorkerId, day = '2026-10-27', report: unknown = workerReport(worker, { day }), over: Partial<RawWorkerReportRow> = {}): RawWorkerReportRow {
  return {
    id: workerRowId(worker, day),
    worker_id: worker,
    division: workerDivision(worker),
    report_date: day,
    status: (report as WorkerReport).status ?? 'normal',
    written_by: 'model',
    report,
    created_at: `${day}T11:00:07.000Z`,
    ...over,
  };
}

export function weeklyRow(division: ManagedDivision, report: unknown = weeklyReport(division), over: Partial<RawWeeklyReportRow> = {}): RawWeeklyReportRow {
  const r = report as WeeklyReport;
  return {
    id: weeklyRowId(division),
    division,
    week_of: '2026-10-26',
    status: r.status ?? 'normal',
    written_by: 'model',
    report,
    ceo_line: r.ceoLine ?? 'A line.',
    message_id: noteId(division),
    created_at: '2026-10-26T11:30:12.000Z',
    ...over,
  };
}

/** A division whose workers all reported today and whose weekly report is out. */
export function reportsOf(division: ManagedDivision, over: Partial<RawDivisionReports> = {}): RawDivisionReports {
  return {
    workerReports: WORKERS_OF[division].map((w) => workerRow(w)),
    weekly: weeklyRow(division),
    approval: null,
    decisions: [],
    unread: [],
    ...over,
  };
}

export const state = (division: BriefDivision, over: Partial<RawDivisionState> = {}): RawDivisionState => ({
  division, brief: null, approval: null, decisions: [], unread: [], reports: reportsOf(division), ...over,
});

export const raw = (over: Partial<RawDivisions> = {}): RawDivisions => ({
  divisions: [state('salon'), state('finance'), state('online')], requests: [], replies: [], digest: null, unread: [], notes: [], ...over,
});

export const approved = (rank: number, at = '2026-10-27T12:40:00.000Z') => ({
  created_at: at,
  body: { type: 'action_decision', briefId: 'x', division: 'finance', rank, title: 'A path', verdict: 'approved', by: 'demo-p-finance-owner' },
});

export const everything = (v: unknown) => JSON.stringify(v);
