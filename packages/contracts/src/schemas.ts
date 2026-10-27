import { z } from 'zod';

// Shared shapes for every lane. Lane A owns this file; other lanes request changes in
// docs/CONTRACT-REQUESTS.md. Everything that crosses a boundary (model output, HTTP, queue rows,
// files from other lanes) is parsed with these schemas before use.

export const Timestamp = z.iso.datetime({ offset: true });

// 'manager' is the HQ Manager: it reviews the other assistants' work reports and keeps the lessons
// the owner adopts. It has no phone number of its own; it reaches the owner through Owner HQ's number.
export const AssistantId = z.enum(['owner', 'finance', 'salon', 'online', 'manager']);
export type AssistantId = z.infer<typeof AssistantId>;

export const BusinessUnit = z.enum(['salon', 'online', 'combined']);
export type BusinessUnit = z.infer<typeof BusinessUnit>;

// The company's four divisions. A metric's business (salon, online, combined) is the legal split and
// never changes; its divisions say who reads it (ad spend is online business, read by Finance and Online).
// 'hq' is the owner's CEO division: the whole company at a glance, no detail it doesn't need.
export const Division = z.enum(['salon', 'finance', 'online', 'hq']);
export type Division = z.infer<typeof Division>;
/** The assistant that runs each division. */
export const DIVISION_ASSISTANT: Record<Division, AssistantId> = { salon: 'salon', finance: 'finance', online: 'online', hq: 'owner' };

export const UsPhone = z.string().regex(/^\+1\d{10}$/, 'must be an E.164 US number');

export const Person = z.object({
  id: z.string().regex(/^demo-p-[a-z0-9-]+$/, 'must be a synthetic demo-p- id'),
  name: z.string().min(1).max(80),
  role: z.enum(['owner', 'head_stylist', 'finance_owner', 'online_staff']),
  phone: UsPhone,
  assistantId: AssistantId,
});
export type Person = z.infer<typeof Person>;

// ---- Inbound text and the front door -------------------------------------------------------

export const InboundText = z.object({
  messageSid: z.string().regex(/^(SM|MM)[0-9a-f]{32}$/),
  from: UsPhone,
  to: UsPhone,
  body: z.string().max(1600),
  receivedAt: Timestamp,
});
export type InboundText = z.infer<typeof InboundText>;

// 'plans' = asks for plans, ideas or proposals to act on; 'question' = asks for facts or an explanation
// ("why did you propose plan 2?" is a question); 'status' = asks how things stand.
export const Intent = z.enum(['plans', 'question', 'status', 'unknown']);
export type Intent = z.infer<typeof Intent>;
export const Risk = z.enum(['money', 'customer', 'ads', 'schedule']);
export type Risk = z.infer<typeof Risk>;

// What the router model may decide. Approvals are never decided by a model: SEND / CONFIRM /
// DECLINE / CANCEL are parsed deterministically by the worker before any model runs.
export const FrontDoorDecision = z.object({
  intent: Intent,
  risks: z.array(Risk).max(4),
  targetAssistant: AssistantId,
  confidence: z.number().min(0).max(1),
  reason: z.string().max(400),
});
export type FrontDoorDecision = z.infer<typeof FrontDoorDecision>;

// ---- Business numbers ---------------------------------------------------------------------

// The periods business numbers cover, oldest first: twelve whole months, then the month so far. They
// never overlap, so every row belongs to exactly one.
export const PERIOD_KEYS = [
  '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08',
  '2026-09', '2026-10-mtd',
] as const;
export const Period = z.enum(PERIOD_KEYS);
export type Period = z.infer<typeof Period>;
/** The periods a data port serves when it does not list its own (version 1 of the data: the last two). */
export const DEFAULT_PERIODS: readonly Period[] = ['2026-09', '2026-10-mtd'];

export const MetricId = z.string().regex(/^m:(salon|online|combined)\.[a-z0-9_.]+$/);

export const Metric = z.object({
  id: MetricId,
  label: z.string().min(1).max(120),
  value: z.number().finite(),
  unit: z.enum(['usd', 'count', 'ratio', 'percent']),
  business: BusinessUnit,
  period: z.string().min(1).max(40),
  source: z.object({
    system: z.literal('zetaris'),
    view: z.string().min(1).max(120),
    queryHash: z.string().regex(/^[0-9a-f]{64}$/),
    asOf: Timestamp,
  }),
}).refine((m) => m.id.startsWith(`m:${m.business}.`), { message: 'a metric id must start with its business (m:salon., m:online. or m:combined.)' });
export type Metric = z.infer<typeof Metric>;

// ---- Plans (model output, validated before anyone sees it) ---------------------------------

export const Evidence = z.object({
  metricId: MetricId,
  value: z.number().finite(),
  note: z.string().max(200).optional(),
});

export const Projection = z.object({
  label: z.string().min(1).max(160),
  baseMetricId: MetricId,
  // A factor may be a rate (1.2 = +20%) or a count ("50 more bookings × average ticket").
  factor: z.number().finite().min(-1000).max(1000),
  result: z.number().finite(),
  assumption: z.string().min(1).max(300),
});
export type Projection = z.infer<typeof Projection>;

/** A choice the plan proposes (a price, a discount, a budget, a number of slots): never a fact. */
export const Lever = z.object({
  label: z.string().min(1).max(120),
  value: z.number().finite(),
  unit: z.enum(['usd', 'percent', 'count', 'ratio', 'days', 'hours']),
});
export type Lever = z.infer<typeof Lever>;

