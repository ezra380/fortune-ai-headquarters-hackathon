// The Divisions view of the Admin console: each division's latest brief, the questions the divisions asked each other, and
// the CEO digest. Two shapes of data cross this server, as in departments.ts:
// RawDivisions is what the data source hands over (rows exactly as stored), DivisionsView is the only thing that ever
// leaves the server (see shape.ts).

export type BriefDivision = 'salon' | 'finance' | 'online';

/** The divisions that write a brief, in the order the CEO digest lists them, with the head each one writes to. */
export const BRIEF_DIVISIONS: readonly { id: BriefDivision; name: string; head: string }[] = [
  { id: 'salon', name: 'Salon', head: 'the head stylist' },
  { id: 'finance', name: 'Finance', head: 'the finance owner' },
  { id: 'online', name: 'Online', head: 'the online staff lead' },
];

export const isBriefDivision = (v: unknown): v is BriefDivision => BRIEF_DIVISIONS.some((d) => d.id === v);

// ---- What a data source returns (only named columns are ever requested) ----

/** A stored brief. The jsonb `brief` is typed unknown on purpose: it is checked when shaped, because a bad shape must become a note. */
export type RawBriefRow = {
  division: string;
  brief_key: string;
  brief_date: string;
  status: string;
  written_by: string;
  brief: unknown;
  ceo_line: string;
  created_at: string;
};

/** The newest `approve_action` code on the brief (the code hash is never requested). */
export type RawBriefApproval = { status: string; expires_at: string; decided_at: string | null };

/** The mailbox note the HQ Manager gets when a head approves an action; only its rank and verdict are read, never who decided. */
export type RawActionDecision = { created_at: string; body: unknown };

export type BriefPart = 'brief' | 'actions';

/** A stored daily report of one worker (wave 2). The jsonb `report` is checked against its contract when shaped. */
export type RawWorkerReportRow = {
  id: string;
  worker_id: string;
  division: string;
  report_date: string;
  status: string;
  written_by: string;
  report: unknown;
  created_at: string;
};

/** A stored weekly report. `message_id` is the note the head approves a path or an action against, once the report is sent. */
export type RawWeeklyReportRow = {
  id: string;
  division: string;
  week_of: string;
  status: string;
  written_by: string;
  report: unknown;
  ceo_line: string;
  message_id: string | null;
  created_at: string;
};

export type ReportsPart = 'workers' | 'weekly' | 'approvals';

/** What a data source returns for the wave-2 reports of one division. */
export type RawDivisionReports = {
  /** The last seven company days, newest first, plus the newest report of any worker that has none in that time. */
  workerReports: RawWorkerReportRow[];
  /** null = no weekly report yet (or it could not be read: then `unread` says so). */
  weekly: RawWeeklyReportRow | null;
  /** The newest `approve_action` code on the weekly report's note, and the decisions recorded against it. */
  approval: RawBriefApproval | null;
  decisions: RawActionDecision[];
  unread: ReportsPart[];
};

export type RawDivisionState = {
  division: BriefDivision;
  /** null = no brief yet (or it could not be read: then `unread` says so). */
  brief: RawBriefRow | null;
  approval: RawBriefApproval | null;
  decisions: RawActionDecision[];
  /** Which parts could not be read, so the page says "could not be read" instead of "nothing yet". */
  unread: BriefPart[];
  /** Wave 2: the division's workers' reports and weekly report. A source that sends none is shown as unread. */
  reports?: RawDivisionReports;
};

export type RawRequest = { id: string; from_assistant: string; to_assistant: string; created_at: string; body: unknown };
/** An answer to a request: only whether it worked and why not (the facts it carried are never read here). `ok` arrives as text from the JSON path. */
export type RawReply = { reply_to: string; created_at: string; ok: unknown; reason: unknown };
export type RawDigest = { created_at: string; body: unknown };

export type DivisionsPart = 'requests' | 'replies' | 'digest';

export type RawDivisions = {
  divisions: RawDivisionState[];
  requests: RawRequest[];
  replies: RawReply[];
  digest: RawDigest | null;
  /** The parts that could not be read (the reason is in notes). */
  unread: DivisionsPart[];
  notes: string[];
};

// ---- What leaves the server ----

export type BriefStatusView = 'normal' | 'watch' | 'act' | 'unknown';

/**
 * Where one action stands. approved: the head used the code on it. awaiting: a code is waiting. code_expired / code_locked: the code
 * ran out or was locked by wrong tries. not_approved: the code was used, but not for this action. no_code: none was sent.
 */
export type ActionState = 'approved' | 'awaiting' | 'code_expired' | 'code_locked' | 'not_approved' | 'no_code' | 'unknown';

export type ActionView = {
  rank: number;
  title: string;
  why: string;
  steps: string;
  cites: string[];
  approval: { state: ActionState; /** approved: when. awaiting / expired: when the code ends. not_approved: when the code was used. */ at: string | null };
};

