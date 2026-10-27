import { randomInt, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DIVISION_ASSISTANT, type Attention, type DataPort, type ModelPort } from '@fahq/contracts';
import { openBrain } from '@fahq/brain';
import { BRIEF_RULES, NEEDS_RULES, enqueueBrief, type BriefDivision } from '../src/brief.ts';
import { APPROVAL_HINT } from '../src/commands.ts';
import { handleTask, type WorkerDeps } from '../src/flows.ts';
import { createStore, type TaskRow } from '../src/store.ts';
import { dataMock, fakeCodeMode, mockMetrics, okResult, scriptedModel } from './fixtures.ts';
import { dbUrl, haveMeterless, localApi, meterlessDir } from './localdb.ts';

// A division's brief end to end on the real local database and the real Meterless engines. Only the models, Code
// Mode and the Zetaris adapter are fakes (scripted below); SMS never leaves the database (nothing flushes the outbox).
// Every brief is for a day in the 2100s that no other test uses, and every row a test leaves is settled afterwards.

const api = haveMeterless ? localApi() : null;
if (!api) console.warn('SKIPPED brief tests: needs local Supabase (npm run db:start) and Meterless (scripts/setup-meterless.sh)');

const pool = new pg.Pool({ connectionString: dbUrl, max: 3 });
afterAll(async () => pool.end());

const HEAD: Record<BriefDivision, string> = { finance: 'demo-p-finance-owner', online: 'demo-p-online-staff', salon: 'demo-p-head-stylist' };
const used = new Set<string>();
const freshDate = () => {
  for (;;) {
    const day = new Date(Date.UTC(2100, 0, 1) + randomInt(0, 36_500) * 86_400_000).toISOString().slice(0, 10);
    if (!used.has(day)) return used.add(day) && day;
  }
};

// ---- What the models would say --------------------------------------------------------------------------

const financeBrief = {
  headline: 'Google ads return 2.4x on $1,800 of spend.',
  findings: [
    { text: 'Google ad return is 2.4x on $1,800 of spend.', cites: ['m:online.ads.google.roas', 'm:online.ads.google.spend'] },
    { text: 'The salon booked 310 appointments.', cites: ['m:salon.appointments.count'] },
  ],
  actions: [{ rank: 1, title: 'Hold Google spend', why: 'The return is 2.4x on $1,800 of spend.', steps: 'Keep the budget and review the return next week.', cites: ['m:online.ads.google.roas'] }],
  ceoLine: 'Finance has something to watch; its head has the detail.',
};
const onlineBrief = {
  headline: 'Mazali brought in $12,400 and Google ads return 2.4x.',
  findings: [
    { text: 'Mazali brought in $12,400 online.', cites: ['m:online.revenue.mazali'] },
    { text: 'The salon booked 310 appointments, so Mazali buyers have room to book.', cites: ['m:salon.appointments.count'] },
  ],
  actions: [{ rank: 1, title: 'Add a salon booking link to Mazali order emails', why: 'Salon bookings leave room for Mazali buyers.', steps: 'Add the link to the order email and watch bookings next week.', cites: ['m:salon.appointments.count'] }],
  ceoLine: 'Online is running normally.',
};
const salonBrief = {
  headline: 'The salon booked 310 appointments.',
  findings: [{ text: 'Wash and set brought in $6,200.', cites: ['m:salon.revenue.wash_set'] }],
  actions: [],
  ceoLine: 'Salon is running normally.',
};
const salonFacts = { metrics: { 'm:salon.appointments.count': { label: 'Salon appointments', value: 310, unit: 'count', business: 'salon' } } };
// What a reply keeps of that script result: the metric ids and their values, nothing else.
const salonMetrics = [{ id: 'm:salon.appointments.count', value: 310, unit: 'count' }];
/** A script result and the tool outputs it was made from (so the numbers in it trace to a tool). */
const lookedUp = (result: unknown, ...outputs: unknown[]) => okResult(result, { toolOutputs: outputs.map((output) => ({ tool: 'get_metrics', output })) });
const none = JSON.stringify({ requests: [] });
const asks = (division: string, question = 'How many appointments did the salon book?') => JSON.stringify({ requests: [{ division, question }] });

const reads: Record<string, string[]> = {
  finance: ['get_finance_metrics', 'recall_my_decisions', 'my_lessons'],
  online: ['get_online_metrics', 'recall_my_decisions', 'my_lessons'],
  salon: ['get_salon_metrics', 'recall_my_decisions', 'my_lessons'],
};

