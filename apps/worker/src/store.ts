import { createClient } from '@supabase/supabase-js';
import type { AssistantId, ManagerReview, Receipt, Recommendation, Suggestion, WorkReport, WorkStep } from '@fahq/contracts';

// The worker's only door to the queue tables. Server-side, service role. Everything that must
// happen once goes through a unique key (dedupe_key, idempotency_key) or a conditional update.

export type TaskRow = {
  id: string;
  assistant_id: AssistantId;
  kind: 'inbound_text' | 'mailbox' | 'scheduled';
  status: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
};
export type PersonRow = { id: string; name: string; role: string; phone: string; assistant_id: AssistantId };
export type MessageRow = {
  id: string;
  from_assistant: AssistantId;
  to_assistant: AssistantId;
  kind: 'request' | 'proposal' | 'decision' | 'report';
  body: Record<string, unknown>;
  status: string;
  reply_to: string | null;
  created_at: string;
};
export type OutboxRow = {
  id: string;
  channel: 'sms' | 'print';
  to_person_id: string;
  from_assistant: AssistantId;
  body: string;
  attachment_ref: string | null;
  status: string;
  attempts: number;
};

export type WorkReportRow = {
  id: string;
  task_id: string;
  run_id: string;
  assistant_id: AssistantId;
  task_kind: string;
  outcome: 'done' | 'failed' | 'retrying';
  summary: string;
  steps: WorkStep[];
  usage: WorkReport['usage'];
  suggestions: Suggestion[];
  input_tokens: number;
  output_tokens: number;
  model_calls: number;
  started_at: string;
  ended_at: string;
};
export type ReviewRow = {
  id: string;
  review_key: string;
  task_id: string | null;
  covers_from: string;
  covers_to: string;
  report_count: number;
  review: ManagerReview;
  digest: Record<string, unknown>;
  model: string | null;
  message_id: string | null;
  created_at: string;
};
export type RecommendationRow = {
  id: string;
  review_id: string;
  rank: number;
  assistant_id: AssistantId;
  change: string;
  why: string;
  status: 'proposed' | 'adopted' | 'expired';
};
export type AdoptedRow = { recommendation_id: string; rank: number; assistant_id: AssistantId; change: string; newly_adopted: boolean };
export type AdoptedLesson = { id: string; review_id: string; assistant_id: AssistantId; change: string; decided_at: string };
export type OpenItems = { assistant: AssistantId; openTasks: number; pendingApprovals: number };
export type LatestProposal = { id: string; createdAt: string; titles: string[]; citedMetricIds: string[]; decided: boolean };
export type ApprovalAction = 'forward_plan' | 'decide_plan' | 'adopt_change';
/** One approval on a proposal, without its code: what it was for, where it stands, and (for a decision) the plan. */
export type ApprovalSummary = { action: ApprovalAction; status: 'pending' | 'signed' | 'declined' | 'expired'; planRank: number | null; expiresAt: string; decidedAt: string | null };

/**
 * How long a claimed task is the claiming loop's. A round of plans can take several minutes (three planners at
 * once, then the picker, each with a correction round), and with more than one claim loop a lease that ran out
 * mid-round would hand the same task to the other loop.
 */
const LEASE_SECONDS = 900;

const ASSISTANTS: readonly AssistantId[] = ['owner', 'finance', 'salon', 'online', 'manager'];

type Result<T> = { data: T | null; error: { message: string; code?: string } | null };

function must<T>(r: Result<T>, what: string): T {
  if (r.error) throw new Error(`${what} failed (${r.error.code ?? 'db'})`);
  return r.data as T;
}

export const redactCodes = (text: string): string => text.replace(/\b\d{6}\b/g, '••••••');