export const Plan = z.object({
  rank: z.number().int().min(1).max(3),
  title: z.string().min(3).max(90),
  summary: z.string().min(1).max(600),
  actions: z.array(z.string().min(1).max(200)).min(1).max(6),
  evidence: z.array(Evidence).min(1).max(12),
  projections: z.array(Projection).max(6),
  levers: z.array(Lever).max(6).default([]),
  test: z.string().min(1).max(300),
  stopLoss: z.string().min(1).max(300),
  businesses: z.array(BusinessUnit).min(1).max(3),
  risks: z.array(z.string().min(1).max(200)).max(5),
});
export type Plan = z.infer<typeof Plan>;

export const ProfitPlans = z.object({
  plans: z.array(Plan).length(3),
  memoryConflicts: z
    .array(z.object({ memoryId: z.string().min(1).max(80), note: z.string().min(1).max(300) }))
    .max(10),
});
export type ProfitPlans = z.infer<typeof ProfitPlans>;

// ---- Mailbox, contracts, outbox, receipts --------------------------------------------------

export const MessageKind = z.enum(['request', 'proposal', 'decision', 'report']);

export const AssistantMessage = z.object({
  id: z.uuid(),
  fromAssistant: AssistantId,
  toAssistant: AssistantId,
  kind: MessageKind,
  body: z.unknown(),
  status: z.enum(['open', 'answered', 'closed']),
  replyTo: z.uuid().nullable(),
  createdAt: Timestamp,
});
export type AssistantMessage = z.infer<typeof AssistantMessage>;

export const ApprovalStatus = z.enum(['pending', 'signed', 'declined', 'expired']);

export const OutboxChannel = z.enum(['sms', 'print']);

export const ProposalDocument = z.object({
  proposalId: z.uuid(),
  title: z.string().min(1).max(120),
  requestedBy: z.string().min(1).max(80),
  preparedBy: z.string().min(1).max(80),
  createdAt: Timestamp,
  plans: ProfitPlans,
  citedMetrics: z.array(Metric).min(1),
  approvalHint: z.string().min(1).max(200),
});
export type ProposalDocument = z.infer<typeof ProposalDocument>;

export const Receipt = z.object({
  runId: z.uuid(),
  taskId: z.uuid().nullable(),
  step: z.string().min(1).max(60),
  assistantId: AssistantId.nullable(),
  live: z.boolean(),
  model: z.string().max(120).nullable(),
  dataSource: z.string().max(200).nullable(),
  startedAt: Timestamp,
  endedAt: Timestamp,
  costUsd: z.number().min(0).nullable(),
  outcome: z.enum(['ok', 'refused', 'failed']),
  detail: z.string().max(500).nullable(),
  /** Provider-reported tokens for this step's model calls; null when the step called no model. */
  inputTokens: z.number().int().min(0).nullable().optional(),
  outputTokens: z.number().int().min(0).nullable().optional(),
});
export type Receipt = z.infer<typeof Receipt>;

// ---- End-of-work reports and the HQ Manager ------------------------------------------------

/** One step of a finished task, copied from its receipts. */
export const WorkStep = z.object({
  step: z.string().min(1).max(60),
  outcome: z.enum(['ok', 'refused', 'failed']),
  model: z.string().max(120).nullable(),
  ms: z.number().int().min(0),
  inputTokens: z.number().int().min(0).nullable(),
  outputTokens: z.number().int().min(0).nullable(),
  detail: z.string().max(500).nullable(),
});
export type WorkStep = z.infer<typeof WorkStep>;

/** An observation a program made about a finished task (never model text). */
export const Suggestion = z.object({
  kind: z.enum(['prompt', 'reliability', 'speed', 'cost', 'data', 'safety']),
  about: AssistantId,
  text: z.string().min(1).max(300),
});
export type Suggestion = z.infer<typeof Suggestion>;

/** What every assistant hands the HQ Manager at the end of every task: the log, the usage, the suggestions. */
export const WorkReport = z.object({
  taskId: z.uuid(),
  runId: z.uuid(),
  assistant: AssistantId,
  taskKind: z.string().min(1).max(40),
  outcome: z.enum(['done', 'failed', 'retrying']),
  summary: z.string().min(1).max(300),
  steps: z.array(WorkStep).max(30),
  usage: z.object({
    modelCalls: z.number().int().min(0),
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    codeMode: z.object({
      scripts: z.number().int().min(0),
      toolCalls: z.number().int().min(0),
      resultChars: z.number().int().min(0),
    }).optional(),
  }),
  suggestions: z.array(Suggestion).max(10),
  startedAt: Timestamp,
  endedAt: Timestamp,
});
export type WorkReport = z.infer<typeof WorkReport>;

/** A change the HQ Manager recommends; it becomes a standing lesson only when the owner adopts it by code. */
export const Recommendation = z.object({
  rank: z.number().int().min(1).max(3),
  assistant: AssistantId,
  change: z.string().min(1).max(300),
  why: z.string().min(1).max(300),
});
export type Recommendation = z.infer<typeof Recommendation>;

/** The HQ Manager's review of recent work (model output, validated before anyone sees it). */
export const ManagerReview = z.object({
  summary: z.string().min(1).max(500),
  findings: z.array(z.object({ assistant: AssistantId, text: z.string().min(1).max(300) })).max(6),
  recommendations: z.array(Recommendation).max(3),
});
export type ManagerReview = z.infer<typeof ManagerReview>;
