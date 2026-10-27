import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { openBrain } from '@fahq/brain';
import { WORKER_IDS, workerDivision } from '@fahq/contracts';
import type { ManagedDivision, WeeklyReport, WorkerReport } from '@fahq/contracts';
import { checkedWeeklyReport, checkedWorkerReport, packetWorkers } from '@fahq/delivery';
import { weekStart } from './days.ts';
import type {
  DepartmentId, ManagerPart, RawApproval, RawDepartment, RawManager, RawMessage, RawOutbox, RawReceipt, RawRecommendation, RawReview,
  RawTask, RawUsageRow, RawWorkReport,
} from './departments.ts';
import { BRAIN_NOTE, USAGE_WINDOW_HOURS } from './departments.ts';
import type {
  BriefDivision, BriefPart, DivisionsPart, RawActionDecision, RawBriefApproval, RawBriefRow, RawDigest, RawDivisionReports, RawDivisionState,
  RawDivisions, RawReply, RawRequest, RawWeeklyReportRow, RawWorkerReportRow, ReportsPart,
} from './divisions.ts';
import { BRIEF_DIVISIONS } from './divisions.ts';

// Reads one department's data. READ ONLY, server side, with the service key (the key lives in the
// client object the caller passes in; it never appears here). Every query names its columns, and the
// columns exclude anything secret: approvals are read without code_hash, and people, inbound texts
// and the spending table are never touched. The HQ Manager's reviews and recommendations are read
// without who decided them (decided_by) and without the review's raw digest.

const LIMITS = {
  tasks: 15, mailbox: 15, approvals: 15, outbox: 15, receipts: 30, messageIds: 100,
  reports: 15, managerReports: 30, usageRows: 500, lessons: 20, recommendations: 3,
};
const OPEN_TASK_STATUSES = ['queued', 'running', 'waiting'];
// Named columns only. The step list (steps) is not read: the page shows each report's summary, counts and suggestions.
const REPORT_COLUMNS = 'task_id,assistant_id,task_kind,outcome,summary,usage,suggestions,input_tokens,output_tokens,model_calls,started_at,ended_at';
const USAGE_COLUMNS = 'assistant_id,outcome,model_calls,input_tokens,output_tokens';
const REVIEW_COLUMNS = 'id,covers_from,covers_to,report_count,review,model,created_at';
const RECOMMENDATION_COLUMNS = 'rank,assistant_id,change,why,status,decided_at';
const LESSON_COLUMNS = 'assistant_id,change,status,decided_at';

type Db = Pick<SupabaseClient, 'from'>;
type Answer<T> = { data: T | null; error: { message: string; code?: string } | null; count?: number | null };

class ReadError extends Error {
  constructor(readonly code: string) {
    super(`read failed (${code})`);
  }
}

function must<T>(answer: Answer<T>): T {
  if (answer.error) throw new ReadError(answer.error.code || 'db');
  return answer.data as T;
}

function mustCount(answer: Answer<unknown>): number {
  if (answer.error) throw new ReadError(answer.error.code || 'db');
  return answer.count ?? 0;
}

/**
 * One read that may fail without taking the rest down: a failure becomes a plain note (the part and the error code, never the
 * database's own words) and the part's fallback, so the page can say "could not be read" instead of showing it empty.
 */
function reading(notes: string[]) {
  return async <T>(label: string, fallback: T, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      notes.push(`${label} could not be read right now${error instanceof ReadError ? ` (${error.code})` : ''}.`);
      return fallback;
    }
  };
}

// ---- The brain (shared record + this assistant's memory) -------------------------------------

export type BrainView = {
  available: boolean;
  decisions: { content: string; tags: string[] }[];
  timeline: { id: string; type: string; at: string | null }[];
};

export type BrainOptions = {
  /** Where the worker keeps its brain files (<repo>/.local/brain). Never written to. */
  dataDir: string;
  /** Where the Meterless engines were fetched (<repo>/.local/meterless). */
  meterlessDir: string;
  open?: typeof openBrain;
  tmpRoot?: string;
};

