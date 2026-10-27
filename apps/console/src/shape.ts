import { MANAGERS, WeeklyReport, WORKER_IDS, WorkerReport, workerDivision } from '@fahq/contracts';
import type { Metric, WorkerId } from '@fahq/contracts';
import { formatValue, keyMetrics, longDate, projectionLine, rowKey, rowValue, sourceText, WORKER_LABEL } from '@fahq/delivery';
import { weekStart } from './days.ts';
import type {
  DepartmentInfo, DepartmentView, ManagerBlock, RawDepartment, RawManager, RawRecommendation, RawReview,
  RawUsageRow, RawWorkReport, RecommendationView, ReportView, ReviewView, UsageCounts,
} from './departments.ts';
import { USAGE_WINDOW_HOURS } from './departments.ts';
import type {
  ActionState, ActionView, BriefDivision, BriefPart, BriefStatusView, BriefView, DigestView, DivisionBlock, DivisionsView, NumberView, RawActionDecision,
  RawBriefRow, RawDigest, RawDivisionReports, RawDivisionState, RawDivisions, RawReply, RawRequest, RawWeeklyReportRow, RawWorkerReportRow,
  ReportsBlock, ReportsPart, RequestView, WeeklyOptionView, WeeklyView, WorkerDayView, WorkerReportView, WorkerSlotView,
} from './divisions.ts';
import { BRIEF_DIVISIONS, isBriefDivision } from './divisions.ts';
import { cleanText, clip, maskNumber } from './scrub.ts';

// Turns what a data source returned into what the owner may see. Only known fields are copied (an
// unknown field, such as a code hash, is dropped, never passed along), every text is cleaned, and
// every list is cut to a small size. This file is the one place that decides what leaves the server.

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
const rows = <T>(list: readonly T[] | undefined, max: number): T[] => (Array.isArray(list) ? list.slice(0, max) : []);

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

const LIMITS = {
  tasks: 15, mailbox: 15, approvals: 15, outbox: 15, receipts: 30, memory: 10, timeline: 30, notes: 8,
  reports: 15, managerReports: 30, suggestions: 5, findings: 6, recommendations: 3, lessons: 20, usageRows: 5000,
};

// ---- jsonb columns: checked, never trusted. A bad shape becomes one plain note, never a crash. ----

const NOTES = {
  usage: 'Some work reports have usage details that could not be read, so those details are left out.',
  suggestions: 'Some work-report suggestions could not be read and are left out.',
  review: 'The latest review could not be read in full (unexpected shape). What could not be read is left out.',
  findings: 'Some findings in the latest review could not be read and are left out.',
  status: 'Some recommendations have a status this console does not know. They are shown as unknown.',
  brief: 'A brief could not be read in full (unexpected shape). What could not be read is left out.',
  briefStatus: 'A brief has a status this console does not know. It is shown as unknown.',
  requests: 'Some data requests could not be read and are left out.',
  answers: 'Some answers to data requests could not be read. Those requests are shown as unreadable.',
  digest: 'The latest digest could not be read in full (unexpected shape). What could not be read is left out.',
  workerReports: 'Some worker reports could not be read in full (unexpected shape). They are shown as unreadable.',
  weekly: 'A weekly report could not be read in full (unexpected shape). It is not shown.',
} as const;
type NoteKey = keyof typeof NOTES;
type Flag = (key: NoteKey) => void;

/** jsonb normally arrives parsed; JSON text is parsed too. Anything unreadable comes back undefined. */
const parsed = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return undefined;
  }
};

/** The report's own column when it has one; the usage jsonb is only the fallback. Both are counts, never text. */
const countOr = (primary: unknown, fallback: unknown): number => whole(primary === null || primary === undefined ? fallback : primary);

