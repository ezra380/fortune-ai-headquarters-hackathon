import { z } from 'zod';
import { BriefStatus, Division, DivisionBrief, Metric, MetricId, ProfitPlans } from './schemas.ts';

// Wave 2: each division's named manager, its recurring workers and its weekly report (docs/wave2.md).
// Stored as jsonb in worker_reports.report and weekly_reports.report; the worker writes them, delivery
// and the console read them. Every shape here is parsed before it is shown, printed or sent.

/** The three divisions that have a manager and workers (HQ is the owner's own division). */
export const ManagedDivision = z.enum(['finance', 'online', 'salon']);
export type ManagedDivision = z.infer<typeof ManagedDivision>;

/** Who runs each division and whom they report to (Ezra, 2026-10-27). Display names only: people rows hold the rest. */
export const MANAGERS: Record<ManagedDivision, { manager: string; head: string; title: string }> = {
  finance: { manager: 'George', head: 'Alan', title: 'Finance' },
  online: { manager: 'Georgette', head: 'Emma', title: 'Online' },
  salon: { manager: 'Cindy', head: 'Esther', title: 'Salon' },
};

/** Every recurring worker. Its division is the part before the dot. */
export const WORKER_IDS = [
  'finance.email', 'finance.google_ads', 'finance.meta', 'finance.amazon', 'finance.walmart', 'finance.online_money', 'finance.salon_money',
  'online.messages', 'online.journey', 'online.inventory', 'online.returns_reviews', 'online.site_content',
  'salon.clients', 'salon.turnaround', 'salon.appointments',
] as const;
export const WorkerId = z.enum(WORKER_IDS);
export type WorkerId = z.infer<typeof WorkerId>;
export const workerDivision = (id: WorkerId): ManagedDivision => id.slice(0, id.indexOf('.')) as ManagedDivision;

/** Set by the program from the attention rules, never by a model (the brief's statuses). */
export const ReportStatus = BriefStatus;
export type ReportStatus = z.infer<typeof ReportStatus>;

/** A fixed data rule that fired (the port's Attention, as stored). */
export const AttentionItem = z.object({
  metricId: MetricId,
  level: z.enum(['watch', 'act']),
  rule: z.string().min(1).max(200),
});
export type AttentionItem = z.infer<typeof AttentionItem>;

/** One finding: words that cite metric ids; every number in the words traces to what was read. */
export const ReportFinding = z.object({
  text: z.string().min(1).max(300),
  cites: z.array(MetricId).max(8),
});
export type ReportFinding = z.infer<typeof ReportFinding>;

/** The totals a port added up for one row read (counts, money per business), so the words may cite them. */
export const RowTotals = z.object({
  read: z.string().min(1).max(40),
  totals: z.record(z.string().min(1).max(60), z.number().finite()),
});
export type RowTotals = z.infer<typeof RowTotals>;

/** One worker's daily report (worker_reports.report). */
export const WorkerReport = z.object({
  workerId: WorkerId,
  /** The company day it was written for (New York date). */
  day: z.iso.date(),
  /** The data period its numbers came from. */
  period: z.string().min(1).max(40),
  status: ReportStatus,
  /** 'rule' = the model's words did not pass their number check, so a program wrote the report from the rules. */
  writtenBy: z.enum(['model', 'rule']),
  headline: z.string().min(1).max(160),
  findings: z.array(ReportFinding).max(5),
  /** Every number the report may show, exactly as read (the words cite these by id). */
  metrics: z.array(Metric).min(1).max(60),
  attention: z.array(AttentionItem).max(20),
  rows: z.array(RowTotals).max(4),
  /** <view>#<first 12 characters of the query hash>. */
  dataSource: z.string().min(1).max(200),
});
export type WorkerReport = z.infer<typeof WorkerReport>;

/** One worker's part of the weekly report. */
export const WeeklySection = z.object({
  workerId: WorkerId,
  status: ReportStatus,
  summary: z.string().min(1).max(500),
  cites: z.array(MetricId).max(10),
});
export type WeeklySection = z.infer<typeof WeeklySection>;

/** What the manager asked another division and what came back (numbers only from that division's tools). */
export const AskedNote = z.object({
  division: Division,
  question: z.string().min(1).max(300),
  answer: z.string().min(1).max(500),
  ok: z.boolean(),
});
export type AskedNote = z.infer<typeof AskedNote>;

/** George's profit goal of the week: one metric moved from where it is to a target by a date. */
export const WeeklyGoal = z.object({
  title: z.string().min(3).max(120),
  metricId: MetricId,
  from: z.number().finite(),
  to: z.number().finite(),
  by: z.iso.date(),
  why: z.string().min(1).max(300),
});
export type WeeklyGoal = z.infer<typeof WeeklyGoal>;

/** A division's weekly report from its manager to its head (weekly_reports.report). */
export const WeeklyReport = z.object({
  division: ManagedDivision,
  /** The Monday of the week it covers. */
  weekOf: z.iso.date(),
  manager: z.string().min(1).max(40),
  head: z.string().min(1).max(40),
  period: z.string().min(1).max(40),
  status: ReportStatus,
  writtenBy: z.enum(['model', 'rule']),
  summary: z.string().min(1).max(800),
  sections: z.array(WeeklySection).min(1).max(8),
  asked: z.array(AskedNote).max(4),
  /** Finance: required unless the program wrote the report from the rules. Online and salon: null. */
  goal: WeeklyGoal.nullable(),
  /** Finance: three profit paths, checked by checkPlans (same rule as the goal). Online and salon: null. */
  paths: ProfitPlans.nullable(),
  /** Online and salon: up to three actions the head may approve. Finance: empty (its paths are the actions). */
  actions: DivisionBrief.shape.actions,
  /** One plain sentence for the CEO division. */
  ceoLine: z.string().min(1).max(140),
  /** Every number the report may show, exactly as read. */
  metrics: z.array(Metric).max(250),
  /** The worker_reports rows it was built from. */
  workerReportIds: z.array(z.uuid()).max(16),
  dataSource: z.string().min(1).max(200),
})
  .refine((r) => r.division === 'finance' || (r.goal === null && r.paths === null), {
    message: 'only the finance report carries a goal and profit paths',
  })
  .refine((r) => r.division !== 'finance' || r.writtenBy === 'rule' || (r.goal !== null && r.paths !== null), {
    message: "George's report carries a goal of the week and three paths (a report the program wrote from the rules has neither)",
  });
export type WeeklyReport = z.infer<typeof WeeklyReport>;

/** Outbox attachment refs for reports (outbox.attachment_ref). */
export const workerReportRef = (id: string) => `worker_report:${id}`;
export const weeklyReportRef = (id: string) => `weekly_report:${id}`;
