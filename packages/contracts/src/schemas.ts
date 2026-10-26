import { z } from 'zod';

// Shared shapes for every lane. Lane A owns this file; other lanes request changes in
// docs/CONTRACT-REQUESTS.md. Everything that crosses a boundary (model output, HTTP, queue rows,
// files from other lanes) is parsed with these schemas before use.

export const Timestamp = z.iso.datetime({ offset: true });

export const AssistantId = z.enum(['owner', 'finance', 'salon', 'online']);
export type AssistantId = z.infer<typeof AssistantId>;

export const BusinessUnit = z.enum(['salon', 'online', 'combined']);
export type BusinessUnit = z.infer<typeof BusinessUnit>;

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

export const Intent = z.enum(['request', 'status', 'unknown']);
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
});
export type Receipt = z.infer<typeof Receipt>;