/**
 * Reads the brain from a private snapshot. The brain allows exactly one writer (the worker), and
 * even a recall rewrites the memory file (it updates use counts), so the console copies the files to
 * a temporary folder, reads the copy, and deletes it. The worker's files are never opened for writing.
 * Missing or unreadable files give an empty, "not available yet" view instead of an error.
 */
export async function readBrain(assistant: DepartmentId, options: BrainOptions): Promise<BrainView> {
  const unavailable: BrainView = { available: false, decisions: [], timeline: [] };
  if (!fs.existsSync(options.dataDir)) return unavailable;
  let snapshot: string | null = null;
  try {
    snapshot = fs.mkdtempSync(path.join(options.tmpRoot ?? os.tmpdir(), 'fahq-console-brain-'));
    fs.cpSync(options.dataDir, snapshot, { recursive: true });
    const brain = await (options.open ?? openBrain)({ meterlessDir: options.meterlessDir, dataDir: snapshot, actor: 'console-reader' });
    const decisions = brain
      .memory(assistant)
      .recallDecisions('plan decision approved declined', 10)
      .map((d) => ({ content: d.memory.content, tags: [...d.memory.tags] }));
    // timeline() is oldest first; the console shows the newest first.
    const timeline = [...brain.record.timeline(30)].reverse().map((e) => ({ id: e.id, type: e.type, at: e.at ?? null }));
    return { available: true, decisions, timeline };
  } catch {
    return unavailable;
  } finally {
    if (snapshot) fs.rmSync(snapshot, { recursive: true, force: true });
  }
}

// ---- The queue tables -------------------------------------------------------------------------

export type LoaderOptions = {
  db: Db;
  now: () => Date;
  brain: BrainOptions;
};

