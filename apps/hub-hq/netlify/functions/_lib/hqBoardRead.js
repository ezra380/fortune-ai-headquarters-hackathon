// _lib/hqBoardRead.js — reads one Fortune HQ tab from the HQ database (Fortune AI Headquarters) and shapes it into
// the board's contract (docs/fortune-hq-board.md). READ ONLY: one `begin read only` transaction per request, an
// 8-second statement timeout, every value a $n parameter (_lib/hqBoardSql.js), every piece of text cleaned
// (_lib/hqBoardText.js). A part that cannot be read becomes a note and an empty part, never a failed board.
import pkg from 'pg';
import { SQL } from './hqBoardSql.js';
import { cleanText, count, iso, isRecord, list } from './hqBoardText.js';
import { errorCode } from './quietError.js';

const { Pool } = pkg;

// The board's tabs, in order. A tab is one assistant of the HQ; `company` is Joey, the CEO assistant ('owner').
export const TABS = Object.freeze([
  { id: 'company', label: 'Joey · CEO', subtitle: 'Company' },
  { id: 'finance', label: 'George', subtitle: 'Finance' },
  { id: 'online', label: 'Georgette', subtitle: 'Online' },
  { id: 'salon', label: 'Cindy', subtitle: 'Salon' },
  { id: 'manager', label: 'HQ Manager', subtitle: 'Reviews & memory' },
  { id: 'legal', label: 'Legal Team', subtitle: 'Terms & policies' },
]);
export const TAB_IDS = Object.freeze(TABS.map((t) => t.id));
const ASSISTANT = { company: 'owner', finance: 'finance', online: 'online', salon: 'salon', manager: 'manager', legal: 'legal' };
// Who each assistant is and whom it reports to (HQ packages/contracts/src/reports.ts: CEO_ASSISTANT, MANAGERS).
const WHO = {
  company: { name: 'Joey', reportsTo: 'Ezra' },
  finance: { name: 'George', reportsTo: 'Alan' },
  online: { name: 'Georgette', reportsTo: 'Emma' },
  salon: { name: 'Cindy', reportsTo: 'Esther' },
  manager: { name: 'HQ Manager', reportsTo: 'Ezra' },
  legal: { name: 'Legal Team', reportsTo: 'Ezra' },
};
const DIVISIONS = ['finance', 'online', 'salon'];
// Every recurring worker and its label (HQ packages/delivery/src/format.ts WORKER_LABEL), in the registry's order.
const WORKERS = {
  'finance.email': 'Email', 'finance.google_ads': 'Google Ads', 'finance.meta': 'Meta ads', 'finance.amazon': 'Amazon',
  'finance.walmart': 'Walmart', 'finance.online_money': 'Online store money', 'finance.salon_money': 'Salon money',
  'online.messages': 'Messages', 'online.journey': 'Store journey', 'online.inventory': 'Stock and products',
  'online.returns_reviews': 'Returns and reviews', 'online.site_content': 'Site and blog',
  'salon.clients': 'Clients', 'salon.turnaround': 'Repairs and personalization', 'salon.appointments': 'Appointments',
};
// Said plainly on the board: this worker has no data source connected yet.
const NOT_CONNECTED = { 'salon.clients': 'No client data is connected yet.' };
const JOB_LABEL = { weekly_report: 'Weekly report', division_brief: 'Brief', ceo_digest: 'CEO digest', manager_review: 'Review' };
const KIND_LABEL = { inbound_text: 'Answer', mailbox: 'Mailbox note' };
const ROLE_LABEL = { owner: 'Owner', finance_owner: 'Finance owner', head_stylist: 'Head stylist', online_staff: 'Online staff lead' };
const TYPE_LABEL = {
  ceo_digest: 'CEO digest', division_brief: 'Division brief', weekly_report: 'Weekly report', data_request: 'Data request',
  data_reply: 'Data reply', action_decision: 'Decision', division_status: 'Division status', weekly_status: 'Weekly status',
  worker_words: 'Worker report', weekly_words: 'Weekly report', weekly_paths: 'Profit paths', data_needs: 'Data needs',
};
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,119}$/;
const TOOL = /^[a-z_]{1,60}$/;
const METRIC = /^[A-Za-z0-9._:-]{1,80}$/;

// ---- the connection ---------------------------------------------------------------------------------------------

/** @type {any} */
let pool;
// A small pool kept for warm invocations of this function (the same pattern as _lib/db.js).
function hqPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.FORTUNE_HQ_DB_URL,
      // Supabase's pooler presents a certificate outside the public CA bundle, as for the Hub's own pool (_lib/db.js).
      ssl: { rejectUnauthorized: false },
      max: 2,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
    });
    // A pooled client the pooler closes while idle must not take a warm function down with it.
    pool.on('error', () => {});
  }
  return pool;
}