function shapeReport(r: RawWorkReport, flag: Flag): ReportView {
  const usage = parsed(r.usage);
  const usageRecord = isRecord(usage) ? usage : null;
  if (!usageRecord) flag('usage');
  let codeMode: ReportView['codeMode'] = null;
  if (usageRecord && usageRecord.codeMode !== undefined && usageRecord.codeMode !== null) {
    const cm = usageRecord.codeMode;
    if (isRecord(cm)) codeMode = { scripts: whole(cm.scripts), toolCalls: whole(cm.toolCalls), resultChars: whole(cm.resultChars) };
    else flag('usage');
  }

  const rawSuggestions = parsed(r.suggestions);
  const suggestions: ReportView['suggestions'] = [];
  if (!Array.isArray(rawSuggestions)) flag('suggestions');
  else {
    for (const item of rawSuggestions) {
      const t = isRecord(item) ? text(item.text, 300) : '';
      if (!isRecord(item) || t === '') {
        flag('suggestions');
        continue;
      }
      if (suggestions.length < LIMITS.suggestions) suggestions.push({ kind: text(item.kind, 20), about: text(item.about, 20), text: t });
    }
  }

  const started = iso(r.started_at);
  const ended = iso(r.ended_at);
  return {
    taskId: shortId(r.task_id),
    assistant: text(r.assistant_id, 20),
    taskKind: text(r.task_kind, 40),
    outcome: text(r.outcome, 20),
    summary: text(r.summary, 300),
    modelCalls: countOr(r.model_calls, usageRecord?.modelCalls),
    inputTokens: countOr(r.input_tokens, usageRecord?.inputTokens),
    outputTokens: countOr(r.output_tokens, usageRecord?.outputTokens),
    durationMs: started && ended ? Math.max(0, new Date(ended).getTime() - new Date(started).getTime()) : null,
    endedAt: ended,
    codeMode,
    suggestions,
  };
}

const zeroCounts = (): UsageCounts => ({ tasks: 0, done: 0, failed: 0, retrying: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0 });
const LIVE_ASSISTANTS = ['owner', 'finance', 'online', 'manager', 'legal', 'salon'];

/** The last day of finished work, added up per assistant. Every live assistant has a row, even at zero. */
function shapeUsage(source: readonly RawUsageRow[]): NonNullable<ManagerBlock['usage']> {
  const by = new Map<string, UsageCounts>(LIVE_ASSISTANTS.map((id) => [id, zeroCounts()]));
  const total = zeroCounts();
  for (const r of source.slice(0, LIMITS.usageRows)) {
    const id = text(r.assistant_id, 20) || 'unknown';
    const mine = by.get(id) ?? zeroCounts();
    by.set(id, mine);
    for (const c of [mine, total]) {
      c.tasks += 1;
      if (r.outcome === 'done') c.done += 1;
      else if (r.outcome === 'failed') c.failed += 1;
      else if (r.outcome === 'retrying') c.retrying += 1;
      c.modelCalls += whole(r.model_calls);
      c.inputTokens += whole(r.input_tokens);
      c.outputTokens += whole(r.output_tokens);
    }
  }
  const order = (id: string): number => {
    const i = LIVE_ASSISTANTS.indexOf(id);
    return i < 0 ? 99 : i;
  };
  const ids = [...by.keys()].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  return { windowHours: USAGE_WINDOW_HOURS, rows: ids.map((id) => ({ assistant: id, ...by.get(id)! })), total };
}

const RECOMMENDATION_STATUSES = ['proposed', 'adopted', 'expired'] as const;

function shapeRecommendation(r: RawRecommendation, flag: Flag): RecommendationView {
  const known = (RECOMMENDATION_STATUSES as readonly string[]).includes(r.status);
  if (!known) flag('status');
  return {
    rank: typeof r.rank === 'number' && Number.isFinite(r.rank) ? whole(r.rank) : null,
    assistant: text(r.assistant_id, 20),
    change: text(r.change, 300),
    why: text(r.why, 300),
    status: known ? (r.status as RecommendationView['status']) : 'unknown',
    decidedAt: iso(r.decided_at),
  };
}