export function createCloudLoader(options: LoaderOptions): (department: DepartmentId) => Promise<RawDepartment> {
  const { db, now } = options;

  return async (id) => {
    if (id !== 'owner' && id !== 'finance' && id !== 'online' && id !== 'manager' && id !== 'legal' && id !== 'salon') throw new Error('unknown department');
    const notes: string[] = [];
    const mine = `from_assistant.eq.${id},to_assistant.eq.${id}`; // id is one of six fixed words, never user text
    const part = reading(notes);

    // What only the HQ Manager tab shows: the last day's usage, the latest review with its recommendations,
    // and the standing lessons (adopted recommendations). A part that cannot be read is named in `unread`.
    async function readManager(): Promise<RawManager> {
      const unread: ManagerPart[] = [];
      const [usageRows, review, lessons] = await Promise.all([
        part('The last day of work reports', null as RawUsageRow[] | null, async () => {
          const cutoff = new Date(now().getTime() - USAGE_WINDOW_HOURS * 3_600_000).toISOString();
          const found = must<RawUsageRow[]>(
            await db
              .from('work_reports')
              .select(USAGE_COLUMNS)
              .gte('ended_at', cutoff)
              .order('ended_at', { ascending: false })
              .limit(LIMITS.usageRows),
          );
          // Added up here only as far as the cap; say so rather than show a quiet undercount.
          if (found.length >= LIMITS.usageRows) {
            notes.push(`More than ${LIMITS.usageRows} reports finished in the last ${USAGE_WINDOW_HOURS} hours; the usage totals cover the newest ${LIMITS.usageRows}.`);
          }
          return found;
        }),
        part('The latest review', null as { review: RawReview | null; recommendations: RawRecommendation[] } | null, async () => {
          const found = must<RawReview[]>(
            await db.from('manager_reviews').select(REVIEW_COLUMNS).order('created_at', { ascending: false }).limit(1),
          );
          const latest = Array.isArray(found) ? found[0] : undefined;
          if (!latest) return { review: null, recommendations: [] };
          const recommendations = must<RawRecommendation[]>(
            await db
              .from('recommendations')
              .select(RECOMMENDATION_COLUMNS)
              .eq('review_id', latest.id)
              .order('rank', { ascending: true })
              .limit(LIMITS.recommendations),
          );
          return { review: latest, recommendations };
        }),
        part('The standing lessons', null as RawRecommendation[] | null, async () =>
          must<RawRecommendation[]>(
            await db
              .from('recommendations')
              .select(LESSON_COLUMNS)
              .eq('status', 'adopted')
              .order('decided_at', { ascending: false, nullsFirst: false })
              .limit(LIMITS.lessons),
          ),
        ),
      ]);
      if (usageRows === null) unread.push('usage');
      if (review === null) unread.push('review');
      if (lessons === null) unread.push('lessons');
      return {
        usageRows,
        review: review?.review ?? null,
        recommendations: review?.recommendations ?? [],
        lessons: lessons ?? [],
        unread,
      };
    }

    // The HQ Manager's own reads start now so they run beside the common ones.
    const managerReads = id === 'manager' ? readManager() : null;

    const [assistant, tasks, openTasks, mailbox, outbox, receipts, reports, brain] = await Promise.all([
      part('The assistant record', null, async () =>
        must<{ display_name: string | null; sms_from: string | null } | null>(
          await db.from('assistants').select('display_name,sms_from').eq('id', id).maybeSingle(),
        ),
      ),
      part('The task list', [] as RawTask[], async () =>
        must<RawTask[]>(
          await db
            .from('tasks')
            .select('id,kind,status,attempts,last_error,created_at')
            .eq('assistant_id', id)
            .order('created_at', { ascending: false })
            .limit(LIMITS.tasks),
        ),
      ),
      part('The open-task count', null as number | null, async () =>
        mustCount(await db.from('tasks').select('id', { count: 'exact', head: true }).eq('assistant_id', id).in('status', OPEN_TASK_STATUSES)),
      ),
      part('The mailbox', null as { rows: RawMessage[]; proposals: number; approvalMessageIds: string[] } | null, async () => {
        const rows = must<RawMessage[]>(
          await db
            .from('assistant_messages')
            .select('from_assistant,to_assistant,kind,status,created_at,body')
            .or(mine)
            .order('created_at', { ascending: false })
            .limit(LIMITS.mailbox),
        );
        // Two kinds of message carry an approval: a proposal (send or decide a plan) and the HQ Manager's review,
        // which is posted to the owner as a 'report' with the ADOPT approval attached. Only proposals are counted as proposals.
        const idsOfKind = (kind: 'proposal' | 'report') =>
          db
            .from('assistant_messages')
            .select('id', { count: 'exact' })
            .eq('kind', kind)
            .or(mine)
            .order('created_at', { ascending: false })
            .limit(LIMITS.messageIds);
        const [proposals, reviews] = await Promise.all([idsOfKind('proposal'), idsOfKind('report')]);
        const proposalIds = must<{ id: string }[]>(proposals).map((p) => p.id);
        const reviewIds = must<{ id: string }[]>(reviews).map((r) => r.id);
        return { rows, proposals: proposals.count ?? proposalIds.length, approvalMessageIds: [...new Set([...proposalIds, ...reviewIds])] };
      }),
      part('Texts and printouts', [] as RawOutbox[], async () =>
        must<RawOutbox[]>(
          await db
            .from('outbox')
            .select('channel,status,created_at,sent_at,last_error,body')
            .eq('from_assistant', id)
            .order('created_at', { ascending: false })
            .limit(LIMITS.outbox),
        ),
      ),
      part('The activity log', [] as RawReceipt[], async () =>
        must<RawReceipt[]>(
          await db
            .from('receipts')
            .select('step,outcome,model,data_source,started_at,ended_at,detail,live,input_tokens,output_tokens')
            .eq('assistant_id', id)
            .order('started_at', { ascending: false })
            .limit(LIMITS.receipts),
        ),
      ),
      part('The work reports', [] as RawWorkReport[], async () => {
        // A department shows its own latest reports; the HQ Manager shows the latest across all assistants.
        const base = db.from('work_reports').select(REPORT_COLUMNS);
        const scoped = id === 'manager' ? base : base.eq('assistant_id', id);
        return must<RawWorkReport[]>(
          await scoped.order('ended_at', { ascending: false }).limit(id === 'manager' ? LIMITS.managerReports : LIMITS.reports),
        );
      }),
      readBrain(id, options.brain),
    ]);

    // Approvals for the proposals and reviews this assistant sent or received (the code hash is never requested).
    let approvals: RawApproval[] = [];
    let pendingApprovals: number | null = null;
    const approvalMessageIds = mailbox?.approvalMessageIds ?? [];
    if (mailbox && approvalMessageIds.length > 0) {
      approvals = await part('Approvals', [] as RawApproval[], async () =>
        must<RawApproval[]>(
          await db
            .from('approvals')
            .select('action,status,expires_at,decided_at')
            .in('message_id', approvalMessageIds)
            .order('created_at', { ascending: false })
            .limit(LIMITS.approvals),
        ),
      );
      pendingApprovals = await part('The pending-approval count', null as number | null, async () =>
        mustCount(
          await db
            .from('approvals')
            .select('id', { count: 'exact', head: true })
            .in('message_id', approvalMessageIds)
            .eq('status', 'pending')
            .gt('expires_at', now().toISOString()),
        ),
      );
    } else if (mailbox) {
      pendingApprovals = 0;
    }

    const manager = managerReads ? await managerReads : undefined;

    if (!brain.available) notes.push(BRAIN_NOTE);

    return {
      assistant,
      counts: { openTasks, proposals: mailbox ? mailbox.proposals : null, pendingApprovals },
      tasks,
      messages: mailbox?.rows ?? [],
      approvals,
      outbox,
      receipts,
      reports,
      ...(manager ? { manager } : {}),
      decisions: brain.decisions,
      timeline: brain.timeline,
      notes,
    };
  };
}