/** Test seam: inject a pg-compatible pool ({ connect() -> client }) without touching the real one. */
export function setHqPool(p) { pool = p; }

/** The HQ database could not be reached (the board answers 503, never the driver's words). */
export class HqUnavailable extends Error {}

/**
 * Reads one tab inside one READ ONLY transaction.
 * @param {string} tab one of TAB_IDS (the caller has already checked it) @param {Date} now
 */
export async function readBoard(tab, now) {
  let client;
  try { client = await hqPool().connect(); }
  catch (e) { throw new HqUnavailable(errorCode(e)); }
  let broken = false;
  try {
    await client.query('begin read only');
    await client.query("set local statement_timeout = '8s'");
    /** @type {(text: string, params?: any[]) => Promise<any[]>} */
    const run = async (text, params = []) => (await client.query(text, params)).rows;
    const tabData = await readTab(run, tab, now);
    await client.query('commit');
    return tabData;
  } catch (e) {
    broken = true;
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release(broken);
  }
}

// ---- one tab ----------------------------------------------------------------------------------------------------

// One part of the tab, inside a savepoint: a part that fails is rolled back alone, named in `notes`, and replaced by
// its fallback, so one bad read never blanks the whole board. A failure to roll back (the connection is gone) throws.
function partsOf(run, notes) {
  return async (label, fallback, read) => {
    await run('savepoint hq_part');
    try {
      const value = await read();
      await run('release savepoint hq_part');
      return value;
    } catch (e) {
      await run('rollback to savepoint hq_part');
      console.error(`[hq-board] ${label} unread: ${errorCode(e)}`);
      notes.push(`${label} could not be read right now.`);
      return fallback;
    }
  };
}

/**
 * Reads and shapes one tab. `run` is (sql, params) => rows inside the caller's read-only transaction.
 * @param {(text: string, params?: any[]) => Promise<any[]>} run @param {string} tab @param {Date} now
 */
export async function readTab(run, tab, now) {
  const id = ASSISTANT[tab];
  const notes = [];
  const part = partsOf(run, notes);
  const division = DIVISIONS.includes(tab);
  const profileRow = await part('The profile', null, async () => (await run(SQL.profile, [id]))[0] ?? null);
  const head = await part('The head', null, async () => headView((await run(SQL.head, [id]))[0]));
  return {
    id: tab,
    label: TABS.find((t) => t.id === tab).label,
    profile: profileView(tab, profileRow, head),
    head,
    live: await part('Live work', { running: [], queued: [] }, async () => liveView(await run(SQL.live, [id]))),
    workers: division ? await part('The workers', [], () => readWorkers(run, tab, now)) : [],
    weekly: division ? await part('The weekly report', null, async () => weeklyView((await run(SQL.weekly, [tab]))[0])) : null,
    brief: division ? await part('The brief', null, async () => briefView((await run(SQL.brief, [tab]))[0])) : null,
    outgoing: await part('Outgoing', [], async () => (await run(SQL.outgoing, [id])).map(outgoingView)),
    history: await part('The history', [], async () => (await run(SQL.history, [id])).map(historyView)),
    memory: await part('Memory', [], () => readMemory(run, id, profileRow)),
    mailbox: await part('The mailbox', [], async () => (await run(SQL.mailbox, [id])).map((m) => mailView(m, id))),
    company: tab === 'company' ? await part('The company view', null, () => readCompany(run)) : null,
    manager: tab === 'manager' ? await part('The manager view', null, () => readManager(run, now)) : null,
    legal: tab === 'legal' ? await part('The legal view', null, () => readLegal(run, id)) : null,
    notes,
  };
}

// ---- views ------------------------------------------------------------------------------------------------------

function headView(row) {
  if (!row) return null;
  return { name: cleanText(row.name, 80), role: ROLE_LABEL[row.role] ?? null, phone: typeof row.phone === 'string' ? row.phone : null };
}

function modelsOf(models) {
  const out = {};
  if (!isRecord(models)) return out;
  for (const [job, v] of Object.entries(models)) {
    const model = isRecord(v) ? v.model : v;
    if (TOOL.test(job) && typeof model === 'string' && MODEL.test(model)) out[job] = model;
  }
  return out;
}

