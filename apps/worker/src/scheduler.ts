import { randomUUID } from 'node:crypto';
import { allReported, briefKey, enqueueBrief } from './brief.ts';
import { errorText, receipt, type WorkerDeps } from './common.ts';
import { ROUND_DEPARTMENTS } from './departments.ts';
import { easternClock, enqueueDigest, enqueuePartialDigest } from './digest.ts';

// The daily clock. Once a day, in New York time, the worker queues the day's work for the assistants:
//   08:00  the three division briefs        08:30  the CEO digest
// Queuing is idempotent by key (the same job for the same day is never a second task), so a worker that restarts,
// two workers, or a missed minute cannot double anything. A job that was due while the worker was down is still queued
// when it comes back, but only within a few hours of its time: a worker started in the evening does not send the
// morning's briefs. The loop only enqueues; the claim loops do the work.
// The digest is not queued ahead of briefs that are still being worked on (a worker started at 09:00 finds both jobs due at
// once, and a digest takes milliseconds where a brief takes minutes): the job answers "waiting" and is asked again at every
// tick. It goes when all three reports are in (the third brief queues it too, under the same key), or as a PARTIAL digest when
// the missing briefs have stopped for good or have been open for two hours.

export type ScheduledJob = {
  /** Shown in the receipt. */
  name: string;
  /** New York time, HH:MM. */
  at: string;
  /** Queues the job for that day (YYYY-MM-DD). Must be idempotent by key. A job that is not ready answers { waiting } with the plain reason, and is asked again at the next tick. */
  enqueue(deps: Pick<WorkerDeps, 'store' | 'now'>, date: string): Promise<void | { waiting: string }>;
};

/** The digest waits for the day's briefs for at most this long after they were queued; after it, the digest goes with whatever is in. */
export const DIGEST_WAITS_MINUTES = 120;

/**
 * The 08:30 job. All three reports in: the day's complete digest (the third brief queued it already; same key). Some
 * missing: wait while any of the day's briefs is queued, running or waiting, but no longer than `waitsMinutes` after they
 * were queued; otherwise queue the partial digest, because nothing more is coming (or no longer in time) and the owner
 * should hear what is in. The wait is counted from when the briefs were queued, so a worker started late still waits.
 */
export async function enqueueDayDigest(deps: Pick<WorkerDeps, 'store' | 'now'>, date: string, waitsMinutes: number = DIGEST_WAITS_MINUTES): Promise<void | { waiting: string }> {
  if (await allReported(deps, date)) return enqueueDigest(deps, date);
  const { open, since } = await deps.store.openTasksByKey(ROUND_DEPARTMENTS.map((division) => briefKey(division, date)));
  if (open > 0 && since && deps.now().getTime() < since.getTime() + waitsMinutes * 60_000) return { waiting: `${open} of the day's briefs are still being worked on` };
  return enqueuePartialDigest(deps, date);
}

/**
 * The jobs, in the order they run. Another lane adds its own here (the HQ Manager's daily review, say): a job needs
 * a name, a time and an `enqueue` that queues a task with a key that names the day.
 */
export const SCHEDULE: ScheduledJob[] = [
  { name: 'division-briefs', at: '08:00', enqueue: async (deps, date) => { for (const division of ROUND_DEPARTMENTS) await enqueueBrief(deps, division, date); } },
  { name: 'ceo-digest', at: '08:30', enqueue: (deps, date) => enqueueDayDigest(deps, date) },
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
 * tried again at the next tick; a job that is waiting is tried again at the next tick too, and its wait is reported once.
 * Returns the names of the jobs queued now.
 */
export async function runDueJobs(deps: WorkerDeps, queued: Set<string>, jobs: readonly ScheduledJob[] = SCHEDULE): Promise<string[]> {
  const ran: string[] = [];
  for (const { job, date } of dueJobs(deps.now(), jobs)) {
    const mark = `${job.name}@${date}`;
    if (queued.has(mark)) continue;
    const base = { runId: randomUUID(), started: deps.now() };
    let result: void | { waiting: string };
    try {
      result = await job.enqueue(deps, date);
    } catch (error) {
      console.error(`scheduler.job_failed ${job.name}`);
      await note(deps, { ...base, outcome: 'failed', detail: `${job.name} for ${date}: ${errorText(error, 'could not be queued')}` });
      continue;
    }
    if (result) {
      const said = `${mark}:waiting`; // report the wait once, not at every tick
      if (!queued.has(said)) {
        queued.add(said);
        await note(deps, { ...base, outcome: 'ok', detail: `${job.name} for ${date} is waiting: ${result.waiting}` });
      }
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
