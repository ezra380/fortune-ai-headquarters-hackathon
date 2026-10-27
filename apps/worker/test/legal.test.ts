import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelPort } from '@fahq/contracts';
import { openBrain } from '@fahq/brain';
import { MANAGER_LESSONS_HEADING, OWNER_LESSONS_HEADING, READ_TOOL_NAMES, doorSkill, issueDoorToken, loadProfiles, parseProfileRows } from '@fahq/profiles';
import type { WorkerDeps } from '../src/flows.ts';
import { workerProfiles } from '../src/profiles.ts';
import { createReadTools } from '../src/read-tools.ts';
import { runUntilIdle } from '../src/runner.ts';
import { createStore } from '../src/store.ts';
import { dataMock, fakeCodeMode, okResult, routerReply, SAFE, scriptedModel } from './fixtures.ts';
import { dbUrl, haveMeterless, localApi, meterlessDir } from './localdb.ts';
import { memoryProfiles } from './profile-port.ts';

// The Legal Team in the worker. Real local database (through the real Data API) and the real Meterless engines;
// the models and Code Mode are scripted. Two things are shown: the owner's text reaches the Legal Team like it reaches
// a department (a department head's never does), and what a legal door files reaches the HQ Manager and nobody else.

// Six lanes share one 8-core machine and one Postgres: the defaults (10 s a hook, 20 s a test) are not enough on a busy afternoon.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const api = haveMeterless ? localApi() : null;
if (!api) console.warn('SKIPPED Legal Team tests: needs local Supabase (npm run db:start) and Meterless (scripts/setup-meterless.sh)');

const pool = new pg.Pool({ connectionString: dbUrl, max: 3 });
const madeTokens: string[] = [];
let migrated = false;

beforeAll(async () => {
  try {
    migrated = (await pool.query(`select count(*)::int as n from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'assistant_id' and e.enumlabel = 'legal'`)).rows[0].n === 1
      && (await pool.query(`select count(*)::int as n from public.assistants where id = 'legal'`)).rows[0].n === 1;
    if (!migrated) console.warn('SKIPPED Legal Team tests: apply supabase/migrations/20261027130000_legal_value.sql and 20261027130010_legal.sql');
  } catch {
    migrated = false;
  }
});

afterAll(async () => {
  try {
    if (madeTokens.length > 0) {
      await pool.query('delete from public.session_reports where token_id = any($1)', [madeTokens]);
      await pool.query('delete from public.door_tokens where id = any($1)', [madeTokens]);
    }
  } finally {
    await pool.end();
  }
});

const sid = () => 'SM' + randomBytes(16).toString('hex');
const profiles = loadProfiles({});
const readsOf = (id: keyof typeof profiles) => [...profiles[id].reads];

