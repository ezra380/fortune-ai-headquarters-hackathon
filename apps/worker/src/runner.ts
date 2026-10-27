import type { Receipt } from '@fahq/contracts';
import { handleTask, type Outcome, type WorkerDeps } from './flows.ts';
import { flushOutbox } from './outbox.ts';
import { buildWorkReport } from './reports.ts';
import type { TaskRow } from './store.ts';

/** How often the lease of a task being handled is renewed (the lease itself is short: see LEASE_SECONDS). */
const LEASE_RENEW_MS = 60_000;

/**
 * Keeps the lease of a task alive while this loop handles it, by renewing it every `leaseRenewMs`. The first
 * renewal is due one interval after the claim, so a quick task never makes one. A renewal the database refuses
 * means the task is another loop's now: it is logged once and not asked for again (the finish is refused too,
 * because every loop has its own worker id). A renewal that fails for any other reason is logged and tried
 * again at the next beat. `stop` ends it; nothing is renewed, or logged, afterwards.
 */
function holdLease(task: TaskRow, deps: WorkerDeps): { stop(): void } {
  const every = deps.leaseRenewMs ?? LEASE_RENEW_MS;
  const short = task.id.slice(0, 8);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const beat = async () => {
    let lost = false;
    try {
      lost = !(await deps.store.extendLease(task.id, deps.worker, deps.now()));
    } catch {
      if (!stopped) console.error(`worker.lease_renew_failed ${short}`);
    }
    if (stopped) return;
    if (lost) {
      console.error(`worker.lease_lost ${short}`);
      return;
    }
    timer = setTimeout(() => void beat(), every);
    timer.unref();
  };
  timer = setTimeout(() => void beat(), every);
  timer.unref();
  return { stop: () => { stopped = true; clearTimeout(timer); } };
}

/** One claim → handle → finish cycle, then deliver whatever is queued. Returns whether work was done. */
export async function runOnce(deps: WorkerDeps): Promise<boolean> {
  const task = await deps.store.claimTask(deps.worker, deps.now());
  if (task) {
    const startedAt = deps.now();
    // Keep the receipts this task writes: they become its end-of-work report.
    const receipts: Receipt[] = [];
    const tracked: WorkerDeps = {
      ...deps,
      store: { ...deps.store, receipt: async (r) => { if (r.taskId === task.id) receipts.push(r); await deps.store.receipt(r); } },
    };
    let outcome: { status: Outcome['status'] | 'queued'; error?: string };
    const lease = holdLease(task, deps);
    try {
      outcome = await handleTask(task, tracked);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unexpected error';
      console.error(`worker.task_error ${task.id}: ${message}`);
      // Retry while attempts remain; the claim function fails it after the last attempt.
      outcome = { status: task.attempts < task.max_attempts ? ('queued' as const) : ('failed' as const), error: message };
    } finally {
      lease.stop();
    }
    const finished = await deps.store.finishTask(task.id, deps.worker, outcome.status, outcome.error ?? null, deps.now());
    // A report that cannot be saved is logged and never changes what happened to the task. A lost lease
    // means another worker owns the task now, and its run will write the report.
    if (finished !== false) await reportOn(task, outcome, receipts, startedAt, deps);
  }
  const delivered = await flushOutbox(deps);
  return Boolean(task) || delivered > 0;
}

async function reportOn(
  task: TaskRow, outcome: { status: Outcome['status'] | 'queued'; error?: string }, receipts: readonly Receipt[],
  startedAt: Date, deps: WorkerDeps,
) {
  try {
    const report = buildWorkReport({
      task, outcome: outcome.status === 'queued' ? 'retrying' : outcome.status, error: outcome.error ?? null,
      receipts, startedAt, endedAt: deps.now(),
    });
    await deps.store.saveWorkReport(report);
    await deps.brain.record.report({ taskId: task.id, assistant: report.assistant, outcome: report.outcome, summary: report.summary, at: report.endedAt, runId: report.runId });
  } catch {
    console.error(`worker.report_failed ${task.id.slice(0, 8)}`);
  }
}

/** Runs until there is nothing left to do (used by tests and by `npm run worker -- --once`). */
export async function runUntilIdle(deps: WorkerDeps, maxCycles = 50): Promise<number> {
  let cycles = 0;
  while (cycles < maxCycles && (await runOnce(deps))) cycles += 1;
  return cycles;
}

/**
 * `loops` claim loops in this process at once. Each takes its own task (claim_task never hands one task to
 * two loops), so work for different assistants, or one assistant's backlog, goes through in parallel.
 * Every loop is its own worker (`<worker>#<n>`): a lease belongs to the loop that claimed the task, so a loop
 * whose lease ran out cannot finish, or keep renewing, a task another loop holds now.
 * A loop that finds nothing waits (or, with `untilIdle`, ends); a failed cycle is logged and the loop goes on.
 * `maxCycles` is a hard stop on the work done over all loops, so a queue that keeps refilling cannot run for ever.
 * Returns the number of cycles that did work, over all loops.
 */
export async function runConcurrently(
  deps: WorkerDeps, loops: number, stopping: () => boolean, opts: { untilIdle: boolean; idleMs?: number; maxCycles?: number },
): Promise<number> {
  let cycles = 0;
  const loop = async (index: number) => {
    const mine: WorkerDeps = { ...deps, worker: `${deps.worker}#${index + 1}` };
    while (!stopping() && cycles < (opts.maxCycles ?? Infinity)) {
      const busy = await runOnce(mine).catch((error: unknown) => {
        console.error(`worker.loop_error: ${error instanceof Error ? error.message : 'unknown'}`);
        return false;
      });
      if (busy) cycles += 1;
      else if (opts.untilIdle) return;
      else await new Promise((resolve) => setTimeout(resolve, opts.idleMs ?? 2000));
    }
  };
  await Promise.all(Array.from({ length: loops }, (_, index) => loop(index)));
  return cycles;
}
