import type { WorkerDeps } from './common.ts';

// The daily manager review. The worker's loop does not schedule anything by itself: whatever does (a timer in
// main.ts, a cron, a button in the console) calls queueDailyReview once a day. It queues the same scheduled task
// the owner's REVIEW text queues, with `quiet` so a day with nothing to review sends no text. The task's key is the
// day (Eastern time), so calling it again the same day, from one process or two, queues nothing more.

const DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The key of the review for the day `now` falls in, e.g. "review:daily:2026-10-27". */
export const dailyReviewKey = (now: Date) => `review:daily:${DAY.format(now)}`;

/** Queues today's review of the last 24 hours (and of every outside report nobody has read). `queued` is false when today's was queued already. */
export async function queueDailyReview(deps: Pick<WorkerDeps, 'store' | 'now'>): Promise<{ queued: boolean; key: string }> {
  const now = deps.now();
  const key = dailyReviewKey(now);
  if ((await deps.store.taskStatusByKey(key)) !== null) return { queued: false, key };
  await deps.store.enqueueTask({ assistant: 'manager', kind: 'scheduled', key, payload: { job: 'manager_review', hours: 24, quiet: true }, now });
  return { queued: true, key };
}
