import type { DepartmentInfo, DepartmentView, PlaceholderView, RawDepartment } from './departments.ts';
import { SALON_MESSAGE } from './departments.ts';
import { cleanText, clip, maskNumber } from './scrub.ts';

// Turns what a data source returned into what the owner may see. Only known fields are copied (an
// unknown field, such as a code hash, is dropped, never passed along), every text is cleaned, and
// every list is cut to a small size.

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const text = (v: unknown, max: number): string => (typeof v === 'string' ? clip(cleanText(v), max) : '');
const maybeText = (v: unknown, max: number): string | null => {
  const t = text(v, max);
  return t === '' ? null : t;
};
const whole = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
};
const count = (v: unknown): number | null => (v === null || v === undefined ? null : whole(v));
const iso = (v: unknown): string | null => {
  if (typeof v !== 'string' && !(v instanceof Date)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * The first 8 characters of an id, shown as two groups of four ("3f2a-91bc"). Grouping keeps an
 * all-digit id from looking like a six-digit code (and being blanked by the code redaction).
 */
const shortId = (v: unknown): string => {
  const s = typeof v === 'string' ? v.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8) : '';
  return text(s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s, 12);
};

/** The plan titles of a proposal (body.plans.plans[].title) and nothing else of its body. */
export function planTitles(body: unknown): string[] {
  if (!isRecord(body) || !isRecord(body.plans) || !Array.isArray(body.plans.plans)) return [];
  const titles: string[] = [];
  for (const plan of body.plans.plans) {
    if (isRecord(plan)) {
      const title = text(plan.title, 120);
      if (title !== '') titles.push(title);
    }
    if (titles.length === 5) break;
  }
  return titles;
}

export function placeholderView(info: DepartmentInfo): PlaceholderView {
  return { id: info.id, name: info.name, placeholder: true, message: SALON_MESSAGE };
}

const LIMITS = { tasks: 15, mailbox: 15, approvals: 15, outbox: 15, receipts: 30, memory: 10, timeline: 30, notes: 8 };

export function shapeDepartment(raw: RawDepartment, info: DepartmentInfo, now: Date): DepartmentView {
  const rows = <T>(list: readonly T[] | undefined, max: number): T[] => (Array.isArray(list) ? list.slice(0, max) : []);

  return {
    id: info.id,
    name: info.name,
    placeholder: false,
    generatedAt: now.toISOString(),
    assistant: raw.assistant
      ? { displayName: maybeText(raw.assistant.display_name, 60), number: maskNumber(raw.assistant.sms_from) }
      : null,
    counts: {
      openTasks: count(raw.counts?.openTasks),
      proposals: count(raw.counts?.proposals),
      pendingApprovals: count(raw.counts?.pendingApprovals),
    },
    tasks: rows(raw.tasks, LIMITS.tasks).map((t) => ({
      id: shortId(t.id),
      kind: text(t.kind, 40),
      status: text(t.status, 20),
      attempts: whole(t.attempts),
      lastError: maybeText(t.last_error, 300),
      createdAt: iso(t.created_at),
    })),
    mailbox: rows(raw.messages, LIMITS.mailbox).map((m) => ({
      from: text(m.from_assistant, 20),
      to: text(m.to_assistant, 20),
      kind: text(m.kind, 20),
      status: text(m.status, 20),
      createdAt: iso(m.created_at),
      planTitles: m.kind === 'proposal' ? planTitles(m.body) : [],
    })),
    approvals: rows(raw.approvals, LIMITS.approvals).map((a) => {
      const expiresAt = iso(a.expires_at);
      // The database only marks a code expired when someone tries it, so an old waiting code is shown as expired.
      const lapsed = a.status === 'pending' && expiresAt !== null && new Date(expiresAt).getTime() <= now.getTime();
      return {
        action: text(a.action, 30),
        status: lapsed ? 'expired' : text(a.status, 20),
        expiresAt,
        decidedAt: iso(a.decided_at),
      };
    }),
    outbox: rows(raw.outbox, LIMITS.outbox).map((o) => ({
      channel: text(o.channel, 20),
      status: text(o.status, 20),
      createdAt: iso(o.created_at),
      sentAt: iso(o.sent_at),
      lastError: maybeText(o.last_error, 300),
      body: text(o.body, 600),
    })),
    receipts: rows(raw.receipts, LIMITS.receipts).map((r) => {
      const started = iso(r.started_at);
      const ended = iso(r.ended_at);
      return {
        step: text(r.step, 60),
        outcome: text(r.outcome, 20),
        model: maybeText(r.model, 120),
        dataSource: maybeText(r.data_source, 200),
        startedAt: started,
        durationMs: started && ended ? Math.max(0, new Date(ended).getTime() - new Date(started).getTime()) : null,
        detail: maybeText(r.detail, 200),
        live: typeof r.live === 'boolean' ? r.live : null,
      };
    }),
    memory: rows(raw.decisions, LIMITS.memory).map((d) => ({
      text: text(d.content, 400),
      tags: rows(d.tags, 8).filter((t): t is string => typeof t === 'string').map((t) => text(t, 60)),
    })),
    timeline: rows(raw.timeline, LIMITS.timeline).map((e) => ({
      id: text(e.id, 60),
      type: text(e.type, 60),
      at: iso(e.at),
    })),
    notes: rows(raw.notes, LIMITS.notes).map((n) => text(n, 300)).filter((n) => n !== ''),
  };
}
