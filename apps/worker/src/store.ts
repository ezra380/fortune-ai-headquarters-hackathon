import { createClient } from '@supabase/supabase-js';
import type { AssistantId, Receipt } from '@fahq/contracts';

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
};

type Result<T> = { data: T | null; error: { message: string; code?: string } | null };

function must<T>(r: Result<T>, what: string): T {
  if (r.error) throw new Error(`${what} failed (${r.error.code ?? 'db'})`);
  return r.data as T;
}

export const redactCodes = (text: string): string => text.replace(/\b\d{6}\b/g, '••••••');

export function createStore(url: string, serviceKey: string) {
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  return {
    async claimTask(worker: string, now: Date): Promise<TaskRow | null> {
      const rows = must(await db.rpc('claim_task', { p_worker: worker, p_lease_seconds: 300, p_now: now.toISOString() }), 'claim_task') as TaskRow[];
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
    async createApproval(a: { messageId: string; personId: string; action: 'forward_plan' | 'decide_plan'; code: string; now: Date }) {
      return must(await db.rpc('create_approval', { p_message_id: a.messageId, p_person_id: a.personId, p_action: a.action, p_code: a.code, p_ttl_minutes: 15, p_now: a.now.toISOString() }), 'create approval') as string;
    },
    async useApprovalCode(a: { phone: string; code: string; verdict: 'signed' | 'declined'; detail: Record<string, unknown>; now: Date }) {
      const rows = must(await db.rpc('use_approval_code', { p_phone: a.phone, p_code: a.code, p_verdict: a.verdict, p_detail: a.detail, p_now: a.now.toISOString() }), 'use approval code') as
        { approval_id: string | null; message_id: string | null; action: 'forward_plan' | 'decide_plan' | null; outcome: string }[];
      return rows[0] ?? { approval_id: null, message_id: null, action: null, outcome: 'refused' };
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
    async claimOutbox(id: string): Promise<boolean> {
      const rows = must(await db.from('outbox').update({ status: 'sending' }).eq('id', id).eq('status', 'pending').select('id'), 'claim outbox') as { id: string }[];
      return rows.length === 1;
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
      }), 'receipt');
    },
  };
}

export type Store = ReturnType<typeof createStore>;