function shapeReview(r: RawReview, recommendations: readonly RawRecommendation[], flag: Flag): ReviewView {
  const body = parsed(r.review);
  let summary: string | null = null;
  const findings: ReviewView['findings'] = [];
  if (!isRecord(body)) flag('review');
  else {
    summary = maybeText(body.summary, 500);
    if (summary === null) flag('review');
    if (Array.isArray(body.findings)) {
      for (const f of body.findings) {
        const t = isRecord(f) ? text(f.text, 300) : '';
        if (!isRecord(f) || t === '') flag('findings');
        else if (findings.length < LIMITS.findings) findings.push({ assistant: text(f.assistant, 20), text: t });
      }
    } else if (body.findings !== undefined) flag('findings');
  }
  const recs = rows(recommendations, LIMITS.recommendations)
    .map((x) => shapeRecommendation(x, flag))
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  return {
    createdAt: iso(r.created_at),
    coversFrom: iso(r.covers_from),
    coversTo: iso(r.covers_to),
    reportCount: whole(r.report_count),
    model: maybeText(r.model, 120),
    summary,
    findings,
    recommendations: recs,
  };
}

function shapeManager(m: RawManager | undefined, flag: Flag): ManagerBlock {
  const raw: RawManager = m ?? { usageRows: [], review: null, recommendations: [], lessons: [], unread: [] };
  // A standing lesson is an adopted recommendation, newest first, whatever order the source used.
  const lessons = rows(raw.lessons, LIMITS.lessons * 2)
    .filter((l) => l.status === 'adopted')
    .map((l) => ({ assistant: text(l.assistant_id, 20), change: text(l.change, 300), adoptedAt: iso(l.decided_at) }))
    .sort((a, b) => (b.adoptedAt ?? '').localeCompare(a.adoptedAt ?? ''))
    .slice(0, LIMITS.lessons);
  return {
    usage: raw.usageRows === null ? null : shapeUsage(Array.isArray(raw.usageRows) ? raw.usageRows : []),
    review: raw.review ? shapeReview(raw.review, raw.recommendations, flag) : null,
    lessons,
    unread: rows(raw.unread, 3),
  };
}

export function shapeDepartment(raw: RawDepartment, info: DepartmentInfo, now: Date): DepartmentView {
  const flagged = new Set<NoteKey>();
  const flag: Flag = (key) => {
    flagged.add(key);
  };
  const isManager = info.id === 'manager';
  // Each live tab shows its own assistant's latest 15 reports; the HQ Manager sees the latest 30 of all of them.
  const reports = rows(raw.reports, isManager ? LIMITS.managerReports : LIMITS.reports).map((r) => shapeReport(r, flag));
  const manager = isManager ? shapeManager(raw.manager, flag) : undefined;

  return {
    id: info.id,
    name: info.name,
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
        inputTokens: count(r.input_tokens),
        outputTokens: count(r.output_tokens),
      };
    }),
    reports,
    ...(manager ? { manager } : {}),
    memory: rows(raw.decisions, LIMITS.memory).map((d) => ({
      text: text(d.content, 400),
      tags: rows(d.tags, 8).filter((t): t is string => typeof t === 'string').map((t) => text(t, 60)),
    })),
    timeline: rows(raw.timeline, LIMITS.timeline).map((e) => ({
      id: text(e.id, 60),
      type: text(e.type, 60),
      at: iso(e.at),
    })),
    // The source's own notes first, then one plain line for each kind of unreadable jsonb found while shaping.
    notes: [...rows(raw.notes, LIMITS.notes).map((n) => text(n, 300)), ...[...flagged].map((k) => NOTES[k])]
      .filter((n) => n !== '')
      .slice(0, LIMITS.notes),
  };
}

// ---- The Divisions view ---------------------------------------------------------------------------------
// The same rules as above: known fields only, every text cleaned and cut, jsonb checked (a bad shape becomes a note, never a
// crash), and a part that could not be read says so instead of showing as empty. Who approved an action is never read.

