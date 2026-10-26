import { handleTask, type WorkerDeps } from './flows.ts';
import { flushOutbox } from './outbox.ts';

/** One claim → handle → finish cycle, then deliver whatever is queued. Returns whether work was done. */
export async function runOnce(deps: WorkerDeps): Promise<boolean> {
  const task = await deps.store.claimTask(deps.worker, deps.now());
  if (task) {
    let outcome;
    try {
      outcome = await handleTask(task, deps);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unexpected error';
      console.error(`worker.task_error ${task.id}: ${message}`);
      // Retry while attempts remain; the claim function fails it after the last attempt.
      outcome = { status: task.attempts < task.max_attempts ? ('queued' as const) : ('failed' as const), error: message };
    }
    await deps.store.finishTask(task.id, deps.worker, outcome.status, outcome.error ?? null, deps.now());
  }
  const delivered = await flushOutbox(deps);
  return Boolean(task) || delivered > 0;
}

/** Runs until there is nothing left to do (used by tests and by `npm run worker -- --once`). */
export async function runUntilIdle(deps: WorkerDeps, maxCycles = 50): Promise<number> {
  let cycles = 0;
  while (cycles < maxCycles && (await runOnce(deps))) cycles += 1;
  return cycles;
}
