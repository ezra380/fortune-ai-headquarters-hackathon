import { randomInt, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DIVISION_ASSISTANT, type Attention, type DataPort, type ModelPort } from '@fahq/contracts';
import { openBrain } from '@fahq/brain';
import { briefKey, enqueueBrief, type BriefDivision } from '../src/brief.ts';
import { easternClock } from '../src/digest.ts';
import { handleTask, type WorkerDeps } from '../src/flows.ts';
import { SCHEDULE, runDueJobs } from '../src/scheduler.ts';

// The brief lane's two jobs. The HQ Manager's 09:00 review has its own tests (digest.test.ts); left in, it would queue
// review tasks into the shared database at every clock time from 09:00.
const BRIEF_JOBS = SCHEDULE.filter((j) => j.name !== 'manager-review');
import { createStore, type TaskRow } from '../src/store.ts';
import { dataMock, fakeCodeMode, mockMetrics, scriptedModel } from './fixtures.ts';
import { dbUrl, haveMeterless, localApi, meterlessDir } from './localdb.ts';

// BRIEF, the CEO digest, the owner's STATUS, the daily clock and APPROVE with several ranks, end to end on the real local
// database and the real Meterless engines. Only the models, Code Mode and the Zetaris adapter are fakes. Every day used
// is picked at random from the years 2200 to 6300 (no other test uses them, and the rows an earlier run left behind are
// on days this run will not pick) and the clock is set to that day, so a task this test queues is not due for any other
// test's worker; each task it queues is cancelled afterwards, and nothing it texts is left pending.

const api = haveMeterless ? localApi() : null;
if (!api) console.warn('SKIPPED digest tests: needs local Supabase (npm run db:start) and Meterless (scripts/setup-meterless.sh)');

const pool = new pg.Pool({ connectionString: dbUrl, max: 3 });
afterAll(async () => pool.end());

const PERSON = { owner: 'demo-p-owner', finance: 'demo-p-finance-owner', online: 'demo-p-online-staff', salon: 'demo-p-head-stylist' } as const;
const used = new Set<string>();
const freshDay = () => {
  for (;;) {
    const day = new Date(Date.UTC(2200, 0, 1) + randomInt(0, 1_500_000) * 86_400_000).toISOString().slice(0, 10);
    if (!used.has(day)) return used.add(day) && day;
  }
};
/** The instant it is `hhmm` in New York on `day` (summer or winter time). */
const etInstant = (day: string, hhmm: string) => {
  const want = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  for (const offset of [4, 5]) {
    const at = new Date(`${day}T00:00:00Z`);
    at.setUTCMinutes(want + offset * 60);
    const clock = easternClock(at);
    if (clock.date === day && clock.minutes === want) return at;
  }
  throw new Error(`no ${hhmm} New York time on ${day}`);
};

// ---- What the models would say ---------------------------------------------------------------------------

const financeBrief = {
  headline: 'Google ads return 2.4x on $1,800 of spend.',
  findings: [{ text: 'Google ad return is 2.4x on $1,800 of spend.', cites: ['m:online.ads.google.roas', 'm:online.ads.google.spend'] }],
  actions: [
    { rank: 1, title: 'Hold Google spend', why: 'The return is 2.4x on $1,800 of spend.', steps: 'Keep the budget and review the return next week.', cites: ['m:online.ads.google.roas'] },
    { rank: 2, title: 'Review the ad copy', why: 'The return is 2.4x.', steps: 'Read the weakest ads and rewrite the worst.', cites: ['m:online.ads.google.roas'] },
    { rank: 3, title: 'Check Mazali stock', why: 'Mazali brought in $12,400.', steps: 'Count what is on the shelf before the next push.', cites: ['m:online.revenue.mazali'] },
  ],
  ceoLine: 'Finance has something to watch; its head has the detail.',
};
const onlineBrief = {
  headline: 'Mazali brought in $12,400 and Google ads return 2.4x.',
  findings: [{ text: 'Mazali brought in $12,400 online.', cites: ['m:online.revenue.mazali'] }],
  actions: [],
  ceoLine: 'Online is running normally.',
};
const salonBrief = {
  headline: 'The salon booked 310 appointments.',
  findings: [{ text: 'Wash and set brought in $6,200.', cites: ['m:salon.revenue.wash_set'] }],
  actions: [],
  ceoLine: 'Salon is running normally.',
};
const none = JSON.stringify({ requests: [] });
const reads: Record<string, string[]> = {
  finance: ['get_finance_metrics', 'recall_my_decisions', 'my_lessons'],
  online: ['get_online_metrics', 'recall_my_decisions', 'my_lessons'],
  salon: ['get_salon_metrics', 'recall_my_decisions', 'my_lessons'],
};

