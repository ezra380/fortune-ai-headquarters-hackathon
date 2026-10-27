import { MANAGERS, WeeklyReport, WORKER_IDS, WorkerReport, workerDivision } from '@fahq/contracts';
import type { ManagedDivision, ReportContext } from '@fahq/contracts';

// How a stored report is read back before it is drawn. The packet the console's PDF link opens and the packet that is emailed and
// printed both come through these functions, so they are always the same packet: a row is trusted only when its report is in its
// contract's shape AND belongs to what the row says it is (the worker, the division). A row that fails is left out, never guessed at,
// and the packet's cover says how many could not be loaded.

/** The columns of a `worker_reports` row that say whose report it is, and the report itself (not yet checked). */
export type WorkerReportRow = { worker_id?: unknown; division?: unknown; report: unknown };

/** One worker's report from its row, or null when the report is not in its shape or is not the report of the worker (or division) the row names. */
export function checkedWorkerReport(row: WorkerReportRow): WorkerReport | null {
  const parsed = WorkerReport.safeParse(row.report);
  if (!parsed.success || row.worker_id !== parsed.data.workerId) return null;
  if (row.division !== undefined && row.division !== workerDivision(parsed.data.workerId)) return null;
  return parsed.data;
}

/** One weekly report from its row, or null when it is not in its shape or its division disagrees with the row's. */
export function checkedWeeklyReport(row: { division?: unknown; report: unknown }): WeeklyReport | null {
  const parsed = WeeklyReport.safeParse(row.report);
  return parsed.success && parsed.data.division === row.division ? parsed.data : null;
}

/**
 * The worker reports of one division's weekly packet, from the rows read for the ids it lists: only reports that pass
 * `checkedWorkerReport` and belong to THIS division (another division's report is never printed in this packet, even if its id
 * is listed), in the registry's order so the packet always reads the same way.
 */
export function packetWorkers(division: ManagedDivision, rows: readonly WorkerReportRow[]): WorkerReport[] {
  return rows
    .flatMap((row) => {
      const report = checkedWorkerReport(row);
      return report && workerDivision(report.workerId) === division ? [report] : [];
    })
    .sort((a, b) => WORKER_IDS.indexOf(a.workerId) - WORKER_IDS.indexOf(b.workerId));
}

/** Who a report is from and for, taken from the registry (never from words stored in the report). */
export function reportContext(division: ManagedDivision): ReportContext {
  const { manager, head, title } = MANAGERS[division];
  return { manager, head, divisionTitle: title };
}
