import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { openBrain } from '@fahq/brain';
import type {
  LiveDepartmentId, ManagerPart, RawApproval, RawDepartment, RawManager, RawMessage, RawOutbox, RawReceipt, RawRecommendation, RawReview,
  RawTask, RawUsageRow, RawWorkReport,
} from './departments.ts';
import { BRAIN_NOTE, USAGE_WINDOW_HOURS } from './departments.ts';

// Reads one department's data. READ ONLY, server side, with the service key (the key lives in the
// client object the caller passes in; it never appears here). Every query names its columns, and the
// columns exclude anything secret: approvals are read without code_hash, and people, inbound texts
// and the spending table are never touched. The HQ Manager's reviews and recommendations are read
// without who decided them (decided_by) and without the review's raw digest.

const LIMITS = {
  tasks: 15, mailbox: 15, approvals: 15, outbox: 15, receipts: 30, proposalIds: 100,
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
export async function readBrain(assistant: LiveDepartmentId, options: BrainOptions): Promise<BrainView> {
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

export function createCloudLoader(options: LoaderOptions): (department: LiveDepartmentId) => Promise<RawDepartment> {
  const { db, now } = options;

  return async (id) => {
    if (id !== 'owner' && id !== 'finance' && id !== 'online' && id !== 'manager') throw new Error('unknown department');
    const notes: string[] = [];
    const mine = `from_assistant.eq.${id},to_assistant.eq.${id}`; // id is one of four fixed words, never user text

    const part = async <T>(label: string, fallback: T, run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch (error) {
        notes.push(`${label} could not be read right now${error instanceof ReadError ? ` (${error.code})` : ''}.`);
        return fallback;
      }
    };

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
      part('The mailbox', null as { rows: RawMessage[]; proposals: number; proposalIds: string[] } | null, async () => {
        const rows = must<RawMessage[]>(
          await db
            .from('assistant_messages')
            .select('from_assistant,to_assistant,kind,status,created_at,body')
            .or(mine)
            .order('created_at', { ascending: false })
            .limit(LIMITS.mailbox),
        );
        const proposals = await db
          .from('assistant_messages')
          .select('id', { count: 'exact' })
          .eq('kind', 'proposal')
          .or(mine)
          .order('created_at', { ascending: false })
          .limit(LIMITS.proposalIds);
        const ids = must<{ id: string }[]>(proposals).map((p) => p.id);
        return { rows, proposals: proposals.count ?? ids.length, proposalIds: ids };
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

    // Approvals for the proposals this assistant sent or received (the code hash is never requested).
    let approvals: RawApproval[] = [];
    let pendingApprovals: number | null = null;
    const proposalIds = mailbox?.proposalIds ?? [];
    if (mailbox && proposalIds.length > 0) {
      approvals = await part('Approvals', [] as RawApproval[], async () =>
        must<RawApproval[]>(
          await db
            .from('approvals')
            .select('action,status,expires_at,decided_at')
            .in('message_id', proposalIds)
            .order('created_at', { ascending: false })
            .limit(LIMITS.approvals),
        ),
      );
      pendingApprovals = await part('The pending-approval count', null as number | null, async () =>
        mustCount(
          await db
            .from('approvals')
            .select('id', { count: 'exact', head: true })
            .in('message_id', proposalIds)
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