const BRIEF_STATUSES = ['normal', 'watch', 'act'] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DIGEST_STATES = ['in', 'missing', 'unreadable'] as const;
const SHOWN = { findings: 4, actions: 3, cites: 8, requestsEach: 10, digestText: 600 };
/** A cleaned, cut and trimmed text: a question of only spaces is no question. */
const said = (v: unknown, max: number): string => text(v, max).trim();
const listed = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);

const briefStatus = (v: unknown, flag: Flag): BriefStatusView => {
  if ((BRIEF_STATUSES as readonly unknown[]).includes(v)) return v as BriefStatusView;
  flag('briefStatus');
  return 'unknown';
};

/** Metric ids a finding or action rests on. */
const citedIds = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, SHOWN.cites).map((x) => said(x, 80)).filter((x) => x !== '') : [];

/**
 * Where each action of a brief stands. An action the head approved is approved, whatever became of the code. The rest
 * follow the newest code: waiting, ended (a waiting code whose time has passed is shown as expired, because the database only
 * marks it when someone tries it), locked, or already used for other actions of the same brief.
 */
function actionApproval(rank: number, d: Pick<RawDivisionState, 'approval' | 'unread'>, approvedAt: ReadonlyMap<number, string | null>, now: Date): ActionView['approval'] {
  const approved = approvedAt.get(rank);
  if (approved !== undefined) return { state: 'approved', at: approved };
  if (listed(d.unread, 5).includes('actions')) return { state: 'unknown', at: null };
  const code = d.approval;
  if (!code) return { state: 'no_code', at: null };
  const ends = iso(code.expires_at);
  const state = (s: ActionState, at: string | null): ActionView['approval'] => ({ state: s, at });
  switch (code.status) {
    case 'pending': return ends !== null && new Date(ends).getTime() <= now.getTime() ? state('code_expired', ends) : state('awaiting', ends);
    case 'expired': return state('code_expired', ends);
    case 'locked': return state('code_locked', null);
    case 'signed':
    case 'declined': return state('not_approved', iso(code.decided_at));
    default: return state('unknown', null);
  }
}

/** The actions or paths the head approved, from the notes the HQ Manager was sent (rank and verdict only, never who decided). */
function approvedAtOf(decisions: readonly RawActionDecision[] | undefined): Map<number, string | null> {
  const approvedAt = new Map<number, string | null>();
  for (const x of rows(decisions, SHOWN.actions * 4)) {
    if (!isRecord(x)) continue;
    const b = parsed(x.body);
    if (isRecord(b) && b.verdict === 'approved' && whole(b.rank) >= 1) approvedAt.set(whole(b.rank), iso(x.created_at));
  }
  return approvedAt;
}

function shapeBrief(d: RawDivisionState, now: Date, flag: Flag): BriefView | null {
  const r: RawBriefRow | null = d.brief;
  if (!r) return null;
  const body = parsed(r.brief);
  const rec = isRecord(body) ? body : null;
  if (!rec) flag('brief');

  const headline = said(rec?.headline, 160);
  if (rec && headline === '') flag('brief');

  const findings: BriefView['findings'] = [];
  if (rec) {
    if (!Array.isArray(rec.findings)) flag('brief');
    else {
      for (const f of rec.findings) {
        const t = isRecord(f) ? said(f.text, 300) : '';
        if (!isRecord(f) || t === '') flag('brief');
        else if (findings.length < SHOWN.findings) findings.push({ text: t, cites: citedIds(f.cites) });
      }
    }
  }

  const approvedAt = approvedAtOf(d.decisions);

  const actions: ActionView[] = [];
  if (rec) {
    if (!Array.isArray(rec.actions)) flag('brief');
    else {
      for (const a of rec.actions) {
        const rank = isRecord(a) ? whole(a.rank) : 0;
        const title = isRecord(a) ? said(a.title, 80) : '';
        if (!isRecord(a) || rank < 1 || rank > 3 || title === '') flag('brief');
        else if (actions.length < SHOWN.actions) {
          actions.push({ rank, title, why: said(a.why, 300), steps: said(a.steps, 300), cites: citedIds(a.cites), approval: actionApproval(rank, d, approvedAt, now) });
        }
      }
    }
  }
  actions.sort((a, b) => a.rank - b.rank);

  return {
    date: DAY.test(r.brief_date) ? r.brief_date : null,
    createdAt: iso(r.created_at),
    status: briefStatus(r.status, flag),
    writtenBy: r.written_by === 'model' || r.written_by === 'rule' ? r.written_by : 'unknown',
    headline,
    findings,
    actions,
    ceoLine: said(r.ceo_line, 140),
  };
}

