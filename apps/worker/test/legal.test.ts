import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelPort } from '@fahq/contracts';
import { openBrain } from '@fahq/brain';
import { issueDoorToken, loadProfiles } from '@fahq/profiles';
import type { WorkerDeps } from '../src/flows.ts';
import { createReadTools } from '../src/read-tools.ts';
import { runUntilIdle } from '../src/runner.ts';
import { createStore } from '../src/store.ts';
import { dataMock, fakeCodeMode, okResult, routerReply, SAFE, scriptedModel } from './fixtures.ts';
import { dbUrl, haveMeterless, localApi, meterlessDir } from './localdb.ts';

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
    expect(lastTo(ownerPhone)).toBe('[Legal Team] I have not seen the contract, so I can only say what to watch for: renewals, liability caps and who owns the data.');
    expect(codeMode.calls[0]).toMatchObject({ purpose: 'legal.lookup', model: 'MOCK/legal/code', skill: 'SKILL(legal)', question: 'What should I watch for in a SaaS agreement?' });
    expect(codeMode.calls[0]!.tools.map((t) => t.name)).toEqual(['recall_my_decisions', 'my_lessons']);
    expect(model.of('legal.answer')[0]).toMatchObject({ model: 'MOCK/legal/answer', system: expect.stringContaining('SKILL(legal)') });
    // The steps are the Legal Team's own, and the reply comes from the number the owner texted.
    const task = await taskOfText(messageSid);
    expect((await stepsOf(task.id)).map((s) => [s.step, s.outcome, s.assistant_id])).toEqual([
      ['front-door.screen', 'ok', 'owner'], ['front-door', 'ok', 'owner'], ['legal.lookup', 'ok', 'legal'], ['legal.answer', 'ok', 'legal'],
    ]);
  });

  it('answers a request for plans that the router sends to the Legal Team as a question for it: no round, no department asked', async () => {
    model.script('front-door', routerReply('legal', 'plans'));
    model.script('legal.answer', 'The Legal Team reads documents; it does not write plans.');
    const messageSid = await textIn(ownerPhone, 'Give me plans to fix our returns policy terms.');
    expect(lastTo(ownerPhone)).toBe('[Legal Team] The Legal Team reads documents; it does not write plans.');
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
