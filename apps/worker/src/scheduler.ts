import { randomUUID } from 'node:crypto';
import { enqueueBrief } from './brief.ts';
import { errorText, receipt, type WorkerDeps } from './common.ts';
import { ROUND_DEPARTMENTS } from './departments.ts';
import { easternClock, enqueueDigest } from './digest.ts';

// The daily clock. Once a day, in New York time, the worker queues the day's work for the assistants:
//   08:00  the three division briefs        08:30  the CEO digest (with whatever reports are in)
// Queuing is idempotent by key (the same job for the same day is never a second task), so a worker that restarts,
// two workers, or a missed minute cannot double anything. A job that was due while the worker was down is still queued
// when it comes back, but only within a few hours of its time: a worker started in the evening does not send the
// morning's briefs. The loop only enqueues; the claim loops do the work.

export type ScheduledJob = {
  /** Shown in the receipt. */
  name: string;
  /** New York time, HH:MM. */
  at: string;
  /** Queues the job for that day (YYYY-MM-DD). Must be idempotent by key. */
  enqueue(deps: Pick<WorkerDeps, 'store' | 'now'>, date: string): Promise<void>;
};

/**
 * The jobs, in the order they run. Another lane adds its own here (the HQ Manager's daily review, say): a job needs
 * a name, a time and an `enqueue` that queues a task with a key that names the day.
 */
export const SCHEDULE: ScheduledJob[] = [
  { name: 'division-briefs', at: '08:00', enqueue: async (deps, date) => { for (const division of ROUND_DEPARTMENTS) await enqueueBrief(deps, division, date); } },
  { name: 'ceo-digest', at: '08:30', enqueue: (deps, date) => enqueueDigest(deps, date) },
];

/** How long after its time a job is still queued by a worker that was not running at that time. */
export const GRACE_MINUTES = 4 * 60;

const TICK_MS = 60_000;

/** FAHQ_SCHEDULE=off turns the daily clock off (briefs and the digest are then only asked for by text). */
export const scheduleEnabled = (env: NodeJS.ProcessEnv): boolean => env.FAHQ_SCHEDULE?.trim().toLowerCase() !== 'off';

function minutesOf(at: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at);
  if (!m) throw new Error(`scheduled time "${at}" is not HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** The jobs due at this moment: their time has come (New York time) and is not more than the grace behind. */
export function dueJobs(now: Date, jobs: readonly ScheduledJob[] = SCHEDULE): { job: ScheduledJob; date: string }[] {
  const { date, minutes } = easternClock(now);
  return jobs.filter((job) => {
    const late = minutes - minutesOf(job.at);
    return late >= 0 && late < GRACE_MINUTES;
  }).map((job) => ({ job, date }));
}

/** A receipt that cannot be written is logged and never stops the clock. */
async function note(deps: WorkerDeps, r: { runId: string; started: Date; outcome: 'ok' | 'failed'; detail: string }) {
  try {
    await receipt(deps, { ...r, taskId: null, step: 'scheduler.enqueue', assistant: null });
  } catch {
    console.error('scheduler.receipt_failed');
  }
}

/**
 * Queues every job that is due and has not been queued by this process today. `queued` remembers (job, day) pairs, so
 * the minute-by-minute loop asks the database once per job per day. A job that fails is reported in a receipt and
 * tried again at the next tick. Returns the names of the jobs queued now.
 */
export async function runDueJobs(deps: WorkerDeps, queued: Set<string>, jobs: readonly ScheduledJob[] = SCHEDULE): Promise<string[]> {
  const ran: string[] = [];
  for (const { job, date } of dueJobs(deps.now(), jobs)) {
    const mark = `${job.name}@${date}`;
    if (queued.has(mark)) continue;
    const base = { runId: randomUUID(), started: deps.now() };
    try {
      await job.enqueue(deps, date);
    } catch (error) {
      console.error(`scheduler.job_failed ${job.name}`);
      await note(deps, { ...base, outcome: 'failed', detail: `${job.name} for ${date}: ${errorText(error, 'could not be queued')}` });
      continue;
    }
    queued.add(mark);
    ran.push(job.name);
    await note(deps, { ...base, outcome: 'ok', detail: `${job.name} for ${date} queued` });
  }
  return ran;
}

/** Starts the daily clock: a check now and then every minute. `stop()` ends it. */
export function startScheduler(deps: WorkerDeps, jobs: readonly ScheduledJob[] = SCHEDULE, everyMs = TICK_MS): { stop(): void } {
  const queued = new Set<string>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try {
      await runDueJobs(deps, queued, jobs);
    } catch (error) {
      console.error(`scheduler.tick_failed: ${errorText(error, 'unknown')}`);
    }
    if (stopped) return;
    timer = setTimeout(() => void tick(), everyMs);
    timer.unref();
  };
  void tick();
  return { stop: () => { stopped = true; clearTimeout(timer); } };
}