/** Every data request between two divisions with its answer (matched by the request it replies to), newest first. */
function shapeRequests(raw: RawDivisions, flag: Flag): RequestView[] {
  const answers = new Map<string, RawReply>();
  for (const a of rows(raw.replies, 200)) if (typeof a.reply_to === 'string') answers.set(a.reply_to, a);
  const answersUnread = listed(raw.unread, 5).includes('replies');

  const out: RequestView[] = [];
  for (const q of rows<RawRequest>(raw.requests, 100)) {
    const body = parsed(q.body);
    const question = isRecord(body) && body.type === 'data_request' ? said(body.question, 300) : '';
    if (!isBriefDivision(q.from_assistant) || !isBriefDivision(q.to_assistant) || question === '') {
      flag('requests');
      continue;
    }
    const answer = answers.get(q.id);
    let state: RequestView['state'] = 'unanswered';
    let reason: string | null = null;
    if (answersUnread) state = 'unreadable';
    else if (answer) {
      if (answer.ok === true || answer.ok === 'true') state = 'answered';
      else if (answer.ok === false || answer.ok === 'false') {
        state = 'unavailable';
        reason = said(answer.reason, 200) || null;
      } else {
        state = 'unreadable';
        flag('answers');
      }
    }
    out.push({
      from: q.from_assistant,
      to: q.to_assistant,
      question,
      askedAt: iso(q.created_at),
      answeredAt: answer && state !== 'unreadable' ? iso(answer.created_at) : null,
      state,
      reason,
    });
  }
  return out.sort((a, b) => (b.askedAt ?? '').localeCompare(a.askedAt ?? ''));
}

function shapeDigest(d: RawDigest | null, flag: Flag): DigestView | null {
  if (!d) return null;
  const body = parsed(d.body);
  const words = isRecord(body) && body.type === 'ceo_digest' ? said(body.text, SHOWN.digestText) : '';
  if (!isRecord(body) || words === '') {
    flag('digest');
    return null;
  }
  const reports: DigestView['reports'] = [];
  if (!Array.isArray(body.reports)) flag('digest');
  else {
    for (const x of body.reports) {
      if (!isRecord(x) || !isBriefDivision(x.division) || !(DIGEST_STATES as readonly unknown[]).includes(x.state)) flag('digest');
      else if (reports.length < BRIEF_DIVISIONS.length) {
        reports.push({ division: x.division, state: x.state as DigestView['reports'][number]['state'], status: x.state === 'in' ? briefStatus(x.status, flag) : null });
      }
    }
  }
  return { date: typeof body.date === 'string' && DAY.test(body.date) ? body.date : null, createdAt: iso(d.created_at), text: words, reports };
}

// ---- Wave 2: each division's manager, its workers' daily reports and its weekly report -------------------------
// The stored reports are checked against their contracts (packages/contracts/src/reports.ts); a report in another shape is
// shown as unreadable with a note, never as missing. Numbers are written by their unit with the same words the PDF uses, and
// each one keeps the metric id it traces to. Ids are passed on only when they are well-formed, because the PDF link is built
// from them.

const SHOWN_REPORTS = { workerFindings: 5, rules: 6, rowTotals: 12, rowReads: 4, weekDays: 7, sections: 8, asked: 4, optionNumbers: 12, steps: 6, projections: 6, risks: 5 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const rowId = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);
const plainNumber = (v: number): string => v.toLocaleString('en-US', { maximumFractionDigits: 2 });

