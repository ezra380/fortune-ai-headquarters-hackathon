import type { Receipt } from '@fahq/contracts';
import { handleTask, type Outcome, type WorkerDeps } from './flows.ts';
import { flushOutbox } from './outbox.ts';
import { buildWorkReport } from './reports.ts';
import type { TaskRow } from './store.ts';

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
    try {
      outcome = await handleTask(task, tracked);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unexpected error';
      console.error(`worker.task_error ${task.id}: ${message}`);
      // Retry while attempts remain; the claim function fails it after the last attempt.
      outcome = { status: task.attempts < task.max_attempts ? ('queued' as const) : ('failed' as const), error: message };
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