describe.skipIf(!api)('BRIEF, the CEO digest, STATUS and the daily clock (real database and Meterless; models scripted)', () => {
  const attention: Record<string, Attention[]> = {};
  const numbers: Record<string, string | null> = {};
  const clock = { at: new Date() };
  const enqueued = new Set<string>();
  // The texts as they were queued (the database blanks a code once a text is handled, and a flush by another lane's test can do that at any time).
  const sent = new Map<string, string>();
  const issued: { key: string; code: string; created: boolean }[] = [];
  let deps: WorkerDeps;
  let model: ReturnType<typeof scriptedModel>;

  beforeAll(async () => {
    const real = createStore(api!.url, api!.key);
    const data: DataPort = {
      ...dataMock,
      getDivisionMetrics: async ({ division }) => ({
        division, metrics: division === 'finance' ? mockMetrics : mockMetrics.filter((m) => m.business === division),
        attention: attention[division] ?? [], queryHash: 'c'.repeat(64), view: 'fortune_demo_finance_mart',
      }),
    };
    deps = {
      store: {
        ...real,
        assistantNumber: async (a) => numbers[a] ?? null,
        enqueueTask: async (t) => { enqueued.add(t.key); return real.enqueueTask(t); },
        addOutbox: async (o) => { if (!sent.has(o.dedupeKey)) sent.set(o.dedupeKey, o.body); return real.addOutbox(o); },
        issueApproval: async (a) => {
          const result = await real.issueApproval(a);
          issued.push({ key: a.smsDedupeKey, code: a.code, created: result.created });
          if (result.created) sent.set(a.smsDedupeKey, a.smsBody);
          return result;
        },
      },
      brain: await openBrain({ meterlessDir, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fahq-digest-')), actor: 'digest-test' }),
      models: { nvidia: undefined as unknown as ModelPort, planModel: 'MOCK/plans', routerModel: 'MOCK/router' },
      guard: null,
      data,
      delivery: null,
      codeMode: fakeCodeMode().runner,
      profiles: { skill: (id) => `SKILL(${id})`, model: (id, job) => `MOCK/${id}/${job}`, reads: (id) => reads[id] ?? [] },
      now: () => clock.at,
      worker: 'digest-test-worker',
      live: false,
      period: '2026-09',
      smsLive: false,
      printers: {},
      printDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fahq-digest-print-')),
    };
  });

  beforeEach(() => {
    for (const k of Object.keys(attention)) delete attention[k];
    Object.assign(numbers, { owner: '+12125550120', finance: '+12125550123', online: '+12125550124', salon: null });
    model = scriptedModel({ 'finance.needs': none, 'online.needs': none, 'salon.needs': none });
    model.script('finance.brief', JSON.stringify(financeBrief));
    model.script('online.brief', JSON.stringify(onlineBrief));
    model.script('salon.brief', JSON.stringify(salonBrief));
    deps.models = { ...deps.models, nvidia: model.port };
  });

  afterEach(async () => {
    await pool.query(`update public.tasks set status = 'cancelled' where status = 'queued' and idempotency_key = any($1)`, [[...enqueued]]);
    await pool.query(
      `update public.outbox set status = 'skipped', last_error = 'reset by digest test', body = regexp_replace(body, '\\m[0-9]{6}\\M', '••••••', 'g') where status = 'pending' and dedupe_key = any($1)`, [[...sent.keys()]]);
    await pool.query(
      `update public.approvals set status = 'expired' where status = 'pending' and message_id in (select id from public.assistant_messages where dedupe_key like 'briefdoc:brief:%' and substring(dedupe_key from '[0-9]{4}-[0-9]{2}-[0-9]{2}') >= '2200-01-01')`);
  });

  // ---- helpers -----------------------------------------------------------------------------------------

  const rows = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
  const message = async (dedupeKey: string) => (await rows('select * from public.assistant_messages where dedupe_key = $1', [dedupeKey]))[0];
  const stepsOf = (taskId: string) => rows('select step, outcome, assistant_id, detail from public.receipts where task_id = $1 order by id', [taskId]);
  const queued = async (key: string): Promise<TaskRow> => {
    const row = (await rows('select id, assistant_id, kind, status, payload, attempts, max_attempts from public.tasks where idempotency_key = $1', [key]))[0];
    if (!row) throw new Error(`no task is queued with the key ${key}`);
    return row as TaskRow;
  };
  const tasksLike = (pattern: string) => rows('select idempotency_key, assistant_id, kind, payload from public.tasks where idempotency_key like $1 order by idempotency_key', [pattern]);
  const runQueued = async (key: string) => handleTask(await queued(key), deps);
  const day = (d = freshDay()) => { clock.at = new Date(`${d}T16:00:00Z`); return d; };

  /** Queues (if it is not queued) and runs a division's brief; returns its stored row. */
  const runBrief = async (division: BriefDivision, d: string, request?: string) => {
    await enqueueBrief(deps, division, d, request);
    const outcome = await runQueued(briefKey(division, d, request));
    expect(outcome).toEqual({ status: 'done' });
    await rows(`update public.tasks set status = 'done' where idempotency_key = $1`, [briefKey(division, d, request)]); // as the runner finishes it
    return (await rows('select * from public.division_briefs where brief_key = $1', [briefKey(division, d, request)]))[0];
  };
  const text = async (personId: string, body: string, receivedAt?: Date) => {
    const phone = (await rows('select phone, assistant_id from public.people where id = $1', [personId]))[0];
    const payload = { personId, from: phone.phone, body, ...(receivedAt ? { receivedAt: receivedAt.toISOString() } : {}) };
    const id = (await rows(`insert into public.tasks (assistant_id, kind, idempotency_key, payload, status) values ($1, 'inbound_text', $2, $3::jsonb, 'done') returning id`,
      [phone.assistant_id, `digest-test:${randomUUID()}`, JSON.stringify(payload)]))[0].id as string;
    const task = { id, assistant_id: phone.assistant_id, kind: 'inbound_text', status: 'done', payload, attempts: 1, max_attempts: 3 } as TaskRow;
    const outcome = await handleTask(task, deps);
    return { task, outcome, reply: sent.get(`reply:${id}`) };
  };
  const digestText = (d: string, ...lines: string[]) => [`Company status for ${d}:`, ...lines].join('\n');
  const codeIn = (body: string | undefined) => /APPROVE <1-3> (\d{6})/.exec(body ?? '')?.[1] ?? '';

  // ---- BRIEF ---------------------------------------------------------------------------------------------

  it('the owner texting BRIEF asks all three divisions for a brief now, keyed by that text, and the digest follows when the third is in', async () => {
    const d = day();
    attention.finance = [{ metricId: 'm:online.ads.google.roas', level: 'watch', rule: 'return below target' }];
    const asked = await text(PERSON.owner, 'brief');
    expect(asked.outcome).toEqual({ status: 'done' });
    expect(asked.reply).toBe('Asking Finance, Salon and Online for their briefs now. Each head gets hers by text, and the company digest follows here when all three are in. Text STATUS to see what is in so far.');
    expect((await stepsOf(asked.task.id)).map((s) => [s.step, s.outcome])).toEqual([['brief.request', 'ok']]);

    // Three runs of the day, one per division, each keyed by the text's task; none of them the day's scheduled brief.
    const key = (division: string) => `brief:${division}:${d}:${asked.task.id}`;
    expect(await tasksLike(`brief:%:${d}%`)).toEqual([
      { idempotency_key: key('finance'), assistant_id: 'finance', kind: 'scheduled', payload: { job: 'division_brief', division: 'finance', date: d, request: asked.task.id } },
      { idempotency_key: key('online'), assistant_id: 'online', kind: 'scheduled', payload: { job: 'division_brief', division: 'online', date: d, request: asked.task.id } },
      { idempotency_key: key('salon'), assistant_id: 'salon', kind: 'scheduled', payload: { job: 'division_brief', division: 'salon', date: d, request: asked.task.id } },
    ]);

    // The same text handled again (a retry) asks for the same runs, and answers once.
    expect(await handleTask(asked.task, deps)).toEqual({ status: 'done' });
    expect(await tasksLike(`brief:%:${d}%`)).toHaveLength(3);
    expect(await rows(`select id from public.outbox where dedupe_key = $1`, [`reply:${asked.task.id}`])).toHaveLength(1);

    // Two reports in: no digest yet. The third queues it, once.
    const request = asked.task.id;
    const finance = await runBrief('finance', d, request);
    const online = await runBrief('online', d, request);
    expect(finance).toMatchObject({ brief_key: key('finance'), status: 'watch' });
    expect(await tasksLike('digest:%')).not.toContainEqual(expect.objectContaining({ idempotency_key: `digest:${d}:${request}` }));
    const salon = await runBrief('salon', d, request);
    expect(salon).toMatchObject({ brief_key: key('salon'), status: 'normal' });
    expect(await tasksLike(`digest:${d}%`)).toEqual([
      { idempotency_key: `digest:${d}:${request}`, assistant_id: 'owner', kind: 'scheduled', payload: { job: 'ceo_digest', date: d, request } },
    ]);
    const deliver = (await stepsOf((await queued(key('salon'))).id)).find((s) => s.step === 'brief.deliver')!;
    expect(deliver.detail).toContain('all three divisions reported, CEO digest queued');
    expect((await stepsOf((await queued(key('finance'))).id)).find((s) => s.step === 'brief.deliver')!.detail).not.toContain('CEO digest');

    // Each head got her own brief by text (the salon has no live number); a head's text is not the digest.
    expect(sent.get(`brief-sms:${finance.id}`)).toContain('Finance brief for');
    expect(sent.get(`brief-sms:${online.id}`)).toContain('Online brief for');
    expect(sent.has(`brief-sms:${salon.id}`)).toBe(false);

    // The digest: written by a program from the three status lines, texted to the owner.
    const digestKey = `digest:${d}:${request}`;
    const owner = await queued(digestKey);
    expect(await handleTask(owner, deps)).toEqual({ status: 'done' });
    const expected = digestText(d, 'Salon: running normally.', `Finance: needs a look — ${financeBrief.ceoLine}`, 'Online: running normally.');
    expect(sent.get(`digest-sms:${digestKey}`)).toBe(expected);
    expect(await rows(`select to_person_id, from_assistant, channel from public.outbox where dedupe_key = $1`, [`digest-sms:${digestKey}`])).toEqual([{ to_person_id: PERSON.owner, from_assistant: 'owner', channel: 'sms' }]);
    expect(await message(`digestdoc:${digestKey}`)).toMatchObject({
      from_assistant: 'owner', to_assistant: 'owner', kind: 'report', body: { type: 'ceo_digest', date: d, text: expected },
    });
    expect((await stepsOf(owner.id)).map((s) => [s.step, s.outcome, s.assistant_id])).toEqual([['digest.send', 'ok', 'owner']]);
    expect((await stepsOf(owner.id))[0]!.detail).toBe('text queued for the owner; reports in: salon normal, finance watch, online normal');

    // Run again (a retry): the same words, no second text, no second row.
    expect(await handleTask(owner, deps)).toEqual({ status: 'done' });
    expect(await rows(`select id from public.outbox where dedupe_key = $1`, [`digest-sms:${digestKey}`])).toHaveLength(1);
    expect(await rows(`select id from public.assistant_messages where dedupe_key = $1`, [`digestdoc:${digestKey}`])).toHaveLength(1);
    expect(model.calls.map((c) => c.purpose).filter((p) => p.startsWith('owner'))).toEqual([]); // no model wrote the digest
  });

  it('a division head texting BRIEF asks for her own brief only, and no digest follows it', async () => {
    const d = day();
    const asked = await text(PERSON.finance, 'BRIEF');
    expect(asked.reply).toBe('Writing your Finance brief now. It will reach you by text when it is ready.');
    expect(await tasksLike(`brief:%:${d}%`)).toMatchObject([{ idempotency_key: `brief:finance:${d}:${asked.task.id}`, assistant_id: 'finance' }]);

    const row = await runBrief('finance', d, asked.task.id);
    expect(sent.get(`brief-sms:${row.id}`)).toContain('Finance brief for');
    expect(await tasksLike('digest:%')).not.toContainEqual(expect.objectContaining({ idempotency_key: expect.stringContaining(d) }));
  });

  it('the same BRIEF handled twice at once asks for each run once, and the digest run twice at once sends one text', async () => {
    const d = day();
    const asked = await text(PERSON.owner, 'BRIEF');
    await Promise.all([handleTask(asked.task, deps), handleTask(asked.task, deps)]);
    expect(await tasksLike(`brief:%:${d}%`)).toHaveLength(3);

    for (const division of ['salon', 'finance', 'online'] as const) await runBrief(division, d, asked.task.id);
    const digest = await queued(`digest:${d}:${asked.task.id}`);
    expect(await Promise.all([handleTask(digest, deps), handleTask(digest, deps)])).toEqual([{ status: 'done' }, { status: 'done' }]);
    expect(await rows(`select id from public.outbox where dedupe_key = $1`, [`digest-sms:digest:${d}:${asked.task.id}`])).toHaveLength(1);
    expect(await rows(`select id from public.assistant_messages where dedupe_key = $1`, [`digestdoc:digest:${d}:${asked.task.id}`])).toHaveLength(1);
  });

  it('a second BRIEF the same day is a new run: a new brief, a new text with its own code, and the later status is the one the digest shows', async () => {
    const d = day();
    const first = await runBrief('finance', d); // the day's scheduled brief: normal
    attention.finance = [{ metricId: 'm:online.ads.google.roas', level: 'act', rule: 'return below target' }];
    const asked = await text(PERSON.finance, 'BRIEF');
    const second = await runBrief('finance', d, asked.task.id);
    expect(second.id).not.toBe(first.id);
    expect(await rows(`select brief_key, status from public.division_briefs where division = 'finance' and brief_date = $1 order by created_at`, [d])).toEqual([
      { brief_key: `brief:finance:${d}`, status: 'normal' },
      { brief_key: `brief:finance:${d}:${asked.task.id}`, status: 'act' },
    ]);
    expect(codeIn(sent.get(`brief-sms:${first.id}`))).toMatch(/^\d{6}$/);
    expect(codeIn(sent.get(`brief-sms:${second.id}`))).toMatch(/^\d{6}$/);

    const status = await text(PERSON.owner, 'STATUS');
    expect(status.reply).toBe(digestText(d, 'Salon: no report yet.', `Finance: needs a decision — ${financeBrief.ceoLine}`, 'Online: no report yet.'));
  });

  it('a BRIEF text handled again after midnight asks for the same runs: the day is the day the text arrived, not the day it is handled', async () => {
    const d = day();
    const arrival = etInstant(d, '23:30');
    clock.at = arrival;
    const asked = await text(PERSON.owner, 'BRIEF', arrival);
    expect(await tasksLike(`brief:%:${d}%`)).toHaveLength(3);

    clock.at = new Date(arrival.getTime() + 60 * 60_000); // 00:30 the next morning: the lease ran out, and the task goes round again
    const next = easternClock(clock.at).date;
    expect(next).not.toBe(d);
    expect(await handleTask(asked.task, deps)).toEqual({ status: 'done' });
    expect(await tasksLike(`brief:%:${d}%`)).toHaveLength(3);
    expect(await tasksLike(`brief:%:${next}%`)).toEqual([]);
    expect((await stepsOf(asked.task.id)).map((s) => s.detail)).toEqual([`asked for the finance, salon, online brief of ${d}`, `asked for the finance, salon, online brief of ${d}`]);
  });

  it('BRIEF is for the owner and the heads: a text that cannot be tied to a division starts nothing', async () => {
    // Only the owner and the three heads are registered; the rule is on the person, so show it on a stand-in whose assistant is the manager.
    const d = day();
    const store = deps.store;
    deps.store = { ...store, person: async (id) => ({ ...(await store.person(id)), role: 'staff', assistant_id: 'manager' as const }) };
    try {
      const asked = await text(PERSON.finance, 'BRIEF');
      expect(asked.reply).toBe('BRIEF is for the owner and the division heads. Nothing was started.');
      expect(await tasksLike(`brief:%:${d}%`)).toEqual([]);
      expect((await stepsOf(asked.task.id))[0]).toMatchObject({ step: 'brief.request', outcome: 'refused', detail: 'BRIEF is for the owner and the division heads' });
    } finally {
      deps.store = store;
    }
  });

  // ---- The daily clock and the day's digest ----------------------------------------------------------------

  const normalLines = ['Salon: running normally.', 'Finance: running normally.', 'Online: running normally.'];
  const waitingReceipts = (d: string) => rows(`select outcome, detail from public.receipts where step = 'scheduler.enqueue' and detail like $1 order by id`, [`ceo-digest for ${d} is waiting%`]);

  it('at 08:30 New York time the clock queues the three briefs, and the digest waits for them: it is queued once the reports are in, never before', async () => {
    const d = freshDay();
    clock.at = etInstant(d, '08:30');
    await runBrief('salon', d); // the salon's brief is in; the others are not
    const marks = new Set<string>();
    const names = await runDueJobs(deps, marks, BRIEF_JOBS);
    expect(names).toEqual(['division-briefs']); // the digest is due too, and waits
    expect(BRIEF_JOBS.map((j) => j.name)).toEqual(['division-briefs', 'ceo-digest']);
    expect(await runDueJobs(deps, new Set(), BRIEF_JOBS)).toEqual(['division-briefs']); // another worker's clock: the same keys, so nothing doubles
    expect(await tasksLike(`brief:%:${d}`)).toMatchObject([
      { idempotency_key: `brief:finance:${d}`, assistant_id: 'finance' }, { idempotency_key: `brief:online:${d}`, assistant_id: 'online' }, { idempotency_key: `brief:salon:${d}`, assistant_id: 'salon' },
    ]);
    expect(await tasksLike(`digest:${d}%`)).toEqual([]);
    expect((await waitingReceipts(d)).map((r) => r.detail)).toContain(`ceo-digest for ${d} is waiting: 2 of the day's briefs are still being worked on`);

    // The other two report: the third queues the day's digest (once), and it says all three.
    await runBrief('finance', d);
    expect(await tasksLike(`digest:${d}%`)).toEqual([]);
    await runBrief('online', d);
    expect(await tasksLike(`digest:${d}%`)).toMatchObject([{ idempotency_key: `digest:${d}`, assistant_id: 'owner', payload: { job: 'ceo_digest', date: d } }]);
    expect(await runDueJobs(deps, marks, BRIEF_JOBS)).toEqual(['ceo-digest']); // the clock's next beat finds it there
    expect(await tasksLike(`digest:${d}%`)).toHaveLength(1);
    expect((await rows(`select detail from public.receipts where step = 'scheduler.enqueue' and detail like $1`, [`%${d}%`])).map((r) => r.detail)).toContain(`ceo-digest for ${d} queued`);

    expect(await runQueued(`digest:${d}`)).toEqual({ status: 'done' });
    expect(sent.get(`digest-sms:digest:${d}`)).toBe(digestText(d, ...normalLines));
    expect((await stepsOf((await queued(`digest:${d}`)).id))[0]!.detail).toBe('text queued for the owner; reports in: salon normal, finance normal, online normal');
    expect(await runQueued(`digest:${d}`)).toEqual({ status: 'done' });
    expect(await rows(`select id from public.outbox where dedupe_key = $1`, [`digest-sms:digest:${d}`])).toHaveLength(1);

    // The owner's STATUS shows what is in.
    expect((await text(PERSON.owner, 'STATUS')).reply).toBe(digestText(d, ...normalLines));
  });

  it('a worker that starts late finds the briefs and the digest due at once: the digest waits, and the owner gets it only after the three reports are in', async () => {
    const d = freshDay();
    clock.at = etInstant(d, '09:00');
    const marks = new Set<string>(); // one worker process's memory
    expect(await runDueJobs(deps, marks, BRIEF_JOBS)).toEqual(['division-briefs']);
    expect(await tasksLike(`brief:%:${d}`)).toHaveLength(3);
    expect(await tasksLike(`digest:${d}%`)).toEqual([]); // not queued, so not sent ahead of the briefs

    // The next beats change nothing, and the wait is reported once.
    clock.at = etInstant(d, '09:01');
    expect(await runDueJobs(deps, marks, BRIEF_JOBS)).toEqual([]);
    expect(await tasksLike(`digest:${d}%`)).toEqual([]);
    expect(await waitingReceipts(d)).toEqual([{ outcome: 'ok', detail: `ceo-digest for ${d} is waiting: 3 of the day's briefs are still being worked on` }]);

    // The briefs finish one by one; two in and one still open is still a wait.
    await runBrief('salon', d);
    await runBrief('finance', d);
    clock.at = etInstant(d, '09:20');
    expect(await runDueJobs(deps, marks, BRIEF_JOBS)).toEqual([]);
    expect(await tasksLike(`digest:${d}%`)).toEqual([]);
    expect(await waitingReceipts(d)).toHaveLength(1);
    expect(sent.has(`digest-sms:digest:${d}`)).toBe(false);

    // The third report queues the complete digest; the clock's next beat finds it there.
    await runBrief('online', d);
    expect(await tasksLike(`digest:${d}%`)).toHaveLength(1);
    expect(await runDueJobs(deps, marks, BRIEF_JOBS)).toEqual(['ceo-digest']);
    expect(await tasksLike(`digest:${d}%`)).toHaveLength(1);
    expect(await runQueued(`digest:${d}`)).toEqual({ status: 'done' });
    expect(sent.get(`digest-sms:digest:${d}`)).toBe(digestText(d, ...normalLines));
  });

  it('a worker that starts after 10:30 still holds the digest for the briefs it has just queued, and sends only the complete one', async () => {
    const d = freshDay();
    clock.at = etInstant(d, '10:45');
    const marks = new Set<string>();
    expect(await runDueJobs(deps, marks, BRIEF_JOBS)).toEqual(['division-briefs']);
    expect(await tasksLike(`digest:${d}%`)).toEqual([]); // the clock is past 10:30, but the briefs were queued just now
    for (const division of ['salon', 'finance', 'online'] as const) await runBrief(division, d);
    expect((await tasksLike(`digest:${d}%`)).map((t) => t.idempotency_key)).toEqual([`digest:${d}`]);
    expect(await runQueued(`digest:${d}`)).toEqual({ status: 'done' });
    expect(sent.get(`digest-sms:digest:${d}`)).toBe(digestText(d, ...normalLines));
  });

  it('a brief that is still not in two hours after the briefs were queued does not hold the digest for ever: a partial digest goes out, and the complete one follows when the last report arrives', async () => {
    const d = freshDay();
    clock.at = etInstant(d, '08:30');
    const marks = new Set<string>();
    await runBrief('salon', d);
    expect(await runDueJobs(deps, marks, BRIEF_JOBS)).toEqual(['division-briefs']);
    clock.at = etInstant(d, '10:29');
    expect(await runDueJobs(deps, marks, BRIEF_JOBS)).toEqual([]);
    expect(await tasksLike(`digest:${d}%`)).toEqual([]);
    clock.at = etInstant(d, '10:30');
    expect(await runDueJobs(deps, marks, BRIEF_JOBS)).toEqual(['ceo-digest']);
    expect(await tasksLike(`digest:${d}%`)).toMatchObject([{ idempotency_key: `digest:${d}:partial`, assistant_id: 'owner', payload: { job: 'ceo_digest', date: d, partial: true } }]);
    expect(await runQueued(`digest:${d}:partial`)).toEqual({ status: 'done' });
    expect(sent.get(`digest-sms:digest:${d}:partial`)).toBe(digestText(d, 'Salon: running normally.', 'Finance: no report yet.', 'Online: no report yet.'));
    expect((await stepsOf((await queued(`digest:${d}:partial`)).id))[0]!.detail).toBe('text queued for the owner; reports in: salon normal; no report yet: finance, online');

    // The late reports arrive: the third queues the day's complete digest, a second text with all three lines.
    await runBrief('finance', d);
    expect(await tasksLike(`digest:${d}%`)).toHaveLength(1);
    await runBrief('online', d);
    expect((await tasksLike(`digest:${d}%`)).map((t) => t.idempotency_key)).toEqual([`digest:${d}`, `digest:${d}:partial`]);
    expect(await runQueued(`digest:${d}`)).toEqual({ status: 'done' });
    expect(sent.get(`digest-sms:digest:${d}`)).toBe(digestText(d, ...normalLines));
    expect(sent.get(`digest-sms:digest:${d}:partial`)).toContain('Finance: no report yet.'); // the first text was not rewritten
  });

  it('when the briefs that are not in have stopped for good, nothing is coming: the partial digest does not wait for 10:30', async () => {
    const d = freshDay();
    clock.at = etInstant(d, '08:30');
    const marks = new Set<string>();
    await runBrief('salon', d);
    expect(await runDueJobs(deps, marks, BRIEF_JOBS)).toEqual(['division-briefs']);
    expect(await tasksLike(`digest:${d}%`)).toEqual([]);
    await rows(`update public.tasks set status = 'failed' where idempotency_key = any($1)`, [[`brief:finance:${d}`, `brief:online:${d}`]]); // out of attempts
    clock.at = etInstant(d, '08:31');
    expect(await runDueJobs(deps, marks, BRIEF_JOBS)).toEqual(['ceo-digest']);
    expect(await tasksLike(`digest:${d}%`)).toMatchObject([{ idempotency_key: `digest:${d}:partial` }]);
  });

  it('when the third scheduled brief arrives first, the day\'s digest is queued by it and the 08:30 clock finds it already there', async () => {
    const d = day();
    await runBrief('salon', d);
    await runBrief('finance', d);
    expect(await tasksLike(`digest:${d}%`)).toEqual([]);
    await runBrief('online', d);
    expect(await tasksLike(`digest:${d}%`)).toHaveLength(1);
    clock.at = etInstant(d, '08:30');
    await runDueJobs(deps, new Set(), BRIEF_JOBS);
    expect(await tasksLike(`digest:${d}%`)).toHaveLength(1);
    expect(await runQueued(`digest:${d}`)).toEqual({ status: 'done' });
    expect(sent.get(`digest-sms:digest:${d}`)).toBe(digestText(d, 'Salon: running normally.', 'Finance: running normally.', 'Online: running normally.'));
  });

  it('sends no text when the owner assistant has no live number, and says so; STATUS still answers', async () => {
    const d = day();
    numbers.owner = null;
    for (const division of ['salon', 'finance', 'online'] as const) await runBrief(division, d);
    expect(await runQueued(`digest:${d}`)).toEqual({ status: 'done' });
    expect(sent.has(`digest-sms:digest:${d}`)).toBe(false);
    const receipt = (await stepsOf((await queued(`digest:${d}`)).id))[0]!;
    expect(receipt).toMatchObject({ step: 'digest.send', outcome: 'refused' });
    expect(receipt.detail).toBe('no text sent: the Owner HQ assistant has no live number; the digest is stored; reports in: salon normal, finance normal, online normal');
    expect((await text(PERSON.owner, 'STATUS')).reply).toContain('Online: running normally.');
  });

  it('refuses a digest job that is not the owner\'s or has a bad date, and a brief job whose request is not an id', async () => {
    const d = day();
    const task = async (assistant: string, payload: Record<string, unknown>) => {
      const id = (await rows(`insert into public.tasks (assistant_id, kind, idempotency_key, payload, status) values ($1, 'scheduled', $2, $3::jsonb, 'done') returning id`,
        [assistant, `digest-test:${randomUUID()}`, JSON.stringify(payload)]))[0].id as string;
      return { id, assistant_id: assistant, kind: 'scheduled', status: 'done', payload, attempts: 1, max_attempts: 3 } as TaskRow;
    };
    // Only Owner HQ writes the digest: another assistant's task with that job is not routed to it at all.
    expect(await handleTask(await task('finance', { job: 'ceo_digest', date: d }), deps)).toEqual({ status: 'failed', error: 'unsupported scheduled job "ceo_digest" for the finance assistant' });
    expect(await handleTask(await task('owner', { job: 'ceo_digest', date: 'tomorrow' }), deps)).toEqual({ status: 'failed', error: 'the digest job needs a date (YYYY-MM-DD)' });
    expect(await handleTask(await task('owner', { job: 'ceo_digest', date: d, request: 'not-an-id' }), deps)).toEqual({ status: 'failed', error: 'the digest job needs a date (YYYY-MM-DD)' });
    expect(await handleTask(await task('finance', { job: 'division_brief', division: 'finance', date: d, request: 'not-an-id' }), deps))
      .toEqual({ status: 'failed', error: 'the brief job needs a division (finance, online or salon) and a date (YYYY-MM-DD)' });
    expect(model.calls).toHaveLength(0);
  });

  it('a heads\' STATUS is still the count of her assistant\'s open items', async () => {
    day();
    expect((await text(PERSON.finance, 'STATUS')).reply).toMatch(/^Open items for your assistant: \d+\.$/);
    expect((await text(PERSON.salon, 'status')).reply).toMatch(/^Open items for your assistant: \d+\.$/);
  });

  it('the database accepts a brief key with the id of the asking text and refuses any other ending', async () => {
    const d = freshDay();
    const request = randomUUID();
    const insert = (key: string, division = 'online') => pool.query(
      `insert into public.division_briefs (division, brief_key, brief_date, period, status, written_by, brief, ceo_line)
       values ($1, $2, $3, 'p', 'normal', 'model', '{}'::jsonb, 'x') returning id`, [division, key, d]);
    const ok = await insert(`brief:online:${d}:${request}`);
    try {
      await expect(insert(`brief:online:${d}:not-an-id`)).rejects.toThrow(/division_briefs_check/);
      await expect(insert(`brief:online:${d}:${request}x`)).rejects.toThrow(/division_briefs_check/);
      await expect(insert(`brief:finance:${d}:${randomUUID()}`, 'online')).rejects.toThrow(/division_briefs_check/);
      await expect(insert(`xbrief:online:${d}`)).rejects.toThrow(/division_briefs_check/);
    } finally {
      await pool.query('delete from public.division_briefs where id = $1', [ok.rows[0].id]); // the one row this test made
    }
  });

  // ---- APPROVE with several ranks --------------------------------------------------------------------------

  const approvable = async () => {
    const d = day();
    attention.finance = [{ metricId: 'm:online.ads.google.roas', level: 'act', rule: 'return below target' }];
    const row = await runBrief('finance', d);
    const doc = await message(`briefdoc:brief:finance:${d}`);
    return { d, row, doc, code: codeIn(sent.get(`brief-sms:${row.id}`)), sms: sent.get(`brief-sms:${row.id}`)! };
  };
  const decisions = (docId: string) => rows(`select dedupe_key, body from public.assistant_messages where dedupe_key like $1 order by dedupe_key`, [`action-decision:${docId}:%`]);

  it('tells the head that several actions can be approved with one code', async () => {
    const { sms, code } = await approvable();
    expect(sms.endsWith(`Reply APPROVE <1-3> ${code} to approve an action (APPROVE 1 2 ${code} for more). The code expires in 12 hours.`)).toBe(true);
  });

  it('APPROVE 1 3 <code> records both actions: in the division\'s memory, the World Model and the HQ Manager\'s mailbox; action 2 is not touched', async () => {
    const { doc, code, row } = await approvable();
    const approved = await text(PERSON.finance, `approve 3, 1 ${code}`);
    expect(approved.outcome).toEqual({ status: 'done' });
    expect(approved.reply).toBe("Recorded: you approved action 1 (Hold Google spend) and action 3 (Check Mazali stock). They're yours to carry out.");

    expect((await decisions(doc.id)).map((r) => [r.dedupe_key, r.body.title, r.body.verdict, r.body.by])).toEqual([
      [`action-decision:${doc.id}:1`, 'Hold Google spend', 'approved', PERSON.finance],
      [`action-decision:${doc.id}:3`, 'Check Mazali stock', 'approved', PERSON.finance],
    ]);
    // Both are in the division's memory (one decision each, though they come from one brief and one person).
    const remembered = deps.brain.memory('finance').recallDecisions('Hold Google spend Check Mazali stock', 10).map((d) => d.memory.content);
    expect(remembered.filter((c) => c.includes('approved plan 1 "Hold Google spend"'))).toHaveLength(1);
    expect(remembered.filter((c) => c.includes('approved plan 3 "Check Mazali stock"'))).toHaveLength(1);
    expect(remembered.some((c) => c.includes('Review the ad copy'))).toBe(false);
    // And in the World Model: each action is an item with its title, the metrics it cited and the head's approval.
    const first = deps.brain.record.explainProposal(`${doc.id}:1`);
    expect(first.proposal).toMatchObject({ titles: ['Hold Google spend'], dataSource: row.data_source });
    expect(first.cites).toEqual(['m:online.ads.google.roas']);
    const financeName = (await rows('select name from public.people where id = $1', [PERSON.finance]))[0].name; // the seed's stand-in, or a demo's name
    expect(first.decisions).toMatchObject([{ by: financeName, action: 'approved', planRank: 1 }]);
    expect(deps.brain.record.explainProposal(`${doc.id}:3`).decisions).toMatchObject([{ action: 'approved', planRank: 3 }]);
    expect(deps.brain.record.explainProposal(`${doc.id}:2`).proposal).toBeNull();
    expect((await stepsOf(approved.task.id)).map((s) => [s.step, s.outcome, s.detail])).toEqual([
      ['approval.action', 'ok', `action 1, 3 of the finance brief approved by ${PERSON.finance}`],
    ]);

    // The code is spent: a second APPROVE, even for the action left over, does nothing.
    const again = await text(PERSON.finance, `APPROVE 2 ${code}`);
    expect(again.reply).toBe("That code didn't work or has expired. Nothing was recorded.");
    expect(await decisions(doc.id)).toHaveLength(2);
  });

  it('two texts presenting the same code at once record the decision once', async () => {
    const { doc, code } = await approvable();
    const [a, b] = await Promise.all([text(PERSON.finance, `APPROVE 1 2 ${code}`), text(PERSON.finance, `APPROVE 1 2 ${code}`)]);
    const replies = [a.reply, b.reply].sort();
    expect(replies).toEqual([
      "Recorded: you approved action 1 (Hold Google spend) and action 2 (Review the ad copy). They're yours to carry out.",
      "That code didn't work or has expired. Nothing was recorded.",
    ].sort());
    expect(await decisions(doc.id)).toHaveLength(2);
  });

  it('a rank the brief does not have is named and nothing is recorded, not even the ranks it has; the code stays usable, so one wrong digit costs nothing', async () => {
    const d = day();
    attention.finance = [{ metricId: 'm:online.ads.google.roas', level: 'act', rule: 'return below target' }];
    model.script('finance.brief', JSON.stringify({ ...financeBrief, actions: financeBrief.actions.slice(0, 2) }));
    const row = await runBrief('finance', d);
    const doc = await message(`briefdoc:brief:finance:${d}`);
    const code = codeIn(sent.get(`brief-sms:${row.id}`));
    const asked = await text(PERSON.finance, `APPROVE 1 2 3 ${code}`);
    expect(asked.reply).toBe('This brief has no action 3. Nothing was recorded, and your code still works.');
    expect(await decisions(doc.id)).toEqual([]);
    expect((await stepsOf(asked.task.id))[0]!.detail).toBe('the brief has no action 3; the code was not spent');
    expect(await rows(`select status from public.approvals where message_id = $1`, [doc.id])).toEqual([{ status: 'pending' }]);

    // The same code with the right ranks records them.
    const again = await text(PERSON.finance, `APPROVE 1 2 ${code}`);
    expect(again.reply).toBe("Recorded: you approved action 1 (Hold Google spend) and action 2 (Review the ad copy). They're yours to carry out.");
    expect((await decisions(doc.id)).map((r) => r.dedupe_key)).toEqual([`action-decision:${doc.id}:1`, `action-decision:${doc.id}:2`]);
  });

  it('APPROVE 2 3 for a brief with one action records nothing and says which ranks it lacks; APPROVE 1 with the same code then works', async () => {
    const d = day();
    attention.finance = [{ metricId: 'm:online.ads.google.roas', level: 'act', rule: 'return below target' }];
    model.script('finance.brief', JSON.stringify({ ...financeBrief, actions: financeBrief.actions.slice(0, 1) }));
    const row = await runBrief('finance', d);
    const doc = await message(`briefdoc:brief:finance:${d}`);
    const code = codeIn(sent.get(`brief-sms:${row.id}`));
    const asked = await text(PERSON.finance, `APPROVE 2 3 ${code}`);
    expect(asked.reply).toBe('This brief has no action 2 or 3. Nothing was recorded, and your code still works.');
    expect(await decisions(doc.id)).toEqual([]);
    expect((await stepsOf(asked.task.id))[0]).toMatchObject({ outcome: 'refused', detail: 'the brief has no action 2, 3; the code was not spent' });
    expect((await text(PERSON.finance, `APPROVE 1 ${code}`)).reply).toBe("Recorded: you approved action 1 (Hold Google spend). It's yours to carry out.");
  });
});
