import { screenText, type ScreenResult } from '@fahq/models';
import { fail, receipt, text, type Outcome, type WorkerDeps } from './common.ts';
import type { PersonRow, TaskRow } from './store.ts';

// The NVIDIA safety screen in front of every free text. Parsed commands (SEND, CONFIRM, ...) never reach a
// model, so they never come here. The screen runs at the same moment as the router; when it says unsafe,
// or cannot run, the router's answer is dropped and nothing is started. Fails closed (guard.ts).

export const UNSAFE_REPLY = "I can't help with that request, so nothing was started.";
export const UNAVAILABLE_REPLY = "I couldn't run the safety check just now, so nothing was started. Please try again in a minute.";

export type Screened = { off: true } | { off: false; result: ScreenResult };

/** Starts the screen. A null guard answers at once with "off"; the promise never rejects. */
export function startScreen(deps: WorkerDeps, body: string): Promise<Screened> {
  const guard = deps.guard;
  if (!guard) return Promise.resolve({ off: true });
  return screenText({ model: deps.models.nvidia, guardModel: guard.model, text: body }).then(
    (result): Screened => ({ off: false, result }),
    (): Screened => ({
      off: false,
      result: { safe: false, categories: [], model: guard.model, ms: 0, inputTokens: 0, outputTokens: 0, reason: 'the safety check could not run' },
    }),
  );
}

/** Flagged by the model, as opposed to "could not run" or "too long to screen". */
const flagged = (r: ScreenResult) => r.categories.length > 0 || (r.reason ?? '').startsWith('the safety check flagged');

/**
 * Writes the `front-door.screen` receipt and says what happens next: null = go on, otherwise the task is
 * over (the person has been told in one plain sentence). Unsafe is "refused"; a screen that could not run
 * is "failed", so the manager's report files it as a reliability problem and not a prompt problem.
 */
export async function settleScreen(
  deps: WorkerDeps,
  ctx: { runId: string; task: TaskRow; person: PersonRow; started: Date },
  screened: Screened,
): Promise<Outcome | null> {
  const base = { runId: ctx.runId, taskId: ctx.task.id, step: 'front-door.screen', assistant: ctx.person.assistant_id, started: ctx.started };
  if (screened.off) {
    await receipt(deps, { ...base, outcome: 'ok', detail: 'screen off' });
    return null;
  }
  const r = screened.result;
  const used = { model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
  if (r.safe) {
    await receipt(deps, { ...base, ...used, outcome: 'ok', detail: `safe in ${r.ms} ms` });
    return null;
  }
  const unsafe = flagged(r);
  await receipt(deps, {
    ...base, ...used, outcome: unsafe ? 'refused' : 'failed',
    detail: unsafe ? `unsafe: ${r.categories.join(', ') || 'no category named'}` : (r.reason ?? 'the safety check could not run'),
  });
  await text(deps, ctx.person, ctx.person.assistant_id, unsafe ? UNSAFE_REPLY : UNAVAILABLE_REPLY, `reply:${ctx.task.id}`);
  return fail(unsafe ? 'the safety check refused this text' : 'the safety check could not run');
}