// ---- The Divisions view -------------------------------------------------------------------------------

const DIVISION_LIMITS = { requests: 30, replies: 100, approvals: 30, decisions: 30, workerReports: 100, weeklyDecisions: 30 };
// Named columns only. The brief row is read without its task and data-source columns; an approval without its code hash.
const BRIEF_COLUMNS = 'division,brief_key,brief_date,status,written_by,brief,ceo_line,created_at';
// The wave-2 reports are read without their task and data-source columns too: the report's own jsonb holds its data source.
const WORKER_REPORT_COLUMNS = 'id,worker_id,division,report_date,status,written_by,report,created_at';
const WEEKLY_REPORT_COLUMNS = 'id,division,week_of,status,written_by,report,ceo_line,message_id,created_at';

/**
 * Reads the Divisions view: each division's newest brief with the standing of its actions, the data requests the divisions sent
 * each other with their answers, and the newest CEO digest. READ ONLY, server side. The mailbox is read by the kind of note it
 * holds (the key it was stored under), never in bulk; an answer is read as its outcome and reason only, never the facts it carried.
 */
export function createDivisionsLoader(options: { db: Db; now?: () => Date }): (only?: BriefDivision) => Promise<RawDivisions> {
  const { db } = options;
  const now = options.now ?? (() => new Date());

  // `only` is a head's own view: that one division's brief and reports, the questions it asked or was asked, and no CEO digest.
  return async (only) => {
    const notes: string[] = [];
    const part = reading(notes);
    const shown = only ? BRIEF_DIVISIONS.filter((d) => d.id === only) : BRIEF_DIVISIONS;

    // The workers' latest reports and the weekly report of one division, and where the weekly report's paths or actions stand.
    async function readReports(d: (typeof BRIEF_DIVISIONS)[number]): Promise<RawDivisionReports> {
      const unread: ReportsPart[] = [];
      const start = weekStart(now());
      const newestFirst = <T extends { order(column: string, o: { ascending: boolean }): T }>(query: T): T =>
        query.order('report_date', { ascending: false }).order('created_at', { ascending: false });

      const [workerReports, weekly] = await Promise.all([
        part(`The ${d.name} worker reports`, null as RawWorkerReportRow[] | null, async () => {
          const recent = must<RawWorkerReportRow[]>(
            await newestFirst(db.from('worker_reports').select(WORKER_REPORT_COLUMNS).eq('division', d.id).gte('report_date', start)).limit(DIVISION_LIMITS.workerReports),
          );
          if (recent.length >= DIVISION_LIMITS.workerReports) {
            notes.push(`The ${d.name} worker reports: more than ${DIVISION_LIMITS.workerReports} were written in the last seven days; the newest ${DIVISION_LIMITS.workerReports} are read.`);
          }
          // A worker with nothing in the last seven days still shows its newest report, marked as old.
          const have = new Set(recent.map((r) => r.worker_id));
          const missing = WORKER_IDS.filter((w) => workerDivision(w) === d.id && !have.has(w));
          const older = await Promise.all(
            missing.map(async (w) => must<RawWorkerReportRow[]>(await newestFirst(db.from('worker_reports').select(WORKER_REPORT_COLUMNS).eq('worker_id', w)).limit(1))),
          );
          return [...recent, ...older.flat()];
        }),
        part(`The ${d.name} weekly report`, undefined as RawWeeklyReportRow | null | undefined, async () => {
          const list = must<RawWeeklyReportRow[]>(
            await db.from('weekly_reports').select(WEEKLY_REPORT_COLUMNS).eq('division', d.id).order('week_of', { ascending: false }).order('created_at', { ascending: false }).limit(1),
          );
          return Array.isArray(list) ? (list[0] ?? null) : null;
        }),
      ]);
      if (workerReports === null) unread.push('workers');
      if (weekly === undefined) unread.push('weekly');

      // The code and the decisions hang from the note the weekly report was sent with; no note, nothing to ask.
      let approval: RawBriefApproval | null = null;
      let decisions: RawActionDecision[] = [];
      const noteId = weekly?.message_id;
      if (noteId) {
        const [codes, decided] = await Promise.all([
          part(`The ${d.name} weekly report approvals`, null as RawBriefApproval[] | null, async () =>
            must<RawBriefApproval[]>(
              await db.from('approvals').select('status,expires_at,decided_at').eq('message_id', noteId).eq('action', 'approve_action').order('created_at', { ascending: false }).limit(1),
            ),
          ),
          part(`The ${d.name} weekly report decisions`, null as RawActionDecision[] | null, async () =>
            must<RawActionDecision[]>(
              await db
                .from('assistant_messages')
                .select('created_at,body')
                .eq('kind', 'decision')
                .like('dedupe_key', 'action-decision:%')
                .eq('reply_to', noteId)
                .limit(DIVISION_LIMITS.weeklyDecisions),
            ),
          ),
        ]);
        if (codes === null || decided === null) unread.push('approvals');
        approval = codes?.[0] ?? null;
        decisions = decided ?? [];
      }
      return { workerReports: workerReports ?? [], weekly: weekly ?? null, approval, decisions, unread };
    }

    async function readDivisions(): Promise<RawDivisionState[]> {
      const reports = await Promise.all(shown.map((d) => readReports(d)));
      // The newest brief of each division (a BRIEF text can add a second one on the same day: the later one wins).
      const found = await Promise.all(
        shown.map((d) =>
          part(`The ${d.name} brief`, undefined as RawBriefRow | null | undefined, async () => {
            const list = must<RawBriefRow[]>(
              await db
                .from('division_briefs')
                .select(BRIEF_COLUMNS)
                .eq('division', d.id)
                .order('brief_date', { ascending: false })
                .order('created_at', { ascending: false })
                .limit(1),
            );
            return Array.isArray(list) ? (list[0] ?? null) : null;
          }),
        ),
      );
      const briefs = found.flatMap((row) => (row ? [row] : []));

      // The brief's mailbox note is what its approval code hangs from; the note's key names the brief.
      const docs = briefs.length === 0
        ? []
        : await part('The briefs\' mailbox notes', null as { id: string; dedupe_key: string }[] | null, async () =>
            must<{ id: string; dedupe_key: string }[]>(
              await db.from('assistant_messages').select('id,dedupe_key').in('dedupe_key', briefs.map((b) => `briefdoc:${b.brief_key}`)).limit(10),
            ),
          );
      const docIds = (docs ?? []).map((d) => d.id);
      const [approvals, decisions] = docIds.length === 0
        ? [[] as (RawBriefApproval & { message_id: string })[], [] as { reply_to: string; created_at: string; body: unknown }[]]
        : await Promise.all([
            part('The brief approvals', null as (RawBriefApproval & { message_id: string })[] | null, async () =>
              must<(RawBriefApproval & { message_id: string })[]>(
                await db
                  .from('approvals')
                  .select('message_id,status,expires_at,decided_at')
                  .in('message_id', docIds)
                  .eq('action', 'approve_action')
                  .order('created_at', { ascending: false })
                  .limit(DIVISION_LIMITS.approvals),
              ),
            ),
            part('The approved actions', null as { reply_to: string; created_at: string; body: unknown }[] | null, async () =>
              must<{ reply_to: string; created_at: string; body: unknown }[]>(
                await db
                  .from('assistant_messages')
                  .select('reply_to,created_at,body')
                  .eq('kind', 'decision')
                  .like('dedupe_key', 'action-decision:%')
                  .in('reply_to', docIds)
                  .limit(DIVISION_LIMITS.decisions),
              ),
            ),
          ]);

      return shown.map((d, i): RawDivisionState => {
        const brief = found[i];
        if (brief === undefined) return { division: d.id, brief: null, approval: null, decisions: [], unread: ['brief'], reports: reports[i] };
        if (brief === null) return { division: d.id, brief: null, approval: null, decisions: [], unread: [], reports: reports[i] };
        const docId = docs?.find((x) => x.dedupe_key === `briefdoc:${brief.brief_key}`)?.id;
        // Reading the approvals needs the note's id: when the note or either read failed, the actions' standing is unknown.
        const unread: BriefPart[] = docs === null || approvals === null || decisions === null ? ['actions'] : [];
        return {
          division: d.id,
          brief,
          // Newest code first: the first one on this brief's note is the one that counts.
          approval: docId ? ((approvals ?? []).find((a) => a.message_id === docId) ?? null) : null,
          decisions: docId ? (decisions ?? []).filter((x) => x.reply_to === docId) : [],
          unread,
          reports: reports[i],
        };
      });
    }

    async function readRequests(): Promise<{ requests: RawRequest[]; replies: RawReply[]; unread: DivisionsPart[] }> {
      const requests = await part('The data requests', null as RawRequest[] | null, async () => {
        const asked = db
          .from('assistant_messages')
          .select('id,from_assistant,to_assistant,created_at,body')
          .eq('kind', 'request')
          .like('dedupe_key', 'datareq:%');
        // A head's view reads only the questions its own division asked or was asked (the id is one of three fixed words).
        const mine = only ? asked.or(`from_assistant.eq.${only},to_assistant.eq.${only}`) : asked;
        return must<RawRequest[]>(await mine.order('created_at', { ascending: false }).limit(DIVISION_LIMITS.requests));
      });
      if (requests === null) return { requests: [], replies: [], unread: ['requests'] };
      if (requests.length === 0) return { requests, replies: [], unread: [] };
      const replies = await part('The answers to the data requests', null as RawReply[] | null, async () =>
        must<RawReply[]>(
          await db
            .from('assistant_messages')
            // The outcome and the reason only: what the answer carried (its facts) is not read here.
            .select('reply_to,created_at,ok:body->>ok,reason:body->>reason')
            .eq('kind', 'report')
            .like('dedupe_key', 'datareply:%')
            .in('reply_to', requests.map((r) => r.id))
            .limit(DIVISION_LIMITS.replies),
        ),
      );
      return { requests, replies: replies ?? [], unread: replies === null ? ['replies'] : [] };
    }

    async function readDigest(): Promise<{ digest: RawDigest | null; unread: DivisionsPart[] }> {
      const found = await part('The latest CEO digest', null as RawDigest[] | null, async () =>
        must<RawDigest[]>(
          await db
            .from('assistant_messages')
            .select('created_at,body')
            .eq('kind', 'report')
            .eq('from_assistant', 'owner')
            .eq('to_assistant', 'owner')
            .like('dedupe_key', 'digestdoc:%')
            .order('created_at', { ascending: false })
            .limit(1),
        ),
      );
      return { digest: found?.[0] ?? null, unread: found === null ? ['digest'] : [] };
    }

    const [divisions, asked, digest] = await Promise.all([
      readDivisions(),
      readRequests(),
      // The CEO digest is the owner's: a head's view does not read it.
      only ? Promise.resolve({ digest: null as RawDigest | null, unread: [] as DivisionsPart[] }) : readDigest(),
    ]);
    return {
      divisions,
      requests: asked.requests,
      replies: asked.replies,
      digest: digest.digest,
      unread: [...asked.unread, ...digest.unread],
      notes,
    };
  };
}