const numberView = (m: Pick<Metric, 'id' | 'label' | 'value' | 'unit'>): NumberView => ({ id: said(m.id, 80), label: said(m.label, 120), shown: said(formatValue(m), 40) });

/** A number a report cites, looked up in the numbers it holds. One it does not hold keeps its id, with the value given when there is one. */
function citedNumber(id: string, metrics: ReadonlyMap<string, Metric>, given?: number): NumberView {
  const m = metrics.get(id);
  if (m) return numberView(m);
  return { id: said(id, 80), label: said(id, 80), shown: given === undefined ? '' : plainNumber(given) };
}

function workerReportView(row: RawWorkerReportRow, report: WorkerReport): WorkerReportView {
  const { shown, more } = keyMetrics(report);
  return {
    id: rowId(row.id),
    day: report.day,
    period: said(report.period, 40),
    createdAt: iso(row.created_at),
    status: report.status,
    writtenBy: report.writtenBy,
    headline: said(report.headline, 160),
    findings: report.findings.slice(0, SHOWN_REPORTS.workerFindings).map((f) => ({ text: said(f.text, 300), cites: citedIds(f.cites) })),
    rules: report.attention.slice(0, SHOWN_REPORTS.rules).map((a) => ({ level: a.level, rule: said(a.rule, 200), metricId: said(a.metricId, 80) })),
    numbers: shown.map(numberView),
    moreNumbers: more,
    rows: report.rows.slice(0, SHOWN_REPORTS.rowReads).map((r) => ({
      read: said(r.read, 40),
      totals: Object.entries(r.totals).slice(0, SHOWN_REPORTS.rowTotals).map(([key, value]) => ({ label: said(rowKey(key), 60), shown: said(rowValue(key, value), 40) })),
    })),
    source: said(sourceText(report), 200),
  };
}

const DAY_OF_REPORT = /^\d{4}-\d{2}-\d{2}$/;
/** Newest first: the company day, then when it was written (a run asked for by hand the same day is newer). */
const newestFirst = (a: RawWorkerReportRow, b: RawWorkerReportRow): number =>
  String(b.report_date).localeCompare(String(a.report_date)) || String(b.created_at).localeCompare(String(a.created_at));

function workerSlot(worker: WorkerId, list: readonly RawWorkerReportRow[], start: string, flag: Flag): WorkerSlotView {
  const base = { workerId: worker, label: WORKER_LABEL[worker] };
  const mine = list.filter((r) => isRecord(r) && r.worker_id === worker && DAY_OF_REPORT.test(String(r.report_date))).sort(newestFirst);
  if (mine.length === 0) return { ...base, state: 'none', latest: null, stale: false, week: [] };

  // A report is checked once, whether it is the latest or one of the week; it must be the report of the worker whose row holds it.
  const checked = new Map<RawWorkerReportRow, WorkerReport | null>();
  const check = (row: RawWorkerReportRow): WorkerReport | null => {
    if (!checked.has(row)) {
      const result = WorkerReport.safeParse(parsed(row.report));
      const report = result.success && result.data.workerId === worker ? result.data : null;
      if (!report) flag('workerReports');
      checked.set(row, report);
    }
    return checked.get(row) ?? null;
  };

  const week: WorkerDayView[] = [];
  const seen = new Set<string>();
  for (const row of mine) {
    if (row.report_date < start || seen.has(row.report_date) || week.length >= SHOWN_REPORTS.weekDays) continue;
    seen.add(row.report_date);
    const report = check(row);
    if (report) week.push({ id: rowId(row.id), day: report.day, status: report.status, headline: said(report.headline, 160), writtenBy: report.writtenBy });
  }

  const newest = mine[0]!;
  const report = check(newest);
  if (!report) return { ...base, state: 'unreadable', latest: null, stale: false, week };
  return { ...base, state: 'ok', latest: workerReportView(newest, report), stale: newest.report_date < start, week };
}