describe.skipIf(!api)('division briefs (real database and Meterless; models, Code Mode and the data port scripted)', () => {
  const attention: Record<string, Attention[]> = {};
  const numbers: Record<string, string | null> = { finance: '+12125550123', online: '+12125550124', salon: null };
  const mine = { tasks: new Set<string>(), briefs: new Set<string>() };
  // The texts as they were queued, and the codes issued. The database blanks a code once a text is handled, and a
  // test of another lane that flushes the outbox can do that at any moment, so the tests read these instead.
  const sent = new Map<string, string>();
  const issued: { key: string; code: string; created: boolean }[] = [];
  let deps: WorkerDeps;
  let model: ReturnType<typeof scriptedModel>;
  let codeMode: ReturnType<typeof fakeCodeMode>;

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
        addOutbox: async (o) => { if (!sent.has(o.dedupeKey)) sent.set(o.dedupeKey, o.body); return real.addOutbox(o); },
        issueApproval: async (a) => {
          const result = await real.issueApproval(a);
          issued.push({ key: a.smsDedupeKey, code: a.code, created: result.created });
          if (result.created) sent.set(a.smsDedupeKey, a.smsBody);
          return result;
        },
      },
      brain: await openBrain({ meterlessDir, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fahq-brief-')), actor: 'brief-test' }),
      models: { nvidia: undefined as unknown as ModelPort, planModel: 'MOCK/plans', routerModel: 'MOCK/router' },
      guard: null,
      data,
      delivery: null,
      codeMode: null,
      profiles: { skill: (id) => `SKILL(${id})`, model: (id, job) => `MOCK/${id}/${job}`, reads: (id) => reads[id] ?? [] },
      now: () => new Date(),
      worker: 'brief-test-worker',
      live: false,
      period: '2026-09',
      smsLive: false,
      printers: {},
      printDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fahq-brief-print-')),
    };
  });

  beforeEach(() => {
    for (const k of Object.keys(attention)) delete attention[k];
    numbers.finance = '+12125550123';
    numbers.online = '+12125550124';
    numbers.salon = null;
    model = scriptedModel();
    codeMode = fakeCodeMode();
    deps.models = { ...deps.models, nvidia: model.port };
    deps.codeMode = codeMode.runner;
    codeMode.respond(() => okResult(salonFacts));
  });

  // Leave nothing pending for other lanes' tests, which share this database.
  afterEach(async () => {
    const keys = [...mine.briefs].flatMap((id) => [`brief-sms:${id}`, `brief-print:${id}`]).concat([...mine.tasks].map((id) => `reply:${id}`));
    await pool.query(
      `update public.outbox set status = 'skipped', last_error = 'reset by brief test', body = regexp_replace(body, '\\m[0-9]{6}\\M', '••••••', 'g') where status = 'pending' and dedupe_key = any($1)`, [keys]);
    await pool.query(
      `update public.approvals set status = 'expired' where status = 'pending' and message_id in (select id from public.assistant_messages where dedupe_key like 'briefdoc:brief:%:21__-__-__')`);
  });

  const taskOf = async (assistant: string, kind: 'scheduled' | 'inbound_text', payload: Record<string, unknown>, key = `brief-test:${randomUUID()}`): Promise<TaskRow> => {
    const id = (await pool.query(
      `insert into public.tasks (assistant_id, kind, idempotency_key, payload, status) values ($1, $2, $3, $4::jsonb, 'done') returning id`,
      [assistant, kind, key, JSON.stringify(payload)])).rows[0].id as string;
    mine.tasks.add(id);
    return { id, assistant_id: assistant as TaskRow['assistant_id'], kind, status: 'done', payload, attempts: 1, max_attempts: 3 };
  };
  const briefTask = (division: BriefDivision, date: string, over: Record<string, unknown> = {}) =>
    taskOf(DIVISION_ASSISTANT[division], 'scheduled', { job: 'division_brief', division, date, ...over }, `brief:${division}:${date}`);

  const run = async (division: BriefDivision, date = freshDate()) => {
    const task = await briefTask(division, date);
    const outcome = await handleTask(task, deps);
    const key = `brief:${division}:${date}`;
    const row = (await pool.query("select *, to_char(brief_date, 'YYYY-MM-DD') as day from public.division_briefs where brief_key = $1", [key])).rows[0];
    if (row) mine.briefs.add(row.id);
    return { task, outcome, key, date, row };
  };
  const rows = async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows;
  const message = async (dedupeKey: string) => (await rows('select * from public.assistant_messages where dedupe_key = $1', [dedupeKey]))[0];
  const outbox = async (dedupeKey: string) => (await rows('select * from public.outbox where dedupe_key = $1', [dedupeKey]))[0];
  const approvalsOf = (key: string) => rows(
    `select a.action, a.status, a.approver_person_id, extract(epoch from (a.expires_at - a.created_at))::int as ttl
       from public.approvals a join public.assistant_messages m on m.id = a.message_id where m.dedupe_key = $1`, [`briefdoc:${key}`]);
  const stepsOf = (taskId: string) => rows('select step, outcome, assistant_id, model, data_source, detail from public.receipts where task_id = $1 order by id', [taskId]);
  const codeIn = (body: string | undefined) => /APPROVE <1-3> (\d{6})/.exec(body ?? '')?.[1] ?? '';

  it('writes the finance head a brief: numbers → no questions → a checked brief → a text with a code, a printout and a line for the CEO', async () => {
    attention.finance = [{ metricId: 'm:online.ads.google.roas', level: 'watch', rule: 'return below target' }];
    model.script('finance.needs', none);
    model.script('finance.brief', JSON.stringify({ ...financeBrief, status: 'normal' })); // a status from the model is ignored
    const { task, outcome, key, row } = await run('finance');
    expect(outcome).toEqual({ status: 'done' });

    // Stored once: the status comes from the attention rules, and the model's own status is not in the brief.
    expect(row).toMatchObject({ division: 'finance', status: 'watch', written_by: 'model', period: '2026-09', ceo_line: financeBrief.ceoLine, task_id: task.id, data_source: 'zetaris:fortune_demo_finance_mart#cccccccccccc' });
    expect(row.brief).toEqual(financeBrief);

    // The models: one needs call (the division's code model) and one brief call (the plan model), reasoning on, JSON.
    expect(model.calls.map((c) => c.purpose)).toEqual(['finance.needs', 'finance.brief']);
    const [needs, writer] = model.calls;
    expect(needs).toMatchObject({ model: 'MOCK/finance/code', json: true, thinking: true, system: `SKILL(finance)\n\n${NEEDS_RULES}` });
    expect(writer).toMatchObject({ model: 'MOCK/plans', json: true, thinking: true, system: `SKILL(finance)\n\n${BRIEF_RULES}` });
    const given = JSON.parse(writer!.user);
    expect(given).toMatchObject({ division: 'finance', status: 'watch', period: '2026-09', replies: [], ownerLessons: [], attention: attention.finance });
    expect(given.metrics.map((m: { id: string }) => m.id)).toEqual(mockMetrics.map((m) => m.id));
    expect(codeMode.calls).toHaveLength(0);

    // The head's text: status, headline, findings, actions, and one code that lasts 12 hours.
    const sms = sent.get(`brief-sms:${row.id}`);
    expect(await outbox(`brief-sms:${row.id}`)).toMatchObject({ channel: 'sms', to_person_id: HEAD.finance, from_assistant: 'finance' });
    const code = codeIn(sms);
    expect(code).toMatch(/^\d{6}$/);
    expect(sms).toBe([
      `Finance brief for ${row.day} (status WATCH)`, financeBrief.headline,
      'Findings:', `- ${financeBrief.findings[0]!.text}`, `- ${financeBrief.findings[1]!.text}`,
      'Actions:', `Action 1: Hold Google spend - ${financeBrief.actions[0]!.why}`,
      `Reply APPROVE <1-3> ${code} to approve an action. The code expires in 12 hours.`,
    ].join('\n'));
    expect(await approvalsOf(key)).toEqual([{ action: 'approve_action', status: 'pending', approver_person_id: HEAD.finance, ttl: 12 * 3600 }]);
    expect(await outbox(`brief-print:${row.id}`)).toMatchObject({ channel: 'print', to_person_id: HEAD.finance, attachment_ref: `brief:${row.id}` });

    // The mailbox: the brief's own row (the code hangs from it), the needs note, and the CEO's line (status and one sentence).
    expect(await message(`briefdoc:${key}`)).toMatchObject({ from_assistant: 'finance', to_assistant: 'finance', kind: 'report', body: { type: 'division_brief', briefId: row.id, status: 'watch' } });
    expect(await message(`needs:${key}`)).toMatchObject({ kind: 'report', body: { type: 'data_needs', requests: [] } });
    expect(await message(`status:${key}`)).toMatchObject({
      from_assistant: 'finance', to_assistant: 'owner', kind: 'report',
      body: { type: 'division_status', division: 'finance', status: 'watch', ceoLine: financeBrief.ceoLine, briefId: row.id },
    });

    // A receipt per step, with the data source on the first.
    expect((await stepsOf(task.id)).map((s) => [s.step, s.outcome])).toEqual([['brief.data', 'ok'], ['brief.needs', 'ok'], ['brief.write', 'ok'], ['brief.deliver', 'ok']]);
    expect((await stepsOf(task.id))[0]).toMatchObject({ assistant_id: 'finance', data_source: 'zetaris:fortune_demo_finance_mart#cccccccccccc' });
  });

  it('a question to another division is a mailbox request that the OTHER division answers with its own profile', async () => {
    // Online asks the salon; the model also names itself, hq and the salon twice: those are dropped.
    model.script('online.needs', JSON.stringify({ requests: [
      { division: 'salon', question: 'How many appointments did the salon book?' }, { division: 'online', question: 'me' },
      { division: 'hq', question: 'ceo' }, { division: 'salon', question: 'again' },
    ] }));
    model.script('online.brief', JSON.stringify(onlineBrief));
    const { task, outcome, key, row } = await run('online');
    expect(outcome).toEqual({ status: 'done' });

    // One request, from online to the salon, typed and keyed.
    const request = await message(`datareq:${key}:salon`);
    expect(request).toMatchObject({ from_assistant: 'online', to_assistant: 'salon', kind: 'request', status: 'answered', body: { type: 'data_request', briefKey: key, question: 'How many appointments did the salon book?' } });
    expect(await rows(`select id from public.assistant_messages where dedupe_key like $1`, [`datareq:${key}:%`])).toHaveLength(1);

    // The salon answered with ITS skill, ITS code model and ITS tools, not online's.
    expect(codeMode.calls).toHaveLength(1);
    expect(codeMode.calls[0]).toMatchObject({ purpose: 'salon.lookup', model: 'MOCK/salon/code', skill: 'SKILL(salon)' });
    expect(codeMode.calls[0]!.tools.map((t) => t.name)).toEqual(reads.salon);
    expect(codeMode.calls[0]!.question).toContain('The Online division asks you: How many appointments did the salon book?');

    // The reply is a mailbox report from the salon to online, replying to the request, carrying the lookup's metric values as facts.
    const reply = await message(`datareply:${request.id}`);
    expect(reply).toMatchObject({ from_assistant: 'salon', to_assistant: 'online', kind: 'report', reply_to: request.id, body: { type: 'data_reply', ok: true, facts: salonMetrics, briefKey: key } });

    // The writer was given the reply as facts, and the brief uses a salon number from it (and stays inside the rules).
    const given = JSON.parse(model.of('online.brief')[0]!.user);
    expect(given.replies).toEqual([{ from: 'salon', question: 'How many appointments did the salon book?', facts: salonMetrics }]);
    expect(given.metrics.every((m: { business: string }) => m.business === 'online')).toBe(true);
    expect(row.brief.findings[1].text).toContain('310');
    expect(row.status).toBe('normal');

    // Receipts: the online steps, and the salon's lookup under the salon's name.
    const steps = await stepsOf(task.id);
    expect(steps.map((s) => [s.step, s.assistant_id, s.outcome])).toEqual([
      ['brief.data', 'online', 'ok'], ['brief.needs', 'online', 'ok'], ['salon.lookup', 'salon', 'ok'], ['brief.write', 'online', 'ok'], ['brief.deliver', 'online', 'ok'],
    ]);
    expect(steps[1]!.detail).toBe('asks salon');
    expect(steps[2]!.detail).toContain('code mode: attempts 1');

    // The request is in the World Model: who asked it, and which assistant it went to.
    const recorded = deps.brain.record.audit(3000).map((a) => a.summary).filter((s) => s.includes(request.id));
    expect(recorded.some((s) => s.includes('-[assigned_to]->'))).toBe(true);
    expect(recorded.some((s) => s.includes('-[asked]->'))).toBe(true);
  });

  it('a question with medical wording, a phone number or a code is never posted: no mailbox row, no World Model record, no lookup, and the brief still goes out', async () => {
    model.script('online.needs', JSON.stringify({ requests: [
      { division: 'salon', question: 'How many hair loss clients booked toppers last month?' },
      { division: 'finance', question: 'Call 212-555-0123 and ask what the ad return was.' },
    ] }));
    model.script('online.brief', JSON.stringify({ ...onlineBrief, findings: [onlineBrief.findings[0]], actions: [] }));
    const before = deps.brain.record.audit(3000).length;
    const { key, task, outcome } = await run('online');
    expect(outcome).toEqual({ status: 'done' });
    expect(await rows(`select id from public.assistant_messages where dedupe_key like $1`, [`datareq:${key}:%`])).toEqual([]);
    expect(codeMode.calls).toHaveLength(0);
    expect(deps.brain.record.audit(3000).slice(before).map((a) => a.summary).join('\n')).not.toMatch(/hair loss|212-555/i);
    // The note records that two were dropped and why, never the words themselves.
    const note = await message(`needs:${key}`);
    expect(note.body).toMatchObject({ type: 'data_needs', requests: [], dropped: ['medical wording', 'a phone number'] });
    expect(JSON.stringify(note.body)).not.toMatch(/hair loss|212-555/i);
    const needs = (await stepsOf(task.id)).find((s) => s.step === 'brief.needs')!;
    expect(needs).toMatchObject({ outcome: 'ok' });
    expect(needs.detail).toBe('no questions went out; dropped 2 questions that broke the rules (medical wording, a phone number)');
    expect(JSON.parse(model.of('online.brief')[0]!.user).replies).toEqual([]);
  });

  it('a question that passes the rules is still posted when another one is dropped', async () => {
    model.script('online.needs', JSON.stringify({ requests: [
      { division: 'finance', question: 'What did the patient customers spend?' }, { division: 'salon', question: 'How many appointments did the salon book?' },
    ] }));
    model.script('online.brief', JSON.stringify(onlineBrief));
    const { key, task } = await run('online');
    expect(await rows(`select id from public.assistant_messages where dedupe_key like $1`, [`datareq:${key}:%`])).toHaveLength(1);
    expect(await message(`datareq:${key}:salon`)).toMatchObject({ body: { question: 'How many appointments did the salon book?' } });
    expect((await stepsOf(task.id)).find((s) => s.step === 'brief.needs')!.detail).toBe('asks salon; dropped 1 question that broke the rules (medical wording)');
  });

  it('a brief whose actions are ranked 1 and 3 is stored as 1 and 2, and the text tells the head the ranks she can use', async () => {
    const gapped = { ...financeBrief, actions: [{ ...financeBrief.actions[0]!, rank: 1 }, { ...financeBrief.actions[0]!, rank: 3, title: 'Review the ad copy' }] };
    model.script('finance.needs', none);
    model.script('finance.brief', JSON.stringify(gapped));
    const { row, key } = await run('finance');
    expect(row.brief.actions.map((a: { rank: number; title: string }) => [a.rank, a.title])).toEqual([[1, 'Hold Google spend'], [2, 'Review the ad copy']]);
    const sms = sent.get(`brief-sms:${row.id}`)!;
    const code = codeIn(sms);
    expect(sms).toContain(`(APPROVE 1 2 ${code} for more)`);
    // Following the text does what it says: both actions are recorded.
    expect((await text(HEAD.finance, `APPROVE 1 2 ${code}`)).reply).toBe("Recorded: you approved action 1 (Hold Google spend) and action 2 (Review the ad copy). They're yours to carry out.");
    expect(await rows(`select id from public.assistant_messages where dedupe_key like $1`, [`action-decision:${(await message(`briefdoc:${key}`)).id}:%`])).toHaveLength(2);
  });

  it('an answer the other division cannot give is stored as unavailable, and the writer is told', async () => {
    deps.codeMode = null; // Code Mode is not connected here
    model.script('online.needs', asks('salon'));
    model.script('online.brief', JSON.stringify({ ...onlineBrief, findings: [onlineBrief.findings[0]], actions: [] }));
    const { key, outcome, task } = await run('online');
    expect(outcome).toEqual({ status: 'done' });
    const request = await message(`datareq:${key}:salon`);
    expect((await message(`datareply:${request.id}`)).body).toMatchObject({ type: 'data_reply', ok: false, reason: "Code Mode isn't connected on this machine" });
    expect(JSON.parse(model.of('online.brief')[0]!.user).replies).toEqual([{ from: 'salon', question: expect.any(String), unavailable: "Code Mode isn't connected on this machine" }]);
    expect((await stepsOf(task.id)).find((s) => s.step === 'salon.lookup')).toMatchObject({ outcome: 'failed', detail: "Code Mode isn't connected on this machine" });
  });

  it('a script that fails is a plain reason from the target, not a crash', async () => {
    codeMode.respond(() => okResult(null, { ok: false, error: 'the script threw: x is not defined', result: null, toolOutputs: [] }));
    model.script('finance.needs', asks('salon'));
    model.script('finance.brief', JSON.stringify(financeBrief));
    const { key } = await run('finance');
    const request = await message(`datareq:${key}:salon`);
    expect((await message(`datareply:${request.id}`)).body).toMatchObject({ ok: false, reason: 'the script threw: x is not defined' });
  });

  // What the writer is told when a reply cannot be used, and the step's receipt.
  const refusedReply = async (asker: BriefDivision, target: string, brief: unknown) => {
    model.script(`${asker}.needs`, asks(target));
    model.script(`${asker}.brief`, JSON.stringify(brief));
    const { key, task, row } = await run(asker);
    const request = await message(`datareq:${key}:${target}`);
    const reply = await message(`datareply:${request.id}`);
    const told = JSON.parse(model.of(`${asker}.brief`)[0]!.user).replies;
    const step = (await stepsOf(task.id)).find((s) => s.step === `${target}.lookup`)!;
    return { reply, told, step, row };
  };
  const onlineAsksSalon = { ...onlineBrief, findings: [onlineBrief.findings[0]], actions: [] };

  it('a reply carrying a number no tool returned (a sum of two businesses, say) is refused, whole, and the writer is told it is unavailable', async () => {
    // Online asks Finance for revenue; Finance's script adds the salon's number to the online one: 6200 + 12400 is nobody's data.
    const outputs = { metrics: [{ id: 'm:online.revenue.mazali', value: 12400 }, { id: 'm:salon.revenue.wash_set', value: 6200 }] };
    codeMode.respond(() => lookedUp({ total: 18600, parts: [{ id: 'm:online.revenue.mazali', value: 12400 }] }, outputs));
    const { reply, told, step } = await refusedReply('online', 'finance', onlineAsksSalon);
    expect(reply.body).toMatchObject({ type: 'data_reply', ok: false, reason: 'the answer had a number that no data tool returned, so none of it can be used' });
    expect(reply.body).not.toHaveProperty('facts');
    expect(told).toEqual([{ from: 'finance', question: expect.any(String), unavailable: 'the answer had a number that no data tool returned, so none of it can be used' }]);
    expect(step).toMatchObject({ outcome: 'refused', assistant_id: 'finance' });
    expect(step.detail).toContain('untraced 1');
  });

  it('a reply whose numbers carry no metric id is refused: a number with no business cannot be kept off the other side', async () => {
    // 310 is a number the tool returned, but nothing says it is the salon's.
    codeMode.respond(() => lookedUp({ appointments: 310 }, { metrics: [{ id: 'm:salon.appointments.count', value: 310 }] }));
    const { reply, told, step } = await refusedReply('online', 'salon', onlineAsksSalon);
    expect(reply.body).toMatchObject({ ok: false, reason: 'the answer had no metric values tied to a metric id, so none of it can be used' });
    expect(told).toEqual([{ from: 'salon', question: expect.any(String), unavailable: 'the answer had no metric values tied to a metric id, so none of it can be used' }]);
    expect(step).toMatchObject({ outcome: 'refused', assistant_id: 'salon' });
  });

  it('a reply keeps only the metric ids and values of the business that answered, and the writer sees nothing else', async () => {
    const output = { metrics: [{ id: 'm:salon.appointments.count', value: 310, unit: 'count', label: 'Salon appointments (30 days)' }, { id: 'm:online.revenue.mazali', value: 12400, unit: 'usd' }] };
    codeMode.respond(() => lookedUp({ rows: output.metrics, note: 'Appointments for the last 30 days' }, output));
    model.script('online.needs', asks('salon'));
    model.script('online.brief', JSON.stringify(onlineBrief));
    const { key } = await run('online');
    const request = await message(`datareq:${key}:salon`);
    // The salon's own id and value, with no label and no online metric: the other business never rides along in a salon answer.
    expect((await message(`datareply:${request.id}`)).body).toMatchObject({ ok: true, facts: salonMetrics });
  });

  it('a brief with a number nobody gave it is corrected once, then refused, and a program writes the brief from the rules', async () => {
    attention.finance = [{ metricId: 'm:online.ads.google.roas', level: 'act', rule: 'return below target' }];
    const untraced = JSON.stringify({ ...financeBrief, headline: 'Spend reached $9,999 on Google.' });
    model.script('finance.needs', none);
    model.script('finance.brief', untraced); // the last reply repeats
    const { task, outcome, row } = await run('finance');
    expect(outcome).toEqual({ status: 'done' });

    // Two attempts; the second carries the exact objection.
    const attempts = model.of('finance.brief');
    expect(attempts).toHaveLength(2);
    expect(JSON.parse(attempts[0]!.user)).not.toHaveProperty('previousAttemptRejectedBecause');
    expect(JSON.parse(attempts[1]!.user).previousAttemptRejectedBecause).toEqual(['headline: "9,999" is not a number in the data']);

    // The fallback is marked, uses only the attention list and the metrics' labels and values, and still reaches the head.
    expect(row).toMatchObject({ status: 'act', written_by: 'rule' });
    expect(row.brief.headline).toBe('Rule-written brief, because the usual write-up did not pass its number check. Status: act.');
    expect(row.brief.findings[0]).toEqual({ text: 'Google ad return is 2.40x. Rule that fired (act): return below target', cites: ['m:online.ads.google.roas'] });
    expect(row.brief.actions[0]).toMatchObject({ rank: 1, title: 'Look at Google ad return' });
    expect(row.ceo_line).toBe('Finance needs a decision from its head.');
    const sms = sent.get(`brief-sms:${row.id}`);
    expect(sms).toContain('(status ACT) - written by rules: the usual write-up did not pass its number check');
    expect(codeIn(sms)).toMatch(/^\d{6}$/);
    const write = (await stepsOf(task.id)).find((s) => s.step === 'brief.write')!;
    expect(write).toMatchObject({ outcome: 'refused', model: 'MOCK/MOCK/plans' });
    expect(write.detail).toBe('attempts 2; rule-written brief used; headline: "9,999" is not a number in the data');
  });

  it('a brief that fails its check once and passes on the correction round is the model\'s brief', async () => {
    model.script('finance.needs', none);
    model.script('finance.brief', JSON.stringify({ ...financeBrief, findings: [{ text: 'x', cites: ['m:online.not.real'] }] }), JSON.stringify(financeBrief));
    const { task, row } = await run('finance');
    expect(row).toMatchObject({ written_by: 'model', status: 'normal' });
    expect(JSON.parse(model.of('finance.brief')[1]!.user).previousAttemptRejectedBecause).toEqual(['finding 1: "m:online.not.real" is not a metric id in the data you were given']);
    expect((await stepsOf(task.id)).find((s) => s.step === 'brief.write')!.detail).toContain('attempts 2');
  });

  it('a writer model that cannot be reached also falls back to the rules, and the receipt says it failed', async () => {
    model.script('finance.needs', none);
    model.script('finance.brief', new Error('the provider is down'));
    const { task, row } = await run('finance');
    expect(row.written_by).toBe('rule');
    const write = (await stepsOf(task.id)).find((s) => s.step === 'brief.write')!;
    expect(write).toMatchObject({ outcome: 'failed' });
    expect(write.detail).toContain('the provider is down');
  });

  it('runs again after the brief was stored: no model is asked twice and no second code is issued', async () => {
    attention.finance = [{ metricId: 'm:online.ads.google.roas', level: 'watch', rule: 'return below target' }];
    model.script('finance.needs', asks('salon'));
    model.script('finance.brief', JSON.stringify(financeBrief));
    const first = await run('finance');
    const firstCode = codeIn(sent.get(`brief-sms:${first.row.id}`));
    const before = { calls: model.calls.length, code: codeMode.calls.length };
    expect(before).toEqual({ calls: 2, code: 1 });

    // The same task, twice more (as after a crash or a lost lease).
    expect(await handleTask(first.task, deps)).toEqual({ status: 'done' });
    expect(await handleTask(first.task, deps)).toEqual({ status: 'done' });

    expect({ calls: model.calls.length, code: codeMode.calls.length }).toEqual(before);
    expect(await rows('select id from public.division_briefs where brief_key = $1', [first.key])).toHaveLength(1);
    expect(await approvalsOf(first.key)).toHaveLength(1);
    // Each run tried to issue a code; only the first was created, and it is the one that still works.
    expect(issued.filter((i) => i.key === `brief-sms:${first.row.id}`).map((i) => i.created)).toEqual([true, false, false]);
    expect(await rows(`select id from public.outbox where dedupe_key in ($1, $2)`, [`brief-sms:${first.row.id}`, `brief-print:${first.row.id}`])).toHaveLength(2);
    expect(await rows(`select id from public.assistant_messages where dedupe_key in ($1, $2, $3, $4)`, [`status:${first.key}`, `briefdoc:${first.key}`, `needs:${first.key}`, `datareq:${first.key}:salon`])).toHaveLength(4);
    // The code the later runs made up was never valid; the first one is.
    const lateCode = issued.find((i) => i.key === `brief-sms:${first.row.id}` && !i.created)!.code;
    expect((await text(HEAD.finance, `APPROVE 1 ${lateCode}`)).reply).toBe("That code didn't work or has expired. Nothing was recorded.");
    expect((await text(HEAD.finance, `APPROVE 1 ${firstCode}`)).reply).toContain('Recorded: you approved action 1');
  });

  it('resumes where it stopped: a failure while sending the code is retried without asking the models again', async () => {
    model.script('finance.needs', none);
    model.script('finance.brief', JSON.stringify(financeBrief));
    const store = deps.store;
    let failNext = true;
    deps.store = { ...store, issueApproval: async (a) => { if (failNext) { failNext = false; throw new Error('the database blinked'); } return store.issueApproval(a); } };
    try {
      const date = freshDate();
      const task = await briefTask('finance', date);
      await expect(handleTask(task, deps)).rejects.toThrow('the database blinked');
      const key = `brief:finance:${date}`;
      const stored = (await rows('select id from public.division_briefs where brief_key = $1', [key]))[0];
      mine.briefs.add(stored.id);
      expect(await approvalsOf(key)).toEqual([]); // nothing was sent yet

      expect(await handleTask(task, deps)).toEqual({ status: 'done' });
      expect(model.calls.map((c) => c.purpose)).toEqual(['finance.needs', 'finance.brief']); // still only the first run's calls
      expect(await approvalsOf(key)).toHaveLength(1);
      expect(codeIn(sent.get(`brief-sms:${stored.id}`))).toMatch(/^\d{6}$/);
    } finally {
      deps.store = store;
    }
  });

  it('resumes before the brief was saved: the questions and the other division\'s answer are reused, not asked again', async () => {
    model.script('finance.needs', asks('salon'));
    model.script('finance.brief', JSON.stringify(financeBrief));
    const store = deps.store;
    let failNext = true;
    deps.store = { ...store, saveDivisionBrief: async (b) => { if (failNext) { failNext = false; throw new Error('the database blinked'); } return store.saveDivisionBrief(b); } };
    try {
      const date = freshDate();
      const task = await briefTask('finance', date);
      await expect(handleTask(task, deps)).rejects.toThrow('the database blinked');
      expect(await handleTask(task, deps)).toEqual({ status: 'done' });
      const key = `brief:finance:${date}`;
      mine.briefs.add((await rows('select id from public.division_briefs where brief_key = $1', [key]))[0].id);
      // Asked once, answered once; only the writer (whose result was not saved) ran again.
      expect(model.calls.map((c) => c.purpose)).toEqual(['finance.needs', 'finance.brief', 'finance.brief']);
      expect(codeMode.calls).toHaveLength(1);
      expect(await rows(`select id from public.assistant_messages where dedupe_key like $1`, [`datareq:${key}:%`])).toHaveLength(1);
      expect(await approvalsOf(key)).toHaveLength(1);
    } finally {
      deps.store = store;
    }
  });

  it('sends no text when the assistant has no live number, and says so; the brief is still stored and printed', async () => {
    model.script('salon.needs', none);
    model.script('salon.brief', JSON.stringify(salonBrief));
    const { task, outcome, key, row } = await run('salon'); // the salon has no number at all
    expect(outcome).toEqual({ status: 'done' });
    expect(row).toMatchObject({ division: 'salon', status: 'normal', written_by: 'model' });
    expect(await outbox(`brief-sms:${row.id}`)).toBeUndefined();
    expect(await approvalsOf(key)).toEqual([]);
    expect(await outbox(`brief-print:${row.id}`)).toMatchObject({ channel: 'print', to_person_id: HEAD.salon });
    expect(await message(`status:${key}`)).toMatchObject({ to_assistant: 'owner', body: { status: 'normal', ceoLine: salonBrief.ceoLine } });
    const sms = (await stepsOf(task.id)).find((s) => s.step === 'brief.sms')!;
    expect(sms).toMatchObject({ outcome: 'refused', assistant_id: 'salon' });
    expect(sms.detail).toBe('no text sent: the Salon assistant has no live number; the brief is stored and printed');
  });

  it('a +1555 placeholder is not a live number either', async () => {
    numbers.finance = '+15550100002';
    model.script('finance.needs', none);
    model.script('finance.brief', JSON.stringify(financeBrief));
    const { task, row } = await run('finance');
    expect(await outbox(`brief-sms:${row.id}`)).toBeUndefined();
    expect((await stepsOf(task.id)).some((s) => s.step === 'brief.sms' && s.outcome === 'refused')).toBe(true);
  });

  it('a brief with no actions is texted without a code', async () => {
    numbers.salon = '+12125550125';
    model.script('salon.needs', none);
    model.script('salon.brief', JSON.stringify(salonBrief));
    const { key, row } = await run('salon');
    const sms = sent.get(`brief-sms:${row.id}`)!;
    expect(sms.endsWith('\nNothing needs your approval today.')).toBe(true);
    expect(sms).not.toMatch(/\b\d{6}\b/);
    expect(await approvalsOf(key)).toEqual([]);
  });

  it('a needs answer that cannot be read means no questions, with a refused receipt, and the brief still goes out', async () => {
    model.script('finance.needs', 'I need nothing, thanks.');
    model.script('finance.brief', JSON.stringify(financeBrief));
    const { task, outcome, key } = await run('finance');
    expect(outcome).toEqual({ status: 'done' });
    expect(await message(`needs:${key}`)).toMatchObject({ body: { requests: [], note: expect.stringContaining('') } });
    const needs = (await stepsOf(task.id)).find((s) => s.step === 'brief.needs')!;
    expect(needs.outcome).toBe('refused');
    expect(needs.detail).toMatch(/^no questions asked: /);
  });

  it('a needs model that cannot be reached stops the task before any brief is stored; the next run goes on', async () => {
    model.script('finance.needs', new Error('the provider is down'));
    const date = freshDate();
    const task = await briefTask('finance', date);
    await expect(handleTask(task, deps)).rejects.toThrow('the provider is down');
    expect(await rows('select id from public.division_briefs where brief_key = $1', [`brief:finance:${date}`])).toEqual([]);
    expect((await stepsOf(task.id)).find((s) => s.step === 'brief.needs')).toMatchObject({ outcome: 'failed', detail: 'the provider is down' });

    model.script('finance.needs', none);
    model.script('finance.brief', JSON.stringify(financeBrief));
    expect(await handleTask(task, deps)).toEqual({ status: 'done' });
    mine.briefs.add((await rows('select id from public.division_briefs where brief_key = $1', [`brief:finance:${date}`]))[0].id);
  });

  it('fails plainly, with a receipt, when the numbers cannot be read, and stores no brief', async () => {
    const data = deps.data;
    deps.data = { ...dataMock, getDivisionMetrics: async () => { throw new Error('Zetaris is down'); } };
    try {
      const { task, outcome, row } = await run('finance');
      expect(outcome).toEqual({ status: 'failed', error: 'the finance numbers could not be read: Zetaris is down' });
      expect(row).toBeUndefined();
      expect((await stepsOf(task.id))).toMatchObject([{ step: 'brief.data', outcome: 'failed', detail: 'Zetaris is down' }]);
      expect(model.calls).toHaveLength(0);
    } finally {
      deps.data = data;
    }
  });

  it('refuses a brief job for the wrong assistant, an unknown division or a bad date', async () => {
    const wrong = await taskOf('online', 'scheduled', { job: 'division_brief', division: 'finance', date: freshDate() });
    expect(await handleTask(wrong, deps)).toEqual({ status: 'failed', error: 'the finance brief belongs to the finance assistant, not the online assistant' });
    for (const payload of [{ division: 'hq', date: '2100-01-01' }, { division: 'finance', date: 'tomorrow' }, { division: 'finance' }]) {
      const task = await taskOf('finance', 'scheduled', { job: 'division_brief', ...payload });
      expect(await handleTask(task, deps)).toEqual({ status: 'failed', error: 'the brief job needs a division (finance, online or salon) and a date (YYYY-MM-DD)' });
    }
    expect(model.calls).toHaveLength(0);
  });

  it('queues the day\'s brief once per division, however often it is asked, and the database holds one brief a day', async () => {
    const date = freshDate();
    const far = { store: deps.store, now: () => new Date('2100-01-01T00:00:00Z') }; // not due yet: no worker can claim it
    await enqueueBrief(far, 'finance', date);
    await enqueueBrief(far, 'finance', date);
    const queued = await rows('select id, assistant_id, kind, payload, status from public.tasks where idempotency_key = $1', [`brief:finance:${date}`]);
    expect(queued).toMatchObject([{ assistant_id: 'finance', kind: 'scheduled', payload: { job: 'division_brief', division: 'finance', date }, status: 'queued' }]);
    await pool.query(`update public.tasks set status = 'cancelled' where id = $1`, [queued[0].id]);

    // The key must name the division and the day it holds.
    await expect(pool.query(`insert into public.division_briefs (division, brief_key, brief_date, period, status, written_by, brief, ceo_line)
      values ('finance', $1, $2, 'p', 'normal', 'model', '{}'::jsonb, 'x')`, [`brief:online:${date}`, date])).rejects.toThrow(/division_briefs_check/);
  });

  // ---- APPROVE -------------------------------------------------------------------------------------------

  const text = async (person: string, body: string) => {
    const phone = (await rows('select phone, assistant_id from public.people where id = $1', [person]))[0];
    const task = await taskOf(phone.assistant_id, 'inbound_text', { personId: person, from: phone.phone, body });
    const outcome = await handleTask(task, deps);
    const reply = sent.get(`reply:${task.id}`);
    return { task, outcome, reply };
  };
  const finished = async () => {
    attention.finance = [{ metricId: 'm:online.ads.google.roas', level: 'act', rule: 'return below target' }];
    model.script('finance.needs', none);
    model.script('finance.brief', JSON.stringify(financeBrief));
    const made = await run('finance');
    return { ...made, code: codeIn(sent.get(`brief-sms:${made.row.id}`)) };
  };

  it('APPROVE <rank> <code> records the head\'s decision once; the same code again does nothing', async () => {
    const { row, key, code } = await finished();
    const head = await text(HEAD.finance, `APPROVE 1 ${code}`);
    expect(head.outcome).toEqual({ status: 'done' });
    expect(head.reply).toBe("Recorded: you approved action 1 (Hold Google spend). It's yours to carry out.");
    expect(await approvalsOf(key)).toMatchObject([{ action: 'approve_action', status: 'signed' }]);
    const doc = await message(`briefdoc:${key}`);
    expect(await message(`action-decision:${doc.id}:1`)).toMatchObject({
      from_assistant: 'finance', to_assistant: 'manager', kind: 'decision', reply_to: doc.id,
      body: { type: 'action_decision', briefId: row.id, division: 'finance', rank: 1, title: 'Hold Google spend', verdict: 'approved', by: HEAD.finance },
    });
    expect(deps.brain.memory('finance').recallDecisions('Hold Google spend', 3).map((d) => d.memory.content)).toContainEqual(expect.stringContaining('approved plan 1 "Hold Google spend"'));

    const again = await text(HEAD.finance, `APPROVE 1 ${code}`);
    expect(again.reply).toBe("That code didn't work or has expired. Nothing was recorded.");
    expect(await rows(`select id from public.assistant_messages where dedupe_key like $1`, [`action-decision:${doc.id}:%`])).toHaveLength(1);
  });

  it('a plain yes decides nothing, and a code used with the wrong command word stays usable', async () => {
    const { key, code } = await finished();
    expect((await text(HEAD.finance, 'yes')).reply).toBe(APPROVAL_HINT);
    expect((await text(HEAD.finance, `SEND 1 ${code}`)).reply).toBe('That code is for approving a brief action: reply APPROVE <1-3> <code>. Nothing was sent.');
    expect((await text(HEAD.finance, `CONFIRM ${code}`)).reply).toBe('That code is for approving a brief action: reply APPROVE <1-3> <code>. Nothing was recorded.');
    expect(await approvalsOf(key)).toMatchObject([{ status: 'pending' }]);
    expect((await text(HEAD.finance, `APPROVE 1 ${code}`)).reply).toContain('Recorded: you approved action 1');
  });

  it('APPROVE for an action the brief does not have records nothing and does not spend the code: the right action with the same code still works', async () => {
    const { key, code } = await finished(); // a brief with one action
    const doc = await message(`briefdoc:${key}`);
    const decisions = () => rows(`select id from public.assistant_messages where dedupe_key like $1`, [`action-decision:${doc.id}:%`]);
    const attempts = () => rows(`select a.status, a.failed_attempts, a.used_by_task from public.approvals a where a.message_id = $1`, [doc.id]);

    const asked = await text(HEAD.finance, `APPROVE 3 ${code}`);
    expect(asked.reply).toBe('This brief has no action 3. Nothing was recorded, and your code still works.');
    expect(await decisions()).toEqual([]);
    expect((await rows(`select outcome, detail from public.receipts where task_id = $1`, [asked.task.id]))[0]).toMatchObject({ outcome: 'refused', detail: 'the brief has no action 3; the code was not spent' });
    expect(await attempts()).toEqual([{ status: 'pending', failed_attempts: 0, used_by_task: null }]);

    // One rank the brief has and one it lacks is refused whole: the head names what she means, and nothing is half done.
    expect((await text(HEAD.finance, `APPROVE 1 3 ${code}`)).reply).toBe('This brief has no action 3. Nothing was recorded, and your code still works.');
    expect(await decisions()).toEqual([]);
    expect(await attempts()).toEqual([{ status: 'pending', failed_attempts: 0, used_by_task: null }]);

    // The same code with the right action records it, once.
    expect((await text(HEAD.finance, `APPROVE 1 ${code}`)).reply).toBe("Recorded: you approved action 1 (Hold Google spend). It's yours to carry out.");
    expect(await decisions()).toHaveLength(1);
    expect(await approvalsOf(key)).toMatchObject([{ status: 'signed' }]);
  });

  it('a wrong code is still counted, and a wrong action number does not count against the right one', async () => {
    const { key, code } = await finished();
    const doc = await message(`briefdoc:${key}`);
    const wrong = String((Number(code) % 900000) + 100001).padStart(6, '0'); // a different six-digit code
    expect((await text(HEAD.finance, `APPROVE 1 ${wrong}`)).reply).toBe("That code didn't work or has expired. Nothing was recorded.");
    expect((await text(HEAD.finance, `APPROVE 3 ${code}`)).reply).toContain('no action 3');
    expect(await rows(`select status, failed_attempts from public.approvals where message_id = $1`, [doc.id])).toEqual([{ status: 'pending', failed_attempts: 1 }]);
    expect((await text(HEAD.finance, `APPROVE 1 ${code}`)).reply).toContain('Recorded: you approved action 1');
  });

  it('a spent code that finds the brief lacking an action records nothing and says so (a state the check before spending prevents)', async () => {
    // The look-before-spending finds nothing (as if the code had been taken a moment earlier), so the code is spent for an action the brief lacks.
    const { key, code } = await finished();
    const store = deps.store;
    deps.store = { ...store, peekApprovalCode: async () => null };
    try {
      const asked = await text(HEAD.finance, `APPROVE 3 ${code}`);
      expect(asked.outcome).toEqual({ status: 'failed', error: 'the brief has no action 3, though the code was spent for it: nothing was recorded' });
      expect(asked.reply).toBe('This brief has no action 3, and the code was already used up, so nothing was recorded. Text BRIEF for a new brief and a new code.');
      const doc = await message(`briefdoc:${key}`);
      expect(await rows(`select id from public.assistant_messages where dedupe_key like $1`, [`action-decision:${doc.id}:%`])).toEqual([]);
    } finally {
      deps.store = store;
    }
  });

  it('looks at a code without spending it: nothing is changed or counted, and only the right person, action and time see it', async () => {
    const { key, code } = await finished();
    const doc = await message(`briefdoc:${key}`);
    const phoneOf = async (person: string) => (await rows('select phone from public.people where id = $1', [person]))[0].phone as string;
    const finance = await phoneOf(HEAD.finance);
    const peek = (over: Partial<Parameters<typeof deps.store.peekApprovalCode>[0]> = {}) =>
      deps.store.peekApprovalCode({ phone: finance, code, action: 'approve_action', now: new Date(), ...over });
    const wrong = String((Number(code) % 900000) + 100001).padStart(6, '0');

    expect(await peek()).toEqual({ message_id: doc.id, approver_person_id: HEAD.finance });
    expect(await peek()).not.toBeNull(); // looking twice changes nothing
    expect(await peek({ code: wrong })).toBeNull();
    expect(await peek({ code: 'abcdef' })).toBeNull();
    expect(await peek({ phone: await phoneOf(HEAD.online) })).toBeNull(); // another person's phone
    expect(await peek({ action: 'adopt_change' })).toBeNull(); // another kind of code
    expect(await peek({ now: new Date(Date.now() + 13 * 3600_000) })).toBeNull(); // after the 12 hours
    expect(await rows(`select status, failed_attempts, used_by_task from public.approvals where message_id = $1`, [doc.id])).toEqual([{ status: 'pending', failed_attempts: 0, used_by_task: null }]);

    expect((await text(HEAD.finance, `APPROVE 1 ${code}`)).reply).toContain('Recorded: you approved action 1');
    expect(await peek()).toBeNull(); // spent
  });

  it('only the head the code was issued to can use it', async () => {
    const { key, code } = await finished();
    expect((await text(HEAD.online, `APPROVE 1 ${code}`)).reply).toBe("That code didn't work or has expired. Nothing was recorded.");
    expect(await approvalsOf(key)).toMatchObject([{ status: 'pending' }]);
  });
});
