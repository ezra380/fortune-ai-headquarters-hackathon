import type { AssistantId } from '@fahq/contracts';

// The four departments of the Admin console and the two shapes of data that cross this server:
// RawDepartment is what a data source hands over (database rows and brain records, as they are),
// DepartmentView is the only thing that ever leaves the server (see shape.ts).

export type DepartmentId = AssistantId;
export type LiveDepartmentId = Exclude<DepartmentId, 'salon'>;

export type DepartmentInfo = { id: DepartmentId; name: string; placeholder: boolean };

export const DEPARTMENTS: readonly DepartmentInfo[] = [
  { id: 'owner', name: 'Owner HQ', placeholder: false },
  { id: 'finance', name: 'Finance Department', placeholder: false },
  { id: 'online', name: 'Online Customer Service Department', placeholder: false },
  { id: 'salon', name: 'Salon Department (Cindy)', placeholder: true },
];

export const SALON_MESSAGE =
  "Cindy runs in her own app. This tab will mirror her backend at the same admin level, with the head stylist's knowledge; her family and personal data stay in her app.";

export const BRAIN_NOTE =
  'Memory and shared record: brain not available yet. They fill in as soon as the assistants record something.';

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
  decisions: { content: string; tags: string[] }[];
  timeline: { id: string; type: string; at?: string | null }[];
  notes: string[];
};

// ---- What leaves the server ----

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
  }[];
  memory: { text: string; tags: string[] }[];
  timeline: { id: string; type: string; at: string | null }[];
  notes: string[];
};

export type PlaceholderView = { id: DepartmentId; name: string; placeholder: true; message: string };