describe.skipIf(!api)('the Legal Team: the owner asks by text, department heads never do (real database and Meterless; models scripted)', () => {
  const sms: { to: string; body: string }[] = [];
  let deps: WorkerDeps;
  let model: ReturnType<typeof scriptedModel>;
  let codeMode: ReturnType<typeof fakeCodeMode>;
  let ownerPhone = '';
  let salonPhone = '';

  beforeAll(async () => {
    const phones = await pool.query(`select assistant_id, phone from public.people where assistant_id in ('owner','salon')`);
    for (const r of phones.rows as { assistant_id: string; phone: string }[]) {
      if (r.assistant_id === 'owner') ownerPhone = r.phone; else salonPhone = r.phone;
    }
    deps = {
      store: createStore(api!.url, api!.key),
      brain: await openBrain({ meterlessDir, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fahq-legal-')), actor: 'legal-test' }),
      models: { nvidia: undefined as unknown as ModelPort, planModel: 'MOCK/plans', routerModel: 'MOCK/router' },
      guard: { model: 'MOCK/guard' },
      data: dataMock,
      delivery: null,
      codeMode: null,
      // The REAL profiles' read lists: an assistant can only be given the tools its profile names.
      profiles: { skill: (id) => `SKILL(${id})`, model: (id, job) => `MOCK/${id}/${job}`, reads: (id) => readsOf(id) },
      now: () => new Date(),
      worker: 'legal-test-worker',
      live: false,
      period: '2026-09',
      smsLive: false,
      printers: {},
      printDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fahq-legal-print-')),
      smsSink: (m) => sms.push(m),
    };
  });

  beforeEach(async ({ skip }) => {
    if (!migrated) skip();
    await pool.query(`update public.tasks set status = 'cancelled' where status in ('queued','running','waiting')`);
    await pool.query(`update public.approvals set status = 'expired' where status = 'pending'`);
    await pool.query(`update public.outbox set status = 'skipped', last_error = 'reset by legal test' where status in ('pending','sending')`);
    sms.length = 0;
    model = scriptedModel({ 'guard.screen': SAFE });
    codeMode = fakeCodeMode();
    codeMode.respond(() => okResult({ ok: 1 }));
    deps.models = { ...deps.models, nvidia: model.port };
    deps.codeMode = codeMode.runner;
    deps.guard = { model: 'MOCK/guard' };
  });

  const textIn = async (from: string, body: string) => {
    const messageSid = sid();
    await pool.query('select * from public.enqueue_inbound_text($1, $2, $3, $4)', [messageSid, from, '+15550100001', body]);
    await runUntilIdle(deps);
    return messageSid;
  };
  const lastTo = (phone: string) => sms.filter((m) => m.to === phone).at(-1)?.body ?? '';
  const taskOfText = async (messageSid: string) =>
    (await pool.query(`select id, status from public.tasks where idempotency_key = $1`, ['sms:' + messageSid])).rows[0] as { id: string; status: string };
  const stepsOf = async (taskId: string) =>
    (await pool.query('select step, outcome, assistant_id, model from public.receipts where task_id = $1 order by id', [taskId])).rows as
      { step: string; outcome: string; assistant_id: string; model: string | null }[];

  it('answers the owner\'s question about a contract from the Legal Team: its skill, its models and only the two tools that hold no business data', async () => {
    codeMode.respond(() => okResult({ decisions: [] }));
    model.script('front-door', routerReply('legal', 'question'));
    model.script('legal.answer', 'I have not seen the contract, so I can only say what to watch for: renewals, liability caps and who owns the data.');
    const messageSid = await textIn(ownerPhone, 'What should I watch for in a SaaS agreement?');
    expect(lastTo(ownerPhone)).toBe('[Legal Team] I have not seen the contract, so I can only say what to watch for: renewals, liability caps and who owns the data. I have not seen the document; this is not legal advice.');
    expect(codeMode.calls[0]).toMatchObject({ purpose: 'legal.lookup', model: 'MOCK/legal/code', skill: 'SKILL(legal)', question: 'What should I watch for in a SaaS agreement?' });
    expect(codeMode.calls[0]!.tools.map((t) => t.name)).toEqual(['recall_my_decisions', 'my_lessons']);
    expect(model.of('legal.answer')[0]).toMatchObject({ model: 'MOCK/legal/answer', system: expect.stringContaining('SKILL(legal)') });
    // The steps are the Legal Team's own, and the reply comes from the number the owner texted.
    const task = await taskOfText(messageSid);
    expect((await stepsOf(task.id)).map((s) => [s.step, s.outcome, s.assistant_id])).toEqual([
      ['front-door.screen', 'ok', 'owner'], ['front-door', 'ok', 'owner'], ['legal.lookup', 'ok', 'legal'], ['legal.answer', 'ok', 'legal'],
    ]);
  });

  it('texts the owner the facts as they are, never the model\'s words, when its Legal Team answer counts the fixes or quotes a notice period: the number trace holds by text too', async () => {
    // A text carries no document, so the Legal Team's only facts are its own past decisions and lessons, and today there are none.
    // The skill no longer asks for "the three things to fix first" by text (that answer is refused twice, below); what reaches
    // the owner when a model counts anyway is the facts, plainly, and the refusal is on the receipt.
    codeMode.respond(() => okResult({ decisions: [], lessons: [] }));
    model.script('front-door', routerReply('legal', 'question'));
    model.script('legal.answer', 'The three things to fix first are the renewal, the liability cap and the data clause. Ask for a 30 day notice window.');
    const messageSid = await textIn(ownerPhone, 'Review our returns policy terms.');
    // Merge wave 2: every Legal Team answer by text ends with the program's own closing, the facts included.
    expect(lastTo(ownerPhone)).toBe("[Legal Team] Here's what I found: decisions: none; lessons: none. I have not seen the document; this is not legal advice.");
    expect(model.of('legal.answer')).toHaveLength(2); // the first answer, then the one correction round
    const answer = (await stepsOf((await taskOfText(messageSid)).id)).find((s) => s.step === 'legal.answer');
    expect(answer).toMatchObject({ outcome: 'refused', assistant_id: 'legal' });
  });

  // Merge wave 2 (the legal lane's merge note): the Legal Team has its own answer rules. General guidance in plain words is
  // allowed; a figure, deadline, citation or case not in the facts is not; the program ends every answer with the closing.
  it('gives general guidance under its own answer rules, ends it with the closing, and refuses a citation that is not in the facts', async () => {
    codeMode.respond(() => okResult({ decisions: [], lessons: [] }));
    model.script('front-door', routerReply('legal', 'question'));
    model.script('legal.answer', 'Read the renewal and liability clauses closely before you sign.');
    await textIn(ownerPhone, 'What should I look for in a vendor contract?');
    expect(lastTo(ownerPhone)).toBe('[Legal Team] Read the renewal and liability clauses closely before you sign. I have not seen the document; this is not legal advice.');
    const system = model.of('legal.answer')[0]!.system;
    expect(system).toContain('general guidance');
    expect(system).toMatch(/never state a figure, deadline, citation or case/i);

    model.script('legal.answer', 'Under Smith v. Jones the clause is void.');
    const messageSid = await textIn(ownerPhone, 'Is the auto-renewal clause enforceable?');
    expect(lastTo(ownerPhone)).toBe("[Legal Team] Here's what I found: decisions: none; lessons: none. I have not seen the document; this is not legal advice.");
    const answer = (await stepsOf((await taskOfText(messageSid)).id)).find((s) => s.step === 'legal.answer');
    expect(answer).toMatchObject({ outcome: 'refused', assistant_id: 'legal' });
  });

  it('keeps the shared answer rules, and no closing, for every other asker', async () => {
    codeMode.respond(() => okResult({ waiting: [] }));
    model.script('front-door', routerReply('owner', 'question'));
    model.script('owner.answer', 'Nothing is waiting on you today.');
    await textIn(ownerPhone, 'Anything waiting on me?');
    expect(lastTo(ownerPhone)).toBe('Nothing is waiting on you today.');
    expect(model.of('owner.answer')[0]!.system).not.toContain('general guidance');
  });

  it('answers a request for plans that the router sends to the Legal Team as a question for it: no round, no department asked', async () => {
    model.script('front-door', routerReply('legal', 'plans'));
    model.script('legal.answer', 'The Legal Team reads documents; it does not write plans.');
    const messageSid = await textIn(ownerPhone, 'Give me plans to fix our returns policy terms.');
    expect(lastTo(ownerPhone)).toBe('[Legal Team] The Legal Team reads documents; it does not write plans. I have not seen the document; this is not legal advice.');
    const task = await taskOfText(messageSid);
    expect((await stepsOf(task.id)).map((s) => s.step)).toEqual(['front-door.screen', 'front-door', 'legal.lookup', 'legal.answer']);
    expect(model.of('finance.plans')).toHaveLength(0);
    const asked = await pool.query(`select count(*)::int as n from public.assistant_messages where dedupe_key like $1`, [`round:${task.id}:%`]);
    expect(asked.rows[0].n).toBe(0);
  });

  it('never lets a department head reach the Legal Team: her question is answered by her own assistant, on her own tools', async () => {
    model.script('front-door', routerReply('legal', 'question'));
    model.script('salon.answer', 'I can answer questions about the salon numbers.');
    await textIn(salonPhone, 'Can you review this vendor contract for me?');
    expect(lastTo(salonPhone)).toBe('I can answer questions about the salon numbers.');
    expect(codeMode.calls).toHaveLength(1);
    expect(codeMode.calls[0]).toMatchObject({ purpose: 'salon.lookup', model: 'MOCK/salon/code', skill: 'SKILL(salon)' });
    expect(codeMode.calls[0]!.tools.map((t) => t.name)).toEqual(readsOf('salon'));
    expect(model.of('legal.answer')).toHaveLength(0);
  });

  it('tells a department head that plans routed to the Legal Team are the owner\'s to ask for', async () => {
    model.script('front-door', routerReply('legal', 'plans'));
    await textIn(salonPhone, 'Get the legal team to write us three plans.');
    expect(lastTo(salonPhone)).toBe('The owner asks the departments for plans. I can answer questions about your own numbers.');
    expect(codeMode.calls).toHaveLength(0);
  });
});

describe.skipIf(!api)('what a legal door files reaches the HQ Manager (real database through the real Data API)', () => {
  const brain = { memory: () => ({ recallDecisions: () => [], lessons: () => [] }), record: { timeline: () => [] } };
  // The store is made inside the tests, so a machine without the local stack skips them instead of failing to collect.
  const toolsFor = (caller: Parameters<typeof createReadTools>[1]) =>
    createReadTools({ store: createStore(api!.url, api!.key), brain: brain as never, data: null, now: () => new Date() }, caller);
  type Filed = { reports: { id: string; assistant: string; tool: string; summary: string; lessons: string[] }[] };

  it('lands under the legal assistant, is masked, and shows in the manager\'s list_session_reports and in the Legal Team\'s own, and in nobody else\'s', async ({ skip }) => {
    if (!migrated) skip();
    const issued = await issueDoorToken(pool, 'legal', 'legal worker test');
    madeTokens.push(issued.id);
    const marker = `legal-door-${randomBytes(4).toString('hex')}`;
    const report = {
      tool: 'claude-code', key: `legal-test:${marker}`,
      summary: `Read a vendor agreement (${marker}): auto-renewal in 12 months with a 90 day notice window; overall call Yellow. Call +1 718 555 0100 or reply 482913.`,
      steps: [{ step: 'Read every clause' }], suggestions: [{ text: 'Ask for a 30 day notice window' }], lessons: [{ text: 'Check the notice window before the renewal date' }],
    };
    const filed = (await pool.query('select public.door_file_report($1, $2::jsonb) as r', [issued.token, JSON.stringify(report)])).rows[0].r as { id: string; duplicate: boolean };
    expect(filed.duplicate).toBe(false);
    const stored = (await pool.query('select assistant_id, token_id, summary from public.session_reports where id = $1', [filed.id])).rows[0];
    expect(stored).toMatchObject({ assistant_id: 'legal', token_id: issued.id });
    expect(stored.summary).toContain('[phone]');
    expect(stored.summary).toContain('[code]');
    expect(stored.summary).not.toMatch(/718|482913/);

    // The HQ Manager reads every door's reports, the legal door's among them, and asks for it by name too.
    for (const args of [{ sinceHours: 24, onlyNew: true }, { sinceHours: 24, assistant: 'legal' }]) {
      const out = (await toolsFor('manager').list_session_reports!.run(args)) as Filed;
      const mine = out.reports.find((r) => r.id === filed.id);
      expect(mine, JSON.stringify(args)).toMatchObject({ assistant: 'legal', tool: 'claude-code', lessons: ['Check the notice window before the renewal date'] });
    }
    // The Legal Team reads the reports filed at its own door.
    const own = (await toolsFor('legal').list_session_reports!.run({ sinceHours: 24 })) as Filed;
    expect(own.reports.some((r) => r.id === filed.id)).toBe(true);
    expect(own.reports.every((r) => r.assistant === 'legal')).toBe(true);
    // The salon, the online store, finance and the owner never see it.
    for (const caller of ['salon', 'online', 'finance', 'owner'] as const) {
      const theirs = (await toolsFor(caller).list_session_reports!.run({ sinceHours: 24 })) as Filed;
      expect(theirs.reports.some((r) => r.id === filed.id), caller).toBe(false);
      await expect(toolsFor(caller).list_session_reports!.run({ sinceHours: 24, assistant: 'legal' }), caller)
        .rejects.toThrow(`list_session_reports: the ${caller} assistant reads the reports filed at its own door only.`);
    }
  });
});

// ---- The loop Ezra asked for ------------------------------------------------------------------------------------
// A staff session reports at the legal door; the HQ Manager's review reads it; the owner's one-time code puts the
// lesson into the Legal Team's profile; the next staff session and the next text answer carry it. Everything but the
// profile tables (in memory, profile-port.ts: a version can never be taken back from a real table), the models and
// Code Mode (scripted) is real: the door function, session_reports, the review task, the approval, the receipts.
// The same loop on a real profile table is proved for the Legal Team by supabase/tests/profiles.test.ts ("hands the
// Legal Team's next session the lesson the owner adopted").

const letters = (n: number) => { let s = ''; let rest = n; do { s = String.fromCharCode(97 + (rest % 26)) + s; rest = Math.floor(rest / 26); } while (rest > 0); return s; };

describe.skipIf(!api)('the loop: a Legal Team session reports, the HQ Manager reviews, the owner\'s code adopts, and the next session and the next text carry the lesson', () => {
  const sms: { to: string; body: string }[] = [];
  const profileTables = memoryProfiles();
  const mine = new Set<string>(); // the reports this file filed: the only ones the manager is shown or may close
  let deps: WorkerDeps;
  let model: ReturnType<typeof scriptedModel>;
  let codeMode: ReturnType<typeof fakeCodeMode>;
  let ownerPhone = '';

  beforeAll(async () => {
    ownerPhone = (await pool.query(`select phone from public.people where assistant_id = 'owner'`)).rows[0].phone;
    const store = createStore(api!.url, api!.key);
    const brain = await openBrain({ meterlessDir, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fahq-legal-loop-')), actor: 'legal-loop-test' });
    deps = {
      store: {
        ...store, ...profileTables.port,
        sessionReports: async (q) => (await store.sessionReports(q)).filter((r) => mine.has(r.id)),
        expireSessionReports: async (before, now) =>
          (await pool.query(`update public.session_reports set reviewed_at = $2 where created_at < $1 and reviewed_at is null and id = any($3) returning id`, [before, now, [...mine]])).rows.length,
      },
      brain,
      models: { nvidia: undefined as unknown as ModelPort, planModel: 'MOCK/plans', routerModel: 'MOCK/router' },
      guard: null, data: dataMock, delivery: null, codeMode: null,
      // The profiles the worker really builds from the (in-memory) tables, so an adopted lesson reaches the next answer by itself.
      profiles: await workerProfiles({}, profileTables.port, () => new Date(), () => undefined, brain),
      now: () => new Date(), worker: 'legal-loop-worker', live: false, period: '2026-09', smsLive: false, printers: {},
      printDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fahq-legal-loop-print-')), smsSink: (m) => sms.push(m),
    };
  });

  afterAll(async () => {
    if (mine.size > 0) await pool.query('update public.session_reports set reviewed_at = coalesce(reviewed_at, now()) where id = any($1)', [[...mine]]);
  });

  beforeEach(async ({ skip }) => {
    if (!migrated) skip();
    await pool.query(`update public.tasks set status = 'cancelled' where status in ('queued','running','waiting')`);
    await pool.query(`update public.approvals set status = 'expired' where status = 'pending'`);
    await pool.query(`update public.outbox set status = 'skipped', last_error = 'reset by legal loop test' where status in ('pending','sending')`);
    sms.length = 0;
    model = scriptedModel();
    codeMode = fakeCodeMode();
    deps.models = { ...deps.models, nvidia: model.port };
    deps.codeMode = codeMode.runner;
  });

  const textIn = async (d: WorkerDeps, body: string) => {
    await pool.query('select * from public.enqueue_inbound_text($1, $2, $3, $4)', [sid(), ownerPhone, '+15550100001', body]);
    await runUntilIdle(d);
  };
  const lastToOwner = () => sms.filter((m) => m.to === ownerPhone).at(-1)?.body ?? '';
  const OTHERS = ['owner', 'finance', 'salon', 'online', 'manager'] as const;
  // Who applies a lesson is the manager lane's rule (MANAGER_APPLIES). Each run below SAYS which mode it is in, so the proof of the
  // Legal Team's loop holds whatever the shipped default is: the owner's code, or the HQ Manager by itself (Ezra's 2026-10-27 yes).
  const MODES = {
    'the owner\'s code': { lesson: false, skill_note: false, retire: false, reads: false, model: false },
    'the HQ Manager by itself': { lesson: true, skill_note: true, retire: true, reads: false, model: false }, // MANAGER_APPLIES (the manager lane added retire)
  } as const;

  // Merge wave 2: the manager lane's rule 1 (holdsWholeReview) holds every recommendation of a review that carried an outside
  // report for the owner's code, so a lesson that came in through the legal door is the owner's to adopt in BOTH modes.
  it.each(Object.keys(MODES) as (keyof typeof MODES)[])('files at the legal door, is read by the review, becomes a version of the Legal Team\'s profile by the owner\'s code when the manager applies by %s (an outside report never applies by itself), and the next door session and the next text answer carry it', async (mode) => {
    const byOwner = true;
    const d: WorkerDeps = { ...deps, managerApplies: MODES[mode] };
    const tag = letters(randomBytes(4).readUInt32BE());
    const lesson = `Check the notice window before the renewal date (${tag}).`;

    // 1. A staff member's Claude Code finishes a vendor-agreement read and files its report at the legal door.
    const issued = await issueDoorToken(pool, 'legal', 'legal loop test');
    madeTokens.push(issued.id);
    const report = {
      tool: 'claude-code', key: `legal-loop:${tag}`,
      summary: 'Read a vendor agreement: it renews by itself and the notice window is easy to miss. Overall call Yellow.',
      steps: [{ step: 'Read every clause' }], suggestions: [{ text: 'Ask for a shorter notice window' }], lessons: [{ text: 'Check the notice window before the renewal date' }],
    };
    const filed = (await pool.query('select public.door_file_report($1, $2::jsonb) as r', [issued.token, JSON.stringify(report)])).rows[0].r as { id: string };
    mine.add(filed.id);
    expect((await pool.query('select assistant_id, reviewed_at from public.session_reports where id = $1', [filed.id])).rows[0]).toMatchObject({ assistant_id: 'legal', reviewed_at: null });

    // 2. The owner asks for the HQ Manager's review. The digest the review reads names the report (scripted Code Mode; the reader
    //    tool's own output is what marks it read), and the review model (scripted) recommends one lesson for the Legal Team.
    codeMode.respond(() => okResult(
      { outsideSessions: [{ id: filed.id, assistant: 'legal', tool: 'claude-code', lessons: ['Check the notice window before the renewal date'] }] },
      { toolOutputs: [{ tool: 'list_session_reports', output: { reports: [{ id: filed.id, assistant: 'legal', reviewed: false }] } }] },
    ));
    model.script('manager.review', JSON.stringify({
      summary: 'A Legal Team session read a vendor agreement and found the notice window easy to miss.',
      findings: [{ assistant: 'legal', text: 'It filed a report about a renewal clause.' }], // no counted word: the number trace reads "one" as a number
      recommendations: [{ rank: 1, assistant: 'legal', kind: 'lesson', change: lesson, why: 'The Legal Team filed a lesson about renewal notice windows.' }],
    }));
    const before = profileTables.versionsOf('legal').length;
    const others = OTHERS.map((id) => profileTables.versionsOf(id).length);
    await textIn(d, 'REVIEW');
    // The review read the report.
    expect((await pool.query('select reviewed_at from public.session_reports where id = $1', [filed.id])).rows[0].reviewed_at).not.toBeNull();
    const madeBy = byOwner ? 'owner' : 'manager';
    if (byOwner) {
      const asked = lastToOwner();
      expect(asked).toContain(`Needs your code:\n1. [legal] lesson: ${lesson}`);
      const code = /Reply ADOPT (?:<n>|\d) (\d{6})/.exec(asked)?.[1] ?? '';
      expect(code).toMatch(/^\d{6}$/);
      // Reading a report changes nothing: no version until the owner's code.
      expect(profileTables.versionsOf('legal')).toHaveLength(before);
      expect(profileTables.lessons('legal').map((l) => l.text)).not.toContain(lesson);
      // 3. The owner's code.
      await textIn(d, `ADOPT 1 ${code}`);
      expect(lastToOwner()).toBe("Adopted: 1 (legal). They're now in place.");
    }
    // 3. A new version of the Legal Team's profile, made by whoever applies; nobody else's profile moves.
    expect(profileTables.versionsOf('legal')).toHaveLength(before + 1);
    expect(profileTables.versionsOf('legal').at(-1)).toMatchObject({ assistant: 'legal', madeBy, change: { kind: 'lesson', rank: 1 } });
    expect(profileTables.lessons('legal').at(-1)).toMatchObject({ text: lesson, by: madeBy });
    expect(OTHERS.map((id) => profileTables.versionsOf(id).length)).toEqual(others);
    const heading = byOwner ? OWNER_LESSONS_HEADING : MANAGER_LESSONS_HEADING;
    const otherHeading = byOwner ? MANAGER_LESSONS_HEADING : OWNER_LESSONS_HEADING;

    // 4. The next staff session that loads the legal door gets the lesson, under the heading of whoever applied it (the door
    //    applies doorSkill to the stored row, which door_profile returns whole).
    const stored = parseProfileRows([await profileTables.port.profileRow('legal')], READ_TOOL_NAMES).rows.get('legal');
    expect(stored).toBeDefined();
    const prompt = doorSkill(stored!, { tools: [{ name: 'recall_my_decisions', description: 'Past decisions.' }], readNames: READ_TOOL_NAMES, canReport: true });
    // Both runs' lessons are the owner's now, so this run's is somewhere in the owner's section, not necessarily first.
    expect(prompt).toContain(heading);
    expect(prompt.slice(prompt.indexOf(heading)).split('\n## ')[0]).toContain(`\n- ${lesson}`);
    expect(prompt).not.toContain(`${otherHeading}\n- ${lesson}`);

    // 5. The next time the owner texts the Legal Team, its lookup and its answer both carry the lesson, and the salon's skill does not.
    codeMode.respond(() => okResult({ decisions: [], lessons: [] }));
    model.script('front-door', routerReply('legal', 'question'));
    model.script('legal.answer', 'I have not seen the document, so ask a staff session at my door to read it.');
    await textIn(d, 'What should I watch for in a SaaS agreement?');
    expect(lastToOwner()).toBe('[Legal Team] I have not seen the document, so ask a staff session at my door to read it. I have not seen the document; this is not legal advice.');
    expect(codeMode.calls.at(-1)).toMatchObject({ purpose: 'legal.lookup' });
    const ownersSection = (s: string) => (s.includes(heading) ? s.slice(s.indexOf(heading)).split('\n## ')[0]! : '');
    expect(ownersSection(codeMode.calls.at(-1)!.skill)).toContain(`\n- ${lesson}`);
    expect(ownersSection(model.of('legal.answer').at(-1)!.system)).toContain(`\n- ${lesson}`);
    expect(d.profiles.skill('salon')).not.toContain(lesson);
  });
});
