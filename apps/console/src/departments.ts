import type { AssistantId } from '@fahq/contracts';

// The departments of the Admin console and the two shapes of data that cross this server:
// RawDepartment is what a data source hands over (database rows and brain records, as they are),
// DepartmentView is the only thing that ever leaves the server (see shape.ts).

export type DepartmentId = AssistantId;
export type LiveDepartmentId = Exclude<DepartmentId, 'salon'>;

export type DepartmentInfo = { id: DepartmentId; name: string; placeholder: boolean };

export const DEPARTMENTS: readonly DepartmentInfo[] = [
  { id: 'owner', name: 'Owner HQ', placeholder: false },
  { id: 'finance', name: 'Finance Department', placeholder: false },
  { id: 'online', name: 'Online Customer Service Department', placeholder: false },
  { id: 'manager', name: 'HQ Manager', placeholder: false },
  { id: 'salon', name: 'Salon Department (Cindy)', placeholder: true },
];

export const SALON_MESSAGE =
  "Cindy runs in her own app. This tab will mirror her backend at the same admin level, with the head stylist's knowledge; her family and personal data stay in her app.";

export const BRAIN_NOTE =
  'Memory and shared record: brain not available yet. They fill in as soon as the assistants record something.';

/** The HQ Manager tab counts the work reports finished in this many hours. */
export const USAGE_WINDOW_HOURS = 24;

// ---- What a data source returns (rows exactly as stored; only safe columns are ever requested) ----

export type RawTask = { id: string; kind: string; status: string; attempts: number; last_error: string | null; created_at: string };
export type RawMessage = {
  from_assistant: string;
  to_assistant: string;
  kind: string;
  status: string;
  created_at: string;
  body?: unknown;
};
export type RawApproval = { action: string; status: string; expires_at: string; decided_at: string | null };
export type RawOutbox = {
  channel: string;
  status: string;
  created_at: string;
  sent_at: string | null;
  last_error: string | null;
  body: string;
};
export type RawReceipt = {
  step: string;
  outcome: string;
  model: string | null;
  data_source: string | null;
  started_at: string;
  ended_at: string;
  detail: string | null;
  live?: boolean | null;
  /** Provider-reported tokens for the step; null when the step called no model. */
  input_tokens?: number | null;
  output_tokens?: number | null;
};

/**
 * What an assistant hands the HQ Manager when a task ends. The jsonb columns (usage, suggestions) are
 * typed unknown on purpose: they are checked when shaped, because a bad shape must become a note.
 */
export type RawWorkReport = {
  task_id?: string | null;
  assistant_id: string;
  task_kind: string;
  outcome: string;
  summary: string;
  usage: unknown;
  suggestions: unknown;
  input_tokens: number | null;
  output_tokens: number | null;
  model_calls: number | null;
  started_at: string;
  ended_at: string;
};

/** Just enough of a finished report to add up the last day's usage (no text of any kind). */
export type RawUsageRow = {
  assistant_id: string;
  outcome: string;
  model_calls: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
};

export type RawReview = {
  /** Only used to fetch this review's recommendations; never shown. */
  id?: string;
  covers_from: string;
  covers_to: string;
  report_count: number | null;
  /** jsonb { summary, findings: [{ assistant, text }], recommendations: [...] }, checked when shaped. */
  review: unknown;
  model: string | null;
  created_at: string;
};

/** A recommendation's text and status. Who decided it is never read: the page says "adopted" or "not yet". */
export type RawRecommendation = {
  rank?: number | null;
  assistant_id: string;
  change: string;
  why?: string | null;
  status: string;
  decided_at: string | null;
};

export type ManagerPart = 'usage' | 'review' | 'lessons';

export type RawManager = {
  /** null = the last day's reports could not be read (the reason is in notes). */
  usageRows: RawUsageRow[] | null;
  review: RawReview | null;
  recommendations: RawRecommendation[];
  /** Adopted recommendations, newest first. */
  lessons: RawRecommendation[];
  /** Which parts could not be read, so the page says "could not be read" instead of "nothing yet". */
  unread: ManagerPart[];
};

export type RawDepartment = {
  assistant: { display_name: string | null; sms_from: string | null } | null;
  /** null = that count could not be read (its reason is in notes). */
  counts: { openTasks: number | null; proposals: number | null; pendingApprovals: number | null };
  tasks: RawTask[];
  messages: RawMessage[];
  approvals: RawApproval[];
  outbox: RawOutbox[];
  receipts: RawReceipt[];
  /** Finished-work reports: this assistant's latest 15, or (for the HQ Manager) the latest 30 of all assistants. */
  reports?: RawWorkReport[];
  /** Only for the HQ Manager. */
  manager?: RawManager;
  decisions: { content: string; tags: string[] }[];
  timeline: { id: string; type: string; at?: string | null }[];
  notes: string[];
};

// ---- What leaves the server ----

export type ReportView = {
  taskId: string;
  assistant: string;
  taskKind: string;
  outcome: string;
  summary: string;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number | null;
  endedAt: string | null;
  codeMode: { scripts: number; toolCalls: number; resultChars: number } | null;
  suggestions: { kind: string; about: string; text: string }[];
};

export type UsageCounts = {
  tasks: number;
  done: number;
  failed: number;
  retrying: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
};

export type RecommendationView = {
  rank: number | null;
  assistant: string;
  change: string;
  why: string;
  status: 'proposed' | 'adopted' | 'expired' | 'unknown';
  decidedAt: string | null;
};

export type ReviewView = {
  createdAt: string | null;
  coversFrom: string | null;
  coversTo: string | null;
  reportCount: number;
  model: string | null;
  /** null when the stored review could not be read (a note says so). */
  summary: string | null;
  findings: { assistant: string; text: string }[];
  recommendations: RecommendationView[];
};

export type ManagerBlock = {
  /** The last 24 hours of finished work, per assistant; null when it could not be read. */
  usage: { windowHours: number; rows: (UsageCounts & { assistant: string })[]; total: UsageCounts } | null;
  review: ReviewView | null;
  lessons: { assistant: string; change: string; adoptedAt: string | null }[];
  unread: ManagerPart[];
};

export type DepartmentView = {
  id: DepartmentId;
  name: string;
  placeholder: false;
  generatedAt: string;
  assistant: { displayName: string | null; number: string | null } | null;
  counts: { openTasks: number | null; proposals: number | null; pendingApprovals: number | null };
  tasks: { id: string; kind: string; status: string; attempts: number; lastError: string | null; createdAt: string | null }[];
  mailbox: { from: string; to: string; kind: string; status: string; createdAt: string | null; planTitles: string[] }[];
  approvals: { action: string; status: string; expiresAt: string | null; decidedAt: string | null }[];
  outbox: { channel: string; status: string; createdAt: string | null; sentAt: string | null; lastError: string | null; body: string }[];
  receipts: {
    step: string;
    outcome: string;
    model: string | null;
    dataSource: string | null;
    startedAt: string | null;
    durationMs: number | null;
    detail: string | null;
    live: boolean | null;
    inputTokens: number | null;
    outputTokens: number | null;
  }[];
  reports: ReportView[];
  /** Present only on the HQ Manager tab. */
  manager?: ManagerBlock;
  memory: { text: string; tags: string[] }[];
  timeline: { id: string; type: string; at: string | null }[];
  notes: string[];
};

export type PlaceholderView = { id: DepartmentId; name: string; placeholder: true; message: string };