/** The options the head may approve: the three paths of finance's report, or the actions of the others. */
function weeklyOptions(report: WeeklyReport, metrics: ReadonlyMap<string, Metric>, standing: (rank: number) => ActionView['approval']): WeeklyOptionView[] {
  if (report.paths) {
    return [...report.paths.plans].sort((a, b) => a.rank - b.rank).map((plan) => ({
      kind: 'path' as const,
      rank: plan.rank,
      title: said(plan.title, 90),
      why: said(plan.summary, 600),
      steps: plan.actions.slice(0, SHOWN_REPORTS.steps).map((s) => said(s, 200)),
      numbers: plan.evidence.slice(0, SHOWN_REPORTS.optionNumbers).map((e) => citedNumber(e.metricId, metrics, e.value)),
      projections: plan.projections.slice(0, SHOWN_REPORTS.projections).map((p) => ({
        text: said(projectionLine(p, metrics.get(p.baseMetricId)), 300),
        assumption: said(p.assumption, 300),
      })),
      test: said(plan.test, 300),
      stopLoss: said(plan.stopLoss, 300),
      risks: plan.risks.slice(0, SHOWN_REPORTS.risks).map((r) => said(r, 200)),
      approval: standing(plan.rank),
    }));
  }
  return [...report.actions].sort((a, b) => a.rank - b.rank).map((a) => ({
    kind: 'action' as const,
    rank: a.rank,
    title: said(a.title, 80),
    why: said(a.why, 300),
    steps: [said(a.steps, 300)],
    numbers: a.cites.slice(0, SHOWN_REPORTS.optionNumbers).map((id) => citedNumber(id, metrics)),
    projections: [],
    test: null,
    stopLoss: null,
    risks: [],
    approval: standing(a.rank),
  }));
}

function shapeWeekly(division: BriefDivision, r: RawDivisionReports, now: Date, flag: Flag): WeeklyView | 'unreadable' | null {
  const row: RawWeeklyReportRow | null = isRecord(r.weekly) ? r.weekly : null;
  if (!row) return null;
  const result = WeeklyReport.safeParse(parsed(row.report));
  if (!result.success || result.data.division !== division) {
    flag('weekly');
    return 'unreadable';
  }
  const report = result.data;
  const metrics = new Map(report.metrics.map((m) => [m.id, m]));
  const sent = typeof row.message_id === 'string' && row.message_id !== '';
  // Where each path or action stands is read the way the brief's is: the newest code on the report's note, and the decisions recorded against it.
  const standing = { approval: sent && isRecord(r.approval) ? r.approval : null, unread: r.unread.includes('approvals') ? (['actions'] as BriefPart[]) : [] };
  const approvedAt = approvedAtOf(r.decisions);
  const goalMetric = report.goal ? metrics.get(report.goal.metricId) : undefined;
  const at = (value: number) => (goalMetric ? formatValue({ id: goalMetric.id, unit: goalMetric.unit, value }) : plainNumber(value));

  return {
    id: rowId(row.id),
    weekOf: report.weekOf,
    createdAt: iso(row.created_at),
    period: said(report.period, 40),
    status: report.status,
    writtenBy: report.writtenBy,
    summary: said(report.summary, 800),
    goal: report.goal
      ? { title: said(report.goal.title, 120), metric: said(goalMetric?.label ?? report.goal.metricId, 120), from: at(report.goal.from), to: at(report.goal.to), by: longDate(report.goal.by), why: said(report.goal.why, 300) }
      : null,
    options: weeklyOptions(report, metrics, (rank) => actionApproval(rank, standing, approvedAt, now)),
    sections: report.sections.slice(0, SHOWN_REPORTS.sections).map((s) => ({
      workerId: s.workerId,
      label: WORKER_LABEL[s.workerId],
      status: s.status,
      summary: said(s.summary, 500),
      numbers: s.cites.slice(0, SHOWN.cites).map((id) => citedNumber(id, metrics)),
    })),
    asked: report.asked.slice(0, SHOWN_REPORTS.asked).map((a) => ({ division: a.division, question: said(a.question, 300), answer: said(a.answer, 500), ok: a.ok })),
    ceoLine: said(report.ceoLine, 140),
    sent,
    source: said(sourceText(report), 200),
  };
}