export type BriefView = {
  /** The day the brief is for, YYYY-MM-DD. */
  date: string | null;
  createdAt: string | null;
  status: BriefStatusView;
  /** 'rule' = a program wrote it because the usual write-up did not pass its number check. */
  writtenBy: 'model' | 'rule' | 'unknown';
  headline: string;
  findings: { text: string; cites: string[] }[];
  actions: ActionView[];
  /** The one line this division gave the CEO division. */
  ceoLine: string;
};

/** answered: the other division replied. unavailable: it replied that it could not answer (the reason is kept). unanswered: no reply yet. */
export type RequestState = 'answered' | 'unavailable' | 'unanswered' | 'unreadable';

export type RequestView = {
  from: BriefDivision;
  to: BriefDivision;
  question: string;
  askedAt: string | null;
  answeredAt: string | null;
  state: RequestState;
  reason: string | null;
};

/** Who runs the division and whom the manager reports to ("George, Finance, reports to Alan"). Display names only. */
export type ManagerView = { name: string; title: string; reportsTo: string };

/** A number as a person reads it: the label, the value written by its unit, and the metric id it traces to. */
export type NumberView = { id: string; label: string; shown: string };

export type WorkerDayView = { id: string | null; day: string; status: BriefStatusView; headline: string; writtenBy: 'model' | 'rule' };

export type WorkerReportView = {
  /** The stored report's id, only when it is a well-formed id: the PDF link is built from it. */
  id: string | null;
  day: string;
  period: string;
  createdAt: string | null;
  status: BriefStatusView;
  writtenBy: 'model' | 'rule';
  headline: string;
  findings: { text: string; cites: string[] }[];
  /** The fixed data rules that fired. */
  rules: { level: 'watch' | 'act'; rule: string; metricId: string }[];
  /** The numbers the words and rules lean on, first; the same ones the PDF shows. */
  numbers: NumberView[];
  moreNumbers: number;
  rows: { read: string; totals: { label: string; shown: string }[] }[];
  source: string;
};

/**
 * One worker of the division. ok: it has a report. none: it has not reported yet. unreadable: its report is there but is not
 * in the shape the contract says. unread: the reports could not be read at all.
 */
export type WorkerSlotView = {
  workerId: string;
  label: string;
  state: 'ok' | 'none' | 'unreadable' | 'unread';
  latest: WorkerReportView | null;
  /** The latest report is older than seven days. */
  stale: boolean;
  /** One entry for each of the last seven company days that has a report, newest first. */
  week: WorkerDayView[];
};

export type WeeklyOptionView = {
  kind: 'path' | 'action';
  rank: number;
  title: string;
  /** A path's summary, or an action's reason. */
  why: string;
  /** A path's things to do, or an action's steps. */
  steps: string[];
  numbers: NumberView[];
  projections: { text: string; assumption: string }[];
  test: string | null;
  stopLoss: string | null;
  risks: string[];
  approval: ActionView['approval'];
};

export type WeeklyView = {
  /** The stored report's id, only when it is a well-formed id: the PDF link is built from it. */
  id: string | null;
  weekOf: string;
  createdAt: string | null;
  period: string;
  status: BriefStatusView;
  writtenBy: 'model' | 'rule';
  summary: string;
  /** Finance only: the profit goal of the week. */
  goal: { title: string; metric: string; from: string; to: string; by: string; why: string } | null;
  /** Finance: the three paths. Online and salon: up to three actions. */
  options: WeeklyOptionView[];
  sections: { workerId: string; label: string; status: BriefStatusView; summary: string; numbers: NumberView[] }[];
  asked: { division: string; question: string; answer: string; ok: boolean }[];
  ceoLine: string;
  /** Whether a message to approve against was sent (a head cannot approve before it is). */
  sent: boolean;
  source: string;
};

export type ReportsBlock = {
  /** Every worker of the division, in the registry's order, each with its latest report and its last seven days. */
  workers: WorkerSlotView[];
  weekly: WeeklyView | null;
  unread: ReportsPart[];
};

export type DivisionBlock = {
  id: BriefDivision;
  name: string;
  head: string;
  manager: ManagerView;
  brief: BriefView | null;
  reports: ReportsBlock;
  /** Questions this division asked the others, newest first. */
  asked: RequestView[];
  /** Questions the others asked this division, newest first. */
  received: RequestView[];
  unread: BriefPart[];
};

export type DigestView = {
  date: string | null;
  createdAt: string | null;
  /** The words as the owner was sent them. */
  text: string;
  /** What each division's report looked like when the digest was written. */
  reports: { division: BriefDivision; state: 'in' | 'missing' | 'unreadable'; status: BriefStatusView | null }[];
};

export type DivisionsView = {
  generatedAt: string;
  /** Present only in a head's own view: the one division it shows. The CEO digest is the owner's, so a head's view has none. */
  only?: BriefDivision;
  divisions: DivisionBlock[];
  digest: DigestView | null;
  unread: DivisionsPart[];
  notes: string[];
};