export function createStore(url: string, serviceKey: string) {
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  /** The newest proposal that is not one department's own in a round (those carry body.department). */
  const latestFinal = async () =>
    must(await db.from('assistant_messages').select('*').eq('kind', 'proposal').is('body->>department', null).order('created_at', { ascending: false }).limit(1).maybeSingle(), 'latest proposal') as MessageRow | null;

  return {
    async claimTask(worker: string, now: Date): Promise<TaskRow | null> {
      const rows = must(await db.rpc('claim_task', { p_worker: worker, p_lease_seconds: LEASE_SECONDS, p_now: now.toISOString() }), 'claim_task') as TaskRow[];
      return rows[0] ?? null;
    },
    async finishTask(id: string, worker: string, status: 'done' | 'failed' | 'waiting' | 'queued', error: string | null, now: Date) {
      return must(await db.rpc('finish_task', { p_task_id: id, p_worker: worker, p_status: status, p_error: error, p_now: now.toISOString() }), 'finish_task') as boolean;
    },
    async cancelTask(id: string, now: Date) {
      return must(await db.rpc('cancel_task', { p_task_id: id, p_now: now.toISOString() }), 'cancel_task') as boolean;
    },
    async openTaskCount(assistant: AssistantId): Promise<number> {
      const r = await db.from('tasks').select('id', { count: 'exact', head: true }).eq('assistant_id', assistant).in('status', ['queued', 'running', 'waiting']);
      if (r.error) throw new Error(`count tasks failed (${r.error.code ?? 'db'})`);
      return r.count ?? 0;
    },
    async personByPhone(phone: string): Promise<PersonRow | null> {
      return must(await db.from('people').select('*').eq('phone', phone).maybeSingle(), 'person') as PersonRow | null;
    },
    async personByAssistant(assistant: AssistantId): Promise<PersonRow> {
      return must(await db.from('people').select('*').eq('assistant_id', assistant).single(), 'person') as PersonRow;
    },
    async person(id: string): Promise<PersonRow> {
      return must(await db.from('people').select('*').eq('id', id).single(), 'person') as PersonRow;
    },
    async registeredPhones(): Promise<Set<string>> {
      const rows = must(await db.from('people').select('phone'), 'phones') as { phone: string }[];
      return new Set(rows.map((r) => r.phone));
    },
    async assistantNumber(assistant: AssistantId): Promise<string | null> {
      const row = must(await db.from('assistants').select('sms_from').eq('id', assistant).single(), 'assistant') as { sms_from: string | null };
      return row.sms_from;
    },
    async postMessage(m: { from: AssistantId; to: AssistantId; kind: MessageRow['kind']; body: Record<string, unknown>; replyTo: string | null; dedupeKey: string }): Promise<MessageRow> {
      must(await db.from('assistant_messages').upsert(
        { from_assistant: m.from, to_assistant: m.to, kind: m.kind, body: m.body, reply_to: m.replyTo, dedupe_key: m.dedupeKey },
        { onConflict: 'dedupe_key', ignoreDuplicates: true },
      ), 'post message');
      return must(await db.from('assistant_messages').select('*').eq('dedupe_key', m.dedupeKey).single(), 'read message') as MessageRow;
    },
    async message(id: string): Promise<MessageRow> {
      return must(await db.from('assistant_messages').select('*').eq('id', id).single(), 'message') as MessageRow;
    },
    async setMessageStatus(id: string, status: 'open' | 'answered' | 'closed') {
      must(await db.from('assistant_messages').update({ status }).eq('id', id), 'message status');
    },
    async enqueueTask(t: { assistant: AssistantId; kind: 'mailbox' | 'scheduled'; key: string; payload: Record<string, unknown>; now: Date }) {
      must(await db.from('tasks').upsert(
        { assistant_id: t.assistant, kind: t.kind, idempotency_key: t.key, payload: t.payload, run_after: t.now.toISOString() },
        { onConflict: 'idempotency_key', ignoreDuplicates: true },
      ), 'enqueue task');
    },
    async messageByKey(dedupeKey: string): Promise<MessageRow | null> {
      return must(await db.from('assistant_messages').select('*').eq('dedupe_key', dedupeKey).maybeSingle(), 'message') as MessageRow | null;
    },
    /**
     * Issues a code and queues the text that carries it, in one transaction keyed by the text's
     * dedupe key. If that text was already queued, nothing changes (created = false): the code the
     * person already has stays valid.
     */
    async issueApproval(a: {
      messageId: string; personId: string; action: ApprovalAction; code: string;
      from: AssistantId; smsBody: string; smsDedupeKey: string; now: Date; ttlMinutes?: number;
    }): Promise<{ created: boolean }> {
      const rows = must(await db.rpc('issue_approval', {
        p_message_id: a.messageId, p_person_id: a.personId, p_action: a.action, p_code: a.code,
        p_from_assistant: a.from, p_sms_body: a.smsBody, p_sms_dedupe_key: a.smsDedupeKey, p_ttl_minutes: a.ttlMinutes ?? 15, p_now: a.now.toISOString(),
      }), 'issue approval') as { approval_id: string | null; created: boolean }[];
      return { created: rows[0]?.created === true };
    },
    /**
     * Spends a code for one action. The same task presenting the same code again gets the original
     * outcome back (replay = true), so a retried task resumes instead of losing the approval.
     */
    async useApprovalCode(a: {
      phone: string; code: string; verdict: 'signed' | 'declined'; action: ApprovalAction;
      taskId: string; detail: Record<string, unknown>; now: Date;
    }) {
      const rows = must(await db.rpc('use_approval_code', {
        p_phone: a.phone, p_code: a.code, p_verdict: a.verdict, p_action: a.action, p_task_id: a.taskId, p_detail: a.detail, p_now: a.now.toISOString(),
      }), 'use approval code') as
        { approval_id: string | null; message_id: string | null; action: ApprovalAction | null; outcome: string; replay: boolean; approver_person_id: string | null }[];
      return rows[0] ?? { approval_id: null, message_id: null, action: null, outcome: 'refused', replay: false, approver_person_id: null };
    },
    async addOutbox(o: { channel: 'sms' | 'print'; toPersonId: string; from: AssistantId; body: string; attachmentRef: string | null; dedupeKey: string }) {
      must(await db.from('outbox').upsert(
        { channel: o.channel, to_person_id: o.toPersonId, from_assistant: o.from, body: o.body.slice(0, 1600), attachment_ref: o.attachmentRef, dedupe_key: o.dedupeKey },
        { onConflict: 'dedupe_key', ignoreDuplicates: true },
      ), 'outbox');
    },
    async pendingOutbox(limit = 10): Promise<OutboxRow[]> {
      return must(await db.from('outbox').select('*').eq('status', 'pending').order('created_at').limit(limit), 'outbox list') as OutboxRow[];
    },
    /** pending → sending, only if still pending: exactly one sender owns each item. */
    async claimOutbox(id: string, now: Date): Promise<boolean> {
      const rows = must(await db.from('outbox').update({ status: 'sending', claimed_at: now.toISOString() }).eq('id', id).eq('status', 'pending').select('id'), 'claim outbox') as { id: string }[];
      return rows.length === 1;
    },
    /** Items a crashed sender left in 'sending' (claimed before the cutoff, or before claims were timed). */
    async strandedOutbox(cutoff: Date): Promise<OutboxRow[]> {
      return must(await db.from('outbox').select('*').eq('status', 'sending').or(`claimed_at.is.null,claimed_at.lt.${cutoff.toISOString()}`).limit(20), 'stranded outbox') as OutboxRow[];
    },
    /** sending → pending for another try, after an error that happened before the provider accepted it. */
    async retryOutbox(row: OutboxRow, error: string) {
      must(await db.from('outbox').update({ status: 'pending', attempts: row.attempts + 1, last_error: error.slice(0, 500), claimed_at: null })
        .eq('id', row.id).eq('status', 'sending'), 'retry outbox');
    },
    async settleOutbox(row: OutboxRow, s: { status: 'sent' | 'failed' | 'skipped'; providerRef?: string; error?: string; now: Date }) {
      must(await db.from('outbox').update({
        status: s.status,
        provider_ref: s.providerRef ?? null,
        last_error: s.error?.slice(0, 500) ?? null,
        sent_at: s.status === 'sent' ? s.now.toISOString() : null,
        body: redactCodes(row.body),
      }).eq('id', row.id), 'settle outbox');
    },
    async receipt(r: Receipt) {
      must(await db.from('receipts').insert({
        run_id: r.runId, task_id: r.taskId, step: r.step, assistant_id: r.assistantId, live: r.live,
        model: r.model, data_source: r.dataSource, started_at: r.startedAt, ended_at: r.endedAt,
        cost_usd: r.costUsd, outcome: r.outcome, detail: r.detail,
        input_tokens: r.inputTokens ?? null, output_tokens: r.outputTokens ?? null,
      }), 'receipt');
    },

    // ---- The HQ Manager: reports, reviews, recommendations, lessons ------------------------------

    /** One report per task (unique on task_id): a retried task overwrites its report, the latest attempt wins. */
    async saveWorkReport(report: WorkReport) {
      must(await db.from('work_reports').upsert({
        task_id: report.taskId, run_id: report.runId, assistant_id: report.assistant, task_kind: report.taskKind,
        outcome: report.outcome, summary: report.summary, steps: report.steps, usage: report.usage, suggestions: report.suggestions,
        input_tokens: report.usage.inputTokens, output_tokens: report.usage.outputTokens, model_calls: report.usage.modelCalls,
        started_at: report.startedAt, ended_at: report.endedAt, updated_at: report.endedAt,
      }, { onConflict: 'task_id' }), 'save work report');
    },
    async workReports(q: { since: Date; assistant?: AssistantId; limit?: number }): Promise<WorkReportRow[]> {
      let query = db.from('work_reports').select('*').gte('ended_at', q.since.toISOString());
      if (q.assistant) query = query.eq('assistant_id', q.assistant);
      return must(await query.order('ended_at', { ascending: false }).limit(Math.min(Math.max(q.limit ?? 200, 1), 200)), 'work reports') as WorkReportRow[];
    },
    /** Inserts the review once per key (a retried task finds its own review again) and reads it back. */
    async saveManagerReview(r: {
      key: string; taskId: string | null; coversFrom: Date; coversTo: Date; reportCount: number;
      review: ManagerReview; digest: unknown; model: string;
    }): Promise<ReviewRow> {
      // The table keeps the digest as a JSON object; a script that returned a list or a number is wrapped.
      const digest = r.digest !== null && typeof r.digest === 'object' && !Array.isArray(r.digest) ? r.digest : { result: r.digest ?? null };
      must(await db.from('manager_reviews').upsert({
        review_key: r.key, task_id: r.taskId, covers_from: r.coversFrom.toISOString(), covers_to: r.coversTo.toISOString(),
        report_count: r.reportCount, review: r.review, digest, model: r.model.slice(0, 120),
      }, { onConflict: 'review_key', ignoreDuplicates: true }), 'save review');
      return must(await db.from('manager_reviews').select('*').eq('review_key', r.key).single(), 'read review') as ReviewRow;
    },
    /** The review a task already wrote, if any: a retried task reuses it instead of asking the models again. */
    async reviewByKey(key: string): Promise<ReviewRow | null> {
      return must(await db.from('manager_reviews').select('*').eq('review_key', key).maybeSingle(), 'read review') as ReviewRow | null;
    },
    async setReviewMessage(reviewId: string, messageId: string) {
      must(await db.from('manager_reviews').update({ message_id: messageId }).eq('id', reviewId), 'review message');
    },
    async saveRecommendations(reviewId: string, recs: readonly Recommendation[]): Promise<RecommendationRow[]> {
      if (recs.length > 0) {
        must(await db.from('recommendations').upsert(
          recs.map((x) => ({ review_id: reviewId, rank: x.rank, assistant_id: x.assistant, change: x.change, why: x.why })),
          { onConflict: 'review_id,rank', ignoreDuplicates: true },
        ), 'save recommendations');
      }
      return must(await db.from('recommendations').select('*').eq('review_id', reviewId).order('rank'), 'read recommendations') as RecommendationRow[];
    },
    /** Adopts the listed ranks that are still proposed; ranks already adopted come back with newly_adopted false. */
    async adoptRecommendations(reviewId: string, ranks: readonly number[], personId: string, now: Date): Promise<AdoptedRow[]> {
      return must(await db.rpc('adopt_recommendations', {
        p_review_id: reviewId, p_ranks: [...ranks], p_person_id: personId, p_now: now.toISOString(),
      }), 'adopt recommendations') as AdoptedRow[];
    },
    /** Adopted recommendations, newest first. */
    async adoptedLessons(assistant?: AssistantId, limit = 20): Promise<AdoptedLesson[]> {
      let query = db.from('recommendations').select('id, review_id, assistant_id, change, decided_at').eq('status', 'adopted');
      if (assistant) query = query.eq('assistant_id', assistant);
      return must(await query.order('decided_at', { ascending: false }).limit(Math.min(Math.max(limit, 1), 200)), 'adopted lessons') as AdoptedLesson[];
    },
    /** Open work per assistant. Counts only: never a code, a hash or a message body. */
    async openItems(now: Date): Promise<OpenItems[]> {
      const people = must(await db.from('people').select('id, assistant_id'), 'people') as { id: string; assistant_id: AssistantId }[];
      const out: OpenItems[] = [];
      for (const assistant of ASSISTANTS) {
        const tasks = await db.from('tasks').select('id', { count: 'exact', head: true }).eq('assistant_id', assistant).in('status', ['queued', 'running', 'waiting']);
        if (tasks.error) throw new Error(`count tasks failed (${tasks.error.code ?? 'db'})`);
        const ids = people.filter((p) => p.assistant_id === assistant).map((p) => p.id);
        let pending = 0;
        if (ids.length > 0) {
          const approvals = await db.from('approvals').select('id', { count: 'exact', head: true }).in('approver_person_id', ids).eq('status', 'pending').gt('expires_at', now.toISOString());
          if (approvals.error) throw new Error(`count approvals failed (${approvals.error.code ?? 'db'})`);
          pending = approvals.count ?? 0;
        }
        out.push({ assistant, openTasks: tasks.count ?? 0, pendingApprovals: pending });
      }
      return out;
    },
    /**
     * The newest proposal the owner sees and decides on: its short id, plan titles, cited metric ids, and
     * whether anyone decided on it. A department's own proposal in a round (body.department) is not it.
     */
    async latestProposal(): Promise<LatestProposal | null> {
      const row = await latestFinal();
      if (!row) return null;
      const body = row.body as { plans?: { plans?: { title?: string }[] }; metrics?: { id?: string }[] };
      const decisions = await db.from('assistant_messages').select('id', { count: 'exact', head: true }).eq('kind', 'decision').eq('body->>proposalId', row.id);
      if (decisions.error) throw new Error(`count decisions failed (${decisions.error.code ?? 'db'})`);
      return {
        id: row.id.slice(0, 8),
        createdAt: new Date(row.created_at).toISOString(),
        titles: (body.plans?.plans ?? []).map((p) => String(p.title ?? '')).filter(Boolean),
        citedMetricIds: (body.metrics ?? []).map((m) => String(m.id ?? '')).filter(Boolean),
        decided: (decisions.count ?? 0) > 0,
      };
    },
    latestFinalProposal: latestFinal,
    /**
     * A proposal by its full id or by the first characters of it. The ids are uuids, which cannot be matched by
     * prefix in the database, so the newest proposals are read and matched here (the demo holds a few).
     */
    async proposalByPrefix(prefix: string): Promise<{ proposal: MessageRow | null; ambiguous: boolean }> {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(prefix)) {
        return { proposal: must(await db.from('assistant_messages').select('*').eq('kind', 'proposal').eq('id', prefix).maybeSingle(), 'proposal') as MessageRow | null, ambiguous: false };
      }
      const rows = must(await db.from('assistant_messages').select('*').eq('kind', 'proposal').order('created_at', { ascending: false }).limit(200), 'proposals') as MessageRow[];
      const found = rows.filter((r) => r.id.startsWith(prefix));
      return { proposal: found.length === 1 ? found[0]! : null, ambiguous: found.length > 1 };
    },
    /** Every approval on a proposal (the send, and the decisions on what was sent). Never a code or its hash. */
    async approvalsOf(proposalId: string): Promise<ApprovalSummary[]> {
      const forwards = must(await db.from('assistant_messages').select('id, body').eq('kind', 'request').eq('reply_to', proposalId), 'forwards') as { id: string; body: { planRank?: unknown } }[];
      const rows = must(await db.from('approvals').select('message_id, action, status, expires_at, decided_at').in('message_id', [proposalId, ...forwards.map((f) => f.id)]).order('created_at').order('action', { ascending: false }), 'approvals') as
        { message_id: string; action: ApprovalAction; status: ApprovalSummary['status']; expires_at: string; decided_at: string | null }[];
      return rows.map((r) => {
        const rank = Number(forwards.find((f) => f.id === r.message_id)?.body.planRank);
        return {
          action: r.action, status: r.status, planRank: r.action === 'decide_plan' && Number.isInteger(rank) ? rank : null,
          expiresAt: new Date(r.expires_at).toISOString(), decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
        };
      });
    },
  };
}

export type Store = ReturnType<typeof createStore>;
