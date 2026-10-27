import { z } from 'zod';
import { BriefStatus } from '@fahq/contracts';
import { done, errorText, fail, isLiveNumber, receipt, text, type Outcome, type WorkerDeps } from './common.ts';
import { DEPARTMENT_LABEL, isDepartment, type Department } from './departments.ts';
import type { MessageRow, PersonRow, TaskRow } from './store.ts';

// The CEO digest: one very short text from Owner HQ to the owner, with one line per division. The heads get the
// detail in their own briefs; the CEO division only hears whether things are running normally. A program writes it,
// never a model: a normal division is one fixed sentence, and the only words from a division are its own CEO line,
// which its brief already checked (every number in it traces to that division's data).
//   queued → when all three divisions have reported (the third brief's delivery, or the 08:30 clock finding all three in);
//            a BRIEF text queues its own digest for that run. The 08:30 clock never sends a digest ahead of briefs that are
//            still being worked on: it waits for them, and only when one has stopped for good, or two hours have passed
//            since they were queued, does it queue a PARTIAL digest (digest:<date>:partial, "no report yet" for the
//            missing). The complete digest still follows when the last report arrives.
//   built  → from the latest status line of the day for each division (mailbox reports to `owner`)
//   sent   → one text, keyed by the digest, and the digest itself kept as a mailbox row so a retry sends the same words
// On a day the weekly reports are in, a second digest follows the third weekly report (digest:<date>:weekly, or
// digest:<date>:weekly:<id of the REPORT text>): one line per division from the managers' weekly CEO lines, by the same
// rules and within the same length. The day's own digest still reads only the briefs' lines.

/** The most characters the digest may have: three short lines and a heading, readable at a glance. */
export const DIGEST_MAX = 480;

// ---- The company's day ---------------------------------------------------------------------------------