const REPORTS_PARTS: readonly ReportsPart[] = ['workers', 'weekly', 'approvals'];

function shapeReports(division: BriefDivision, d: RawDivisionState, now: Date, flag: Flag): ReportsBlock {
  const ids = WORKER_IDS.filter((w) => workerDivision(w) === division);
  // A source that sent nothing about the reports is shown as unread, never as "no report yet".
  if (!isRecord(d.reports)) {
    return { workers: ids.map((w) => ({ workerId: w, label: WORKER_LABEL[w], state: 'unread' as const, latest: null, stale: false, week: [] })), weekly: null, unread: ['workers', 'weekly'] };
  }
  const r = d.reports;
  const list = Array.isArray(r.workerReports) ? r.workerReports : [];
  const unread = rows(r.unread, 3).filter((p): p is ReportsPart => (REPORTS_PARTS as readonly unknown[]).includes(p));
  const workersUnread = unread.includes('workers');
  const start = weekStart(now);
  const workers = ids.map((w): WorkerSlotView =>
    workersUnread ? { workerId: w, label: WORKER_LABEL[w], state: 'unread', latest: null, stale: false, week: [] } : workerSlot(w, list, start, flag));

  const found = shapeWeekly(division, { ...r, unread, decisions: Array.isArray(r.decisions) ? r.decisions : [] }, now, flag);
  const weekly = found === 'unreadable' ? null : found;
  return { workers, weekly, unread: found === 'unreadable' && !unread.includes('weekly') ? [...unread, 'weekly'] : unread };
}

/** A note names its part by division ("The Salon worker reports ..."); a head's view drops the other divisions'. */
const aboutAnother = (note: string, only: BriefDivision): boolean =>
  BRIEF_DIVISIONS.some((d) => d.id !== only && note.startsWith(`The ${d.name} `));

export function shapeDivisions(raw: RawDivisions, now: Date, only?: BriefDivision): DivisionsView {
  const flagged = new Set<NoteKey>();
  const flag: Flag = (key) => {
    flagged.add(key);
  };
  const requests = shapeRequests(raw, flag);
  const byDivision = new Map(rows(raw.divisions, 10).filter((d) => isRecord(d)).map((d) => [d.division, d]));

  const divisions: DivisionBlock[] = BRIEF_DIVISIONS.filter((info) => only === undefined || info.id === only).map((info) => {
    // A division the source did not report on is shown as unread, never as "no brief yet".
    const d: RawDivisionState = byDivision.get(info.id) ?? { division: info.id, brief: null, approval: null, decisions: [], unread: ['brief'] };
    const manager = MANAGERS[info.id];
    return {
      id: info.id,
      name: info.name,
      head: info.head,
      manager: { name: manager.manager, title: manager.title, reportsTo: manager.head },
      brief: shapeBrief(d, now, flag),
      reports: shapeReports(info.id, d, now, flag),
      asked: requests.filter((r) => r.from === info.id).slice(0, SHOWN.requestsEach),
      received: requests.filter((r) => r.to === info.id).slice(0, SHOWN.requestsEach),
      unread: rows(d.unread, 2),
    };
  });

  // Last, so a note raised by any part above is in the list.
  const digest = only ? null : shapeDigest(raw.digest, flag);
  const notes = [...rows(raw.notes, LIMITS.notes).map((n) => text(n, 300)), ...[...flagged].map((k) => NOTES[k])].filter((n) => n !== '');
  return {
    generatedAt: now.toISOString(),
    // A head's view holds its own division and nothing of the others, and no CEO digest: that is the owner's.
    ...(only ? { only } : {}),
    divisions,
    digest,
    unread: rows(raw.unread, 3).filter((p) => !only || p !== 'digest'),
    notes: (only ? notes.filter((n) => !aboutAnother(n, only)) : notes).slice(0, LIMITS.notes),
  };
}