// ---- The reports behind a PDF ------------------------------------------------------------------------------

export type LoadedReport =
  | { kind: 'weekly'; division: ManagedDivision; weekly: WeeklyReport; workers: WorkerReport[] }
  | { kind: 'worker'; division: ManagedDivision; worker: WorkerReport };

/** A stored report that is not in the shape its contract says (or does not agree with its own row). Never shown, never printed. */
export class ReportUnreadable extends Error {
  constructor() {
    super('the stored report is not in the shape its contract says');
  }
}

/**
 * Reads the stored reports a PDF is made from, by id: a weekly report with the worker reports it was built from (the same
 * division only, in the registry's order), or one worker's report. The checks are the delivery package's own (packet.ts), the same
 * ones the worker applies to the packet it emails and prints, so the two are always the same packet: a report that is not in its
 * shape, or is not the one its row says, is refused (a single report) or left out (a packet worker, so the cover says it could
 * not be loaded). READ ONLY, server side, named columns.
 */
export function createReportLoader(options: { db: Db }): (kind: 'weekly' | 'worker', id: string) => Promise<LoadedReport | null> {
  const { db } = options;

  return async (kind, id) => {
    if (kind === 'worker') {
      const row = must<{ worker_id: string; division: string; report: unknown } | null>(await db.from('worker_reports').select('worker_id,division,report').eq('id', id).maybeSingle());
      if (!row) return null;
      const worker = checkedWorkerReport(row);
      if (!worker) throw new ReportUnreadable();
      return { kind, division: workerDivision(worker.workerId), worker };
    }

    const row = must<{ id: string; division: string; report: unknown } | null>(await db.from('weekly_reports').select('id,division,report').eq('id', id).maybeSingle());
    if (!row) return null;
    const weekly = checkedWeeklyReport(row);
    if (!weekly) throw new ReportUnreadable();
    const stored = weekly.workerReportIds.length === 0
      ? []
      : must<{ worker_id: string; report: unknown }[]>(
          await db.from('worker_reports').select('worker_id,report').eq('division', weekly.division).in('id', weekly.workerReportIds),
        );
    return { kind, division: weekly.division, weekly, workers: packetWorkers(weekly.division, stored) };
  };
}