function profileView(tab, row, head) {
  const tabInfo = TABS.find((t) => t.id === tab);
  return {
    assistantId: ASSISTANT[tab],
    name: WHO[tab].name,
    title: cleanText(row?.title, 80) ?? tabInfo.subtitle,
    reportsTo: head?.name ?? WHO[tab].reportsTo,
    phone: typeof row?.sms_from === 'string' ? row.sms_from : null,
    models: modelsOf(row?.models),
    version: row?.version ?? null,
    updatedAt: iso(row?.updated_at),
    reads: list(row?.reads).filter((r) => typeof r === 'string' && TOOL.test(r)).slice(0, 30),
    lessonsInForce: list(row?.lessons).length,
  };
}

function taskLabel(row) {
  if (KIND_LABEL[row.kind]) return KIND_LABEL[row.kind];
  if (row.job === 'division_worker') return WORKERS[row.worker] ?? 'Worker report';
  return JOB_LABEL[row.job] ?? 'Task';
}

function liveView(rows) {
  const item = (r, since) => ({
    id: String(r.id),
    kind: String(r.kind),
    label: r.status === 'waiting' ? `${taskLabel(r)} (waiting for an approval)` : taskLabel(r),
    since: iso(since),
  });
  return {
    running: rows.filter((r) => r.status === 'running').map((r) => item(r, r.updated_at)),
    queued: rows.filter((r) => r.status !== 'running').map((r) => item(r, r.created_at)),
  };
}

const findingsOf = (v) => list(v).filter(isRecord).slice(0, 5)
  .map((f) => ({ text: cleanText(f.text, 300), cites: list(f.cites).filter((c) => typeof c === 'string' && METRIC.test(c)).slice(0, 8) }))
  .filter((f) => f.text);

const actionsOf = (v) => list(v).filter(isRecord).slice(0, 6)
  .map((a) => ({ rank: count(a.rank), title: cleanText(a.title, 90), why: cleanText(a.why, 300), steps: cleanText(a.steps, 300) }))
  .sort((a, b) => a.rank - b.rank);

function historyOf(rows) {
  const days = new Map();
  for (const r of rows) if (!days.has(r.report_date) && days.size < 7) days.set(r.report_date, r);
  return [...days.values()].map((r) => ({ reportDate: r.report_date, status: r.status, headline: cleanText(r.headline, 160) }));
}

function workerView(workerId, row, week) {
  const base = { workerId, label: WORKERS[workerId], history: historyOf(week), note: NOT_CONNECTED[workerId] ?? null };
  if (!row) return { ...base, status: null, writtenBy: null, headline: null, findings: [], reportDate: null, createdAt: null, note: base.note ?? 'No report yet.' };
  return {
    ...base,
    status: row.status,
    writtenBy: row.written_by,
    headline: cleanText(row.headline, 160),
    findings: findingsOf(row.findings),
    reportDate: row.report_date,
    createdAt: iso(row.created_at),
  };
}

