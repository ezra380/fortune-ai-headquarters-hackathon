import type { WorkerDeps } from './common.ts';

// The daily manager reviews. The worker's clock (scheduler.ts, the 09:00 manager-review job) calls queueDailyReview
// once a day. It queues two scheduled tasks of the kind the owner's REVIEW text queues, each with `quiet` so a day with
// nothing to review sends no text, and each keyed by the day (Eastern time), so calling it again the same day, from one
// process or two, queues nothing more:
//  - review:daily:<day>, the internal review: the assistants' work reports only. Its digest script is never handed
//    the reader of the outside reports, so it carries none, and what it recommends of a kind the manager may apply by
//    itself (a lesson, a skill note, a retire) is applied by itself;
//  - review:doors:<day>, the doors review: the reports outside AI tools filed at the doors that nobody has read (when
//    the manager's profile can read them). Nothing in it applies by itself: it all waits for the owner's code.

const DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The key of the internal review for the day `now` falls in, e.g. "review:daily:2026-10-27". */
export const dailyReviewKey = (now: Date) => `review:daily:${DAY.format(now)}`;
/** The key of the doors review for the day `now` falls in, e.g. "review:doors:2026-10-27". */
export const doorsReviewKey = (now: Date) => `review:doors:${DAY.format(now)}`;

type Queued = { queued: boolean; key: string };

async function queueOnce(deps: Pick<WorkerDeps, 'store'>, key: string, scope: 'internal' | 'doors', now: Date): Promise<Queued> {
  if ((await deps.store.taskStatusByKey(key)) !== null) return { queued: false, key };
  await deps.store.enqueueTask({ assistant: 'manager', kind: 'scheduled', key, payload: { job: 'manager_review', hours: 24, quiet: true, scope }, now });
  return { queued: true, key };
}

/** Queues today's two reviews of the last 24 hours. `queued` is false for one that was queued already today. */
export async function queueDailyReview(deps: Pick<WorkerDeps, 'store' | 'now'>): Promise<{ internal: Queued; doors: Queued }> {
  const now = deps.now();
  const internal = await queueOnce(deps, dailyReviewKey(now), 'internal', now);
  const doors = await queueOnce(deps, doorsReviewKey(now), 'doors', now);
  return { internal, doors };
}