const NEW_YORK = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** The date and the minutes since midnight in New York (the clock the company's briefs and digest follow). */
export function easternClock(now: Date): { date: string; minutes: number } {
  const p = Object.fromEntries(NEW_YORK.formatToParts(now).map((part) => [part.type, part.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
export const companyDay = (now: Date): string => easternClock(now).date;

// ---- Reading the day's reports -------------------------------------------------------------------------

/** The order the lines come in. */
const ORDER: readonly Department[] = ['salon', 'finance', 'online'];

const StatusBody = z.object({ division: z.enum(['salon', 'finance', 'online']), status: BriefStatus, ceoLine: z.string().min(1).max(140) });

export type DigestLine =
  | { division: Department; state: 'missing' }
  | { division: Department; state: 'unreadable' }
  | { division: Department; state: 'in'; status: BriefStatus; ceoLine: string };

/** One line per division from its newest status report (rows come newest first). A report that cannot be read says so. */
export function digestLines(rows: readonly Pick<MessageRow, 'body'>[]): DigestLine[] {
  const latest = new Map<Department, Record<string, unknown>>();
  for (const row of rows) {
    const division = row.body.division;
    if (isDepartment(division) && !latest.has(division)) latest.set(division, row.body);
  }
  return ORDER.map((division): DigestLine => {
    const body = latest.get(division);
    if (!body) return { division, state: 'missing' };
    const parsed = StatusBody.safeParse(body);
    return parsed.success ? { division, state: 'in', status: parsed.data.status, ceoLine: parsed.data.ceoLine.replace(/\s+/g, ' ').trim() } : { division, state: 'unreadable' };
  });
}

// ---- Writing the digest --------------------------------------------------------------------------------

const LEAD: Record<BriefStatus, string> = { normal: 'running normally.', watch: 'needs a look — ', act: 'needs a decision — ' };

/** Cuts at a word, so a number is kept whole or left out, never cut in half. */
export function clipWords(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max < 2) return '';
  const cut = s.slice(0, max - 1);
  const whole = s[max - 1] === ' ' ? cut : cut.slice(0, Math.max(cut.lastIndexOf(' '), 0));
  return `${whole.replace(/[\s,;:(—-]+$/, '')}…`;
}

/** Each wording gets what it needs, or an equal share of what is left of the budget, the shortest first. */
function shares(lengths: readonly number[], budget: number): number[] {
  const out = lengths.map(() => 0);
  let left = Math.max(budget, 0);
  lengths.map((length, index) => ({ length, index })).sort((a, b) => a.length - b.length).forEach(({ length, index }, n, all) => {
    out[index] = Math.min(length, Math.floor(left / (all.length - n)));
    left -= out[index]!;
  });
  return out;
}

/**
 * The digest text: a heading and one line per division, at most DIGEST_MAX characters. A division with no report says
 * "no report yet". Only the lines of a division that needs a look carry its CEO line, shortened by words if they would
 * not all fit.
 */
export function buildDigest(date: string, rows: readonly Pick<MessageRow, 'body'>[]): { text: string; lines: DigestLine[] } {
  return compose(`Company status for ${date}:`, digestLines(rows));
}

/** The weekly digest: the same lines and rules, from the managers' weekly status lines (rows newest first). */
export function buildWeeklyDigest(weekOf: string, rows: readonly Pick<MessageRow, 'body'>[]): { text: string; lines: DigestLine[] } {
  return compose(`Weekly reports, week of ${weekOf}:`, digestLines(rows));
}

function compose(heading: string, lines: DigestLine[]): { text: string; lines: DigestLine[] } {
  const starts = lines.map((line) => {
    const label = `${DEPARTMENT_LABEL[line.division]}: `;
    if (line.state === 'missing') return `${label}no report yet.`;
    if (line.state === 'unreadable') return `${label}the report could not be read.`;
    return `${label}${LEAD[line.status]}`;
  });
  const words = lines.map((line) => (line.state === 'in' && line.status !== 'normal' ? line.ceoLine : ''));
  const room = DIGEST_MAX - [heading, ...starts].join('\n').length;
  const allowed = shares(words.map((w) => w.length), room);
  const body = starts.map((start, i) => `${start}${clipWords(words[i]!, allowed[i]!)}`.trimEnd());
  return { text: [heading, ...body].join('\n'), lines };
}

/** The digest as it stands now, from the reports that are in (the owner's STATUS). */
export async function currentDigest(deps: Pick<WorkerDeps, 'store' | 'now'>): Promise<string> {
  const date = companyDay(deps.now());
  return buildDigest(date, await deps.store.divisionStatusMessages(date)).text;
}

// ---- The scheduled job ---------------------------------------------------------------------------------

const DigestJob = z.object({
  job: z.literal('ceo_digest'), date: z.iso.date(), request: z.uuid().optional(), partial: z.boolean().optional(),
  /** Set for the weekly digest: the Monday of the week the weekly reports cover. */
  weekOf: z.iso.date().optional(),
});

/**
 * digest:<date> is the day's digest; digest:<date>:<id of the BRIEF text> is the one that follows a BRIEF;
 * digest:<date>:partial is the one the clock sends when a report did not come in time.
 */
export const digestKey = (date: string, request?: string, partial?: boolean) => `digest:${date}${request ? `:${request}` : ''}${partial ? ':partial' : ''}`;

/** digest:<date>:weekly follows the day's three weekly reports; digest:<date>:weekly:<id of the REPORT text> follows a REPORT ALL. */
export const weeklyDigestKey = (date: string, request?: string) => `digest:${date}:weekly${request ? `:${request}` : ''}`;

/** Queues the weekly digest for Owner HQ, once per key. */
export async function enqueueWeeklyDigest(deps: Pick<WorkerDeps, 'store' | 'now'>, date: string, weekOf: string, request?: string): Promise<void> {
  await deps.store.enqueueTask({
    assistant: 'owner', kind: 'scheduled', key: weeklyDigestKey(date, request),
    payload: { job: 'ceo_digest', date, weekOf, ...(request ? { request } : {}) }, now: deps.now(),
  });
}

/** Queues the digest for Owner HQ. Queuing it twice for the same key changes nothing. */
export async function enqueueDigest(deps: Pick<WorkerDeps, 'store' | 'now'>, date: string, request?: string): Promise<void> {
  await deps.store.enqueueTask({
    assistant: 'owner', kind: 'scheduled', key: digestKey(date, request),
    payload: { job: 'ceo_digest', date, ...(request ? { request } : {}) }, now: deps.now(),
  });
}

/** Queues the partial digest of a day (some reports are missing and are not coming in time). Its own key: the complete digest can still follow. */
export async function enqueuePartialDigest(deps: Pick<WorkerDeps, 'store' | 'now'>, date: string): Promise<void> {
  await deps.store.enqueueTask({
    assistant: 'owner', kind: 'scheduled', key: digestKey(date, undefined, true), payload: { job: 'ceo_digest', date, partial: true }, now: deps.now(),
  });
}

/** What the receipt says about the reports behind a digest. */
function reportsIn(lines: readonly DigestLine[]): string {
  const named = (state: 'missing' | 'unreadable') => lines.filter((l) => l.state === state).map((l) => l.division).join(', ');
  const reported = lines.flatMap((l) => (l.state === 'in' ? [`${l.division} ${l.status}`] : []));
  return [`reports in: ${reported.join(', ') || 'none'}`, named('missing') && `no report yet: ${named('missing')}`, named('unreadable') && `unreadable: ${named('unreadable')}`]
    .filter(Boolean).join('; ');
}

/**
 * Owner HQ's digest for one day. The words are written once and kept as a mailbox row (`digestdoc:<key>`), so a task
 * that runs again sends the same words and never a second text. No live number for the owner assistant means no text,
 * and a receipt that says so.
 */
export async function ceoDigest(task: TaskRow, deps: WorkerDeps, runId: string): Promise<Outcome> {
  const job = DigestJob.safeParse(task.payload);
  if (!job.success) return fail('the digest job needs a date (YYYY-MM-DD)');
  const { date, request, partial, weekOf } = job.data;
  if (weekOf && partial) return fail('a weekly digest follows the third weekly report and is never partial');
  const key = weekOf ? weeklyDigestKey(date, request) : digestKey(date, request, partial);
  let owner: PersonRow;
  try {
    owner = await deps.store.personByAssistant('owner');
  } catch {
    return fail('the owner is not registered, so there is nobody to send the digest to');
  }

  const started = deps.now();
  let doc = await deps.store.messageByKey(`digestdoc:${key}`);
  let summary = '';
  if (!doc) {
    let built: ReturnType<typeof buildDigest>;
    try {
      built = weekOf
        ? buildWeeklyDigest(weekOf, await deps.store.weeklyStatusMessages(date))
        : buildDigest(date, await deps.store.divisionStatusMessages(date));
    } catch (error) {
      await receipt(deps, { runId, taskId: task.id, step: 'digest.build', assistant: 'owner', started, outcome: 'failed', detail: errorText(error, 'the reports could not be read') });
      throw error;
    }
    summary = `${weekOf ? `weekly reports of the week of ${weekOf}; ` : ''}${reportsIn(built.lines)}`;
    doc = await deps.store.postMessage({
      from: 'owner', to: 'owner', kind: 'report', replyTo: null, dedupeKey: `digestdoc:${key}`,
      body: { type: 'ceo_digest', date, text: built.text, reports: built.lines, ...(weekOf ? { weekOf } : {}) },
    });
  }
  const words = typeof doc.body.text === 'string' ? doc.body.text : '';
  if (!words) return fail('the stored digest has no text');

  const number = await deps.store.assistantNumber('owner');
  if (!isLiveNumber(number)) {
    await receipt(deps, { runId, taskId: task.id, step: 'digest.send', assistant: 'owner', started, outcome: 'refused', detail: `no text sent: the Owner HQ assistant has no live number; the digest is stored${summary ? `; ${summary}` : ''}` });
    return done;
  }
  await text(deps, owner, 'owner', words, `digest-sms:${key}`);
  await receipt(deps, { runId, taskId: task.id, step: 'digest.send', assistant: 'owner', started, outcome: 'ok', detail: `text queued for the owner${summary ? `; ${summary}` : ''}` });
  return done;
}