// The New York date `days` before now (the HQ's company day), as YYYY-MM-DD.
function nyDate(now, days) {
  const d = new Date(now.getTime() - days * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

async function readWorkers(run, division, now) {
  const latest = await run(SQL.workerLatest, [division]);
  const week = await run(SQL.workerWeek, [division, nyDate(now, 7)]);
  return Object.keys(WORKERS).filter((w) => w.startsWith(`${division}.`)).map((w) =>
    workerView(w, latest.find((r) => r.worker_id === w), week.filter((r) => r.worker_id === w)));
}

function goalOf(g) {
  if (!isRecord(g)) return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return { title: cleanText(g.title, 120), metricId: typeof g.metricId === 'string' && METRIC.test(g.metricId) ? g.metricId : null,
    from: num(g.from), to: num(g.to), by: typeof g.by === 'string' ? g.by.slice(0, 10) : null, why: cleanText(g.why, 300) };
}

function weeklyView(row) {
  if (!row) return null;
  return {
    weekOf: row.week_of,
    status: row.status,
    summary: cleanText(row.summary, 800),
    ceoLine: cleanText(row.ceo_line, 140),
    goal: goalOf(row.goal),
    paths: list(row.plans).filter(isRecord).map((p) => ({ rank: count(p.rank), title: cleanText(p.title, 90), summary: cleanText(p.summary, 600) }))
      .sort((a, b) => a.rank - b.rank),
    actions: actionsOf(row.actions),
    sections: list(row.sections).filter(isRecord).slice(0, 8).map((s) => ({
      workerId: typeof s.workerId === 'string' && WORKERS[s.workerId] ? s.workerId : null, status: s.status ?? null, summary: cleanText(s.summary, 500),
    })),
    createdAt: iso(row.created_at),
  };
}

function briefView(row) {
  if (!row) return null;
  return { date: row.brief_date, status: row.status, headline: cleanText(row.headline, 160), actions: actionsOf(row.actions) };
}

const outgoingView = (o) => ({ id: String(o.id), channel: o.channel, to: cleanText(o.to_name, 80), preview: cleanText(o.body, 280), status: o.status, queuedAt: iso(o.created_at) });
const historyView = (o) => ({ id: String(o.id), channel: o.channel, to: cleanText(o.to_name, 80), preview: cleanText(o.body, 280), status: o.status, at: iso(o.at) });

function mailView(m, id) {
  const out = m.from_a === id;
  const typeWords = typeof m.type === 'string' ? (TYPE_LABEL[m.type] ?? cleanText(m.type.replace(/_/g, ' '), 60)) : null;
  return { direction: out ? 'out' : 'in', other: out ? m.to_a : m.from_a, kind: m.kind, preview: cleanText(m.said, 280) ?? typeWords, at: iso(m.created_at) };
}

function decisionText(d) {
  const verdict = typeof d.verdict === 'string' && d.verdict ? d.verdict : 'decided';
  const what = d.title ? `"${d.title}"` : d.rank ? `plan ${d.rank}` : '';
  return cleanText(`${verdict[0].toUpperCase()}${verdict.slice(1)} ${what}`, 300);
}

async function readMemory(run, id, profileRow) {
  const at = (r) => iso(r.created_at);
  const lessons = list(profileRow?.lessons).filter(isRecord)
    .map((l) => ({ kind: 'lesson', text: cleanText(l.text, 300), by: cleanText(l.source ?? l.by, 80), at: iso(l.adoptedAt ?? l.at) }));
  const versions = (await run(SQL.versions, [id]))
    .map((v) => ({ kind: 'version', text: cleanText(`Version ${v.version}: ${v.reason}`, 300), by: v.made_by, at: at(v) }));
  const decisions = (await run(SQL.decisions, [id])).map((d) => ({ kind: 'decision', text: decisionText(d), by: cleanText(d.by_name, 80), at: at(d) }));
  const reviews = (await run(id === 'manager' ? SQL.reviewSummaries : SQL.reviewFindings, id === 'manager' ? [] : [id]))
    .map((r) => ({ kind: 'review', text: cleanText(r.text, 300), by: 'HQ Manager', at: at(r) }));
  const notes = (await run(SQL.recommendationsFor, [id]))
    .map((r) => ({ kind: 'note', text: cleanText(`${r.change} (${r.status})`, 300), by: r.applied_by ?? 'HQ Manager', at: iso(r.at) }));
  return [...lessons, ...versions, ...decisions, ...reviews, ...notes].filter((m) => m.text)
    .sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? ''))).slice(0, 200);
}

async function readCompany(run) {
  const digest = (await run(SQL.digest))[0];
  const weekly = await run(SQL.weeklyByDivision);
  const briefs = await run(SQL.briefByDivision);
  const people = await run(SQL.heads);
  return {
    digest: digest ? { text: cleanText(digest.text, 1500), at: iso(digest.created_at) } : null,
    divisions: DIVISIONS.map((d) => {
      const w = weekly.find((r) => r.division === d);
      const b = briefs.find((r) => r.division === d);
      return {
        id: d,
        manager: WHO[d].name,
        head: cleanText(people.find((p) => p.assistant_id === d)?.name, 80) ?? WHO[d].reportsTo,
        status: b?.status ?? w?.status ?? null,
        ceoLine: cleanText(w?.ceo_line ?? b?.ceo_line, 140),
      };
    }),
  };
}

async function readManager(run, now) {
  const review = (await run(SQL.latestReview))[0];
  const recs = await run(SQL.recommendationsAll);
  const usage = await run(SQL.usage, [new Date(now.getTime() - 24 * 3_600_000).toISOString()]);
  return {
    latestReview: review ? { at: iso(review.created_at), summary: cleanText(review.summary, 800), scope: review.scope ?? null } : null,
    recommendations: recs.map((r) => ({
      assistant: r.assistant, kind: r.kind, text: cleanText(r.change, 300), status: r.status, appliedBy: r.applied_by ?? null, at: iso(r.at),
    })),
    usage: usage.map((u) => ({ assistant: u.assistant, tasks: count(u.tasks), failed: count(u.failed), modelCalls: count(u.model_calls), tokens: count(u.tokens) })),
  };
}

async function readLegal(run, id) {
  const rows = await run(SQL.doorReports, [id]);
  return { doorReports: rows.map((r) => ({ tool: cleanText(r.tool, 60), summary: cleanText(r.summary, 600), at: iso(r.created_at), reviewed: r.reviewed === true })) };
}
