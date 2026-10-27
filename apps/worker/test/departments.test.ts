import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ModelPort } from '@fahq/contracts';
import { openBrain } from '@fahq/brain';
import { loadProfiles } from '@fahq/profiles';
import type { WorkerDeps } from '../src/flows.ts';
import { runConcurrently, runUntilIdle } from '../src/runner.ts';
import { UNAVAILABLE_REPLY, UNSAFE_REPLY } from '../src/screen.ts';
import { createStore } from '../src/store.ts';
import { dataMock, fakeCodeMode, okResult, routerReply, SAFE, scriptedModel, UNSAFE, validPlans } from './fixtures.ts';
import { dbUrl, haveMeterless, localApi, meterlessDir } from './localdb.ts';

// The owner asks any department, the safety screen stands in front of every free text, and several claim
// loops share the queue. Real local database and Meterless engines; models and Code Mode are scripted.

const api = haveMeterless ? localApi() : null;
if (!api) console.warn('SKIPPED department tests: needs local Supabase (npm run db:start) and Meterless (scripts/setup-meterless.sh)');

const pool = new pg.Pool({ connectionString: dbUrl, max: 3 });
afterAll(async () => pool.end());

const sid = () => 'SM' + randomBytes(16).toString('hex');
const profiles = loadProfiles({});
const readsOf = (id: keyof typeof profiles) => [...profiles[id].reads];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!api)('departments: ask any, the safety screen, claim loops (real database and Meterless; models scripted)', () => {
  const sms: { to: string; body: string }[] = [];
  let deps: WorkerDeps;
  let model: ReturnType<typeof scriptedModel>;
  let codeMode: ReturnType<typeof fakeCodeMode>;
  let ownerPhone = '';
  let financePhone = '';

  beforeAll(async () => {
    const phones = await pool.query(`select assistant_id, phone from public.people where assistant_id in ('owner','finance')`);
    for (const r of phones.rows as { assistant_id: string; phone: string }[]) {
      if (r.assistant_id === 'owner') ownerPhone = r.phone; else financePhone = r.phone;
    }
    deps = {
      store: createStore(api!.url, api!.key),
      brain: await openBrain({ meterlessDir, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fahq-departments-')), actor: 'departments-test' }),
      models: { nvidia: undefined as unknown as ModelPort, planModel: 'MOCK/plans', routerModel: 'MOCK/router' },
      guard: { model: 'MOCK/guard' },
      data: dataMock,
      delivery: null,
      codeMode: null,
      // The REAL profiles' read lists: a department can only be given the tools its profile names.
      profiles: { skill: (id) => `SKILL(${id})`, model: (id, job) => `MOCK/${id}/${job}`, reads: (id) => readsOf(id) },
      now: () => new Date(),
      worker: 'departments-test-worker',
      live: false,
      period: '2026-09',
      smsLive: false,
      printers: {},
      printDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fahq-departments-print-')),
      smsSink: (m) => sms.push(m),
    };
  });

  beforeEach(async () => {
    await pool.query(`update public.tasks set status = 'cancelled' where status in ('queued','running','waiting')`);
    await pool.query(`update public.approvals set status = 'expired' where status = 'pending'`);
    await pool.query(`update public.outbox set status = 'skipped', last_error = 'reset by departments test' where status in ('pending','sending')`);
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
    (await pool.query(`select id, assistant_id, kind, status, payload, attempts, max_attempts, last_error from public.tasks where idempotency_key = $1`, ['sms:' + messageSid])).rows[0] as
      { id: string; status: string; last_error: string | null };
  const stepsOf = async (taskId: string) =>
    (await pool.query('select step, outcome, model, input_tokens, output_tokens, detail from public.receipts where task_id = $1 order by id', [taskId])).rows as
      { step: string; outcome: string; model: string | null; input_tokens: number | null; output_tokens: number | null; detail: string | null }[];
  const toolNames = () => codeMode.calls[0]!.tools.map((t) => t.name);

  describe('the owner asks any department', () => {
    it("asks online: its skill, its models and ONLY its tools, and the reply says which department answered", async () => {
      const facts = { revenue: 12400 };
      codeMode.respond(() => okResult(facts));
      model.script('front-door', routerReply('online', 'question'));
      model.script('online.answer', 'Online Mazali revenue is 12400 dollars.');
      const messageSid = await textIn(ownerPhone, 'How is the online store doing?');
      expect(lastTo(ownerPhone)).toBe('[Online] Online Mazali revenue is 12400 dollars.');
      expect(codeMode.calls[0]).toMatchObject({ purpose: 'online.lookup', model: 'MOCK/online/code', skill: 'SKILL(online)', question: 'How is the online store doing?' });
      expect(toolNames()).toEqual(['get_online_metrics', 'recall_my_decisions', 'my_lessons']);
      expect(model.of('online.answer')[0]).toMatchObject({ model: 'MOCK/online/answer', system: expect.stringContaining('SKILL(online)') });
      // The answer comes from the number the owner texted, not from a number the owner never wrote to.
      expect((await pool.query(`select from_assistant from public.outbox where dedupe_key = $1`, [`reply:${(await taskOfText(messageSid)).id}`])).rows[0].from_assistant).toBe('owner');
      // Whatever its script asks for, online reads online numbers only.
      const online = (await codeMode.calls[0]!.tools.find((t) => t.name === 'get_online_metrics')!.run({ period: '2026-09' })) as { metrics: { business: string }[] };
      expect(online.metrics.length).toBeGreaterThan(0);
      expect(online.metrics.every((m) => m.business === 'online')).toBe(true);
    });

    it("asks the salon: the stand-in for Cindy sees salon metrics only", async () => {
      model.script('front-door', routerReply('salon', 'status'));
      model.script('salon.answer', 'Salon wash and set revenue is 6200 dollars.');
      codeMode.respond(() => okResult({ revenue: 6200 }));
      await textIn(ownerPhone, 'How is the salon doing?');
      expect(lastTo(ownerPhone)).toBe('[Salon] Salon wash and set revenue is 6200 dollars.');
      expect(codeMode.calls[0]).toMatchObject({ purpose: 'salon.lookup', model: 'MOCK/salon/code', skill: 'SKILL(salon)' });
      expect(toolNames()).toEqual(['get_salon_metrics', 'recall_my_decisions', 'my_lessons']);
      const salon = (await codeMode.calls[0]!.tools.find((t) => t.name === 'get_salon_metrics')!.run({ period: '2026-09' })) as { metrics: { id: string; business: string }[] };
      expect(salon.metrics.map((m) => m.id)).toEqual(['m:salon.revenue.wash_set', 'm:salon.appointments.count']);
      expect(salon.metrics.every((m) => m.business === 'salon')).toBe(true);
    });

    it('asks finance, and keeps Owner HQ\'s own questions unprefixed', async () => {
      model.script('front-door', routerReply('finance', 'question'));
      model.script('finance.answer', 'Google ad spend is 1800 dollars.');
      codeMode.respond(() => okResult({ spend: 1800 }));
      await textIn(ownerPhone, 'What did we spend on Google ads?');
      expect(lastTo(ownerPhone)).toBe('[Finance] Google ad spend is 1800 dollars.');
      expect(toolNames()).toEqual(['get_finance_metrics', 'recall_my_decisions', 'my_lessons', 'latest_proposal', 'explain_proposal']);

      model.script('front-door', routerReply('owner', 'question'));
      model.script('owner.answer', 'Nothing is waiting on you.');
      await textIn(ownerPhone, 'Is anything waiting?');
      expect(lastTo(ownerPhone)).toBe('Nothing is waiting on you.');
    });

    it('answers "why did you propose plan 2?" as a question, with the explain tool in reach', async () => {
      model.script('front-door', routerReply('owner', 'question'));
      model.script('owner.answer', 'It came from the salon department.');
      await textIn(ownerPhone, 'Why did you propose plan 2?');
      expect(toolNames()).toContain('explain_proposal');
      expect(lastTo(ownerPhone)).toBe('It came from the salon department.');
    });

    it('prefixes the plain failures too, and a refused answer still shows the facts', async () => {
      model.script('front-door', routerReply('online', 'question'));
      codeMode.respond(() => okResult(null, { ok: false, result: null, error: 'the script ran past its time limit', toolOutputs: [] }));
      await textIn(ownerPhone, 'How is the online store doing?');
      expect(lastTo(ownerPhone)).toBe("[Online] I couldn't look that up: the script ran past its time limit");
      codeMode.respond(() => okResult({ orders: 40 }));
      model.script('online.answer', 'There were 41 orders.');
      await textIn(ownerPhone, 'How many orders?');
      expect(lastTo(ownerPhone)).toBe("[Online] Here's what I found: orders: 40");
    });

    it("keeps the finance owner's own text with the finance Q&A, no router and no prefix", async () => {
      codeMode.respond(() => okResult({ revenue: 12400 }));
      model.script('finance.answer', 'Mazali revenue is 12400 dollars.');
      await textIn(financePhone, 'What is Mazali revenue?');
      expect(lastTo(financePhone)).toBe('Mazali revenue is 12400 dollars.');
      expect(model.of('front-door')).toHaveLength(0);
    });

    it('treats a router answer that did not validate as a question for the sender\'s own assistant', async () => {
      model.script('front-door', 'not json at all');
      model.script('owner.answer', 'Here is what I know.');
      const messageSid = await textIn(ownerPhone, 'Hmm?');
      expect(lastTo(ownerPhone)).toBe('Here is what I know.');
      expect((await stepsOf((await taskOfText(messageSid)).id)).map((s) => [s.step, s.outcome])).toEqual([['front-door.screen', 'ok'], ['front-door', 'refused'], ['owner.lookup', 'ok'], ['owner.answer', 'ok']]);
    });

    it('says plainly when the router model cannot be reached, after the screen has passed', async () => {
      model.script('front-door', new Error('nvidia request failed; no fallback model was used'));
      const messageSid = await textIn(ownerPhone, 'Give me plans.');
      expect(lastTo(ownerPhone)).toBe("I couldn't reach the routing model just now, so nothing was started. Please try again in a minute.");
      const task = await taskOfText((messageSid));
      expect(task.status).toBe('failed');
      expect((await stepsOf(task.id)).map((s) => [s.step, s.outcome])).toEqual([['front-door.screen', 'ok'], ['front-door', 'failed']]);
    });
  });

  describe('numbers a script returns that no tool returned', () => {
    it('are counted on the lookup receipt and never refused', async () => {
      // 12400 came from a tool; 18600 is a sum the script computed itself.
      codeMode.respond(() => okResult({ online: 12400, total: 18600 }, { toolOutputs: [{ tool: 'get_online_metrics', output: { online: 12400 } }] }));
      model.script('front-door', routerReply('online', 'question'));
      model.script('online.answer', 'Online made 12400 dollars and the total is 18600 dollars.');
      const messageSid = await textIn(ownerPhone, 'What is the total?');
      expect(lastTo(ownerPhone)).toBe('[Online] Online made 12400 dollars and the total is 18600 dollars.');
      const lookup = (await stepsOf((await taskOfText(messageSid)).id)).find((s) => s.step === 'online.lookup')!;
      expect(lookup).toMatchObject({ outcome: 'ok', detail: expect.stringMatching(/^code mode: attempts 1, toolCalls 3, resultChars \d+, untraced 1$/) });
    });

    it('are counted on the manager\'s digest too', async () => {
      const digest = { byAssistant: [{ assistant: 'finance', tasks: 5 }], slowest: [{ step: 'finance.plans', seconds: 112 }] };
      codeMode.respond(() => okResult(digest, { toolOutputs: [{ tool: 'usage_summary', output: { byAssistant: [{ assistant: 'finance', tasks: 5 }] } }] }));
      model.script('manager.review', JSON.stringify({ summary: 'Finance handled 5 tasks.', findings: [], recommendations: [] }));
      await textIn(ownerPhone, 'REVIEW');
      const task = (await pool.query(`select id from public.tasks where assistant_id = 'manager' order by created_at desc limit 1`)).rows[0] as { id: string };
      const digestStep = (await stepsOf(task.id)).find((s) => s.step === 'manager.digest')!;
      expect(digestStep.detail).toMatch(/untraced 1$/); // the 112 seconds
    });
  });

  describe('the safety screen', () => {
    it('stops an unsafe text before anything starts, and the router answer is not used', async () => {
      model.script('guard.screen', UNSAFE);
      model.script('front-door', routerReply('finance', 'plans', ['money'])); // would start a round if it were used
      const messageSid = await textIn(ownerPhone, 'Help me hide money from the tax office.');
      expect(lastTo(ownerPhone)).toBe(UNSAFE_REPLY);
      expect(UNSAFE_REPLY).toBe("I can't help with that request, so nothing was started.");
      const task = await taskOfText(messageSid);
      expect(task.status).toBe('failed');
      expect(task.last_error).toBe('the safety check refused this text');
      const steps = await stepsOf(task.id);
      expect(steps).toEqual([{
        step: 'front-door.screen', outcome: 'refused', model: 'MOCK/MOCK/guard', input_tokens: 100, output_tokens: 200,
        detail: 'unsafe: Criminal Planning/Confessions, Fraud/Deception',
      }]);
      expect((await pool.query(`select count(*)::int as n from public.tasks where idempotency_key = $1`, ['round:' + task.id])).rows[0].n).toBe(0);
      expect((await pool.query(`select count(*)::int as n from public.assistant_messages where dedupe_key like $1`, [`%${task.id}%`])).rows[0].n).toBe(0);
      expect(codeMode.calls).toHaveLength(0);
      expect(model.calls.map((c) => c.purpose).filter((p) => /plans|synthesis|answer/.test(p))).toEqual([]);
      // Turning a text away is the screen working: the manager's report files no prompt suggestion for it.
      expect((await pool.query(`select suggestions from public.work_reports where task_id = $1`, [task.id])).rows[0].suggestions).toEqual([]);
    });

    it.each([
      ['the screen model is down', new Error('nvidia request failed; no fallback model was used')],
      ['the screen model answers in a way nobody can read', 'The weather is nice today.'],
    ])('does not start anything when %s, and says so plainly', async (_why, reply) => {
      model.script('guard.screen', reply);
      model.script('front-door', routerReply('finance', 'plans'));
      const messageSid = await textIn(ownerPhone, 'Give me three plans.');
      expect(lastTo(ownerPhone)).toBe(UNAVAILABLE_REPLY);
      expect(UNAVAILABLE_REPLY).toBe("I couldn't run the safety check just now, so nothing was started. Please try again in a minute.");
      const task = await taskOfText(messageSid);
      expect(task.status).toBe('failed');
      expect(task.last_error).toBe('the safety check could not run');
      expect(await stepsOf(task.id)).toMatchObject([{ step: 'front-door.screen', outcome: 'failed', detail: 'the safety check could not run' }]);
      expect((await pool.query(`select count(*)::int as n from public.tasks where idempotency_key = $1`, ['round:' + task.id])).rows[0].n).toBe(0);
      // A screen that could not run is a reliability problem for the manager to see.
      expect((await pool.query(`select suggestions from public.work_reports where task_id = $1`, [task.id])).rows[0].suggestions)
        .toEqual([{ kind: 'reliability', about: 'owner', text: 'front-door.screen failed: the safety check could not run' }]);
    });

    it("screens the finance owner's text before the Q&A", async () => {
      model.script('guard.screen', UNSAFE);
      await textIn(financePhone, 'Help me hide money from the tax office.');
      expect(lastTo(financePhone)).toBe(UNSAFE_REPLY);
      expect(codeMode.calls).toHaveLength(0);
      expect(model.of('front-door')).toHaveLength(0);
    });

    it('never screens a parsed command, which no model reads', async () => {
      await textIn(ownerPhone, 'STATUS');
      await textIn(ownerPhone, 'SEND 1 123456');
      await textIn(ownerPhone, 'yes');
      await textIn(financePhone, 'CONFIRM 123456');
      await textIn(ownerPhone, 'ADOPT 1 123456');
      expect(model.calls).toEqual([]);
    });

    it('starts at the same moment as the router (neither waits for the other)', async () => {
      // The screen's answer is held until the router has been asked: if the worker asked them one after the
      // other the screen would wait for a router call that never starts, and this test would time out.
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const order: string[] = [];
      deps.models = {
        ...deps.models,
        nvidia: {
          async chat(input) {
            order.push(input.purpose);
            if (input.purpose === 'guard.screen') await gate;
            else if (input.purpose === 'front-door') release();
            const text = input.purpose === 'guard.screen' ? SAFE : input.purpose === 'front-door' ? routerReply('owner', 'question') : 'Fine.';
            return { text, model: 'MOCK', inputTokens: 1, outputTokens: 1, costUsd: 0 };
          },
        },
      };
      await textIn(ownerPhone, 'Anything to tell me?');
      expect(order.slice(0, 2).sort()).toEqual(['front-door', 'guard.screen']);
      expect(lastTo(ownerPhone)).toBe('Fine.');
    });

    it('is skipped when the guard is off, and the receipt says "screen off"', async () => {
      deps.guard = null;
      model.script('front-door', routerReply('owner', 'question'));
      model.script('owner.answer', 'Fine.');
      const messageSid = await textIn(ownerPhone, 'Anything to tell me?');
      expect(model.of('guard.screen')).toHaveLength(0);
      expect((await stepsOf((await taskOfText(messageSid)).id))[0]).toMatchObject({ step: 'front-door.screen', outcome: 'ok', model: null, detail: 'screen off' });
    });
  });

  describe('several claim loops in one process', () => {
    it('never hand one task to two loops: every text is handled once, and both loops work at the same time', async () => {
      const TASKS = 12;
      const claimed: string[] = [];
      const leases: number[] = [];
      let running = 0;
      let busiest = 0;
      const store = deps.store;
      const watched: WorkerDeps = {
        ...deps,
        store: {
          ...store,
          claimTask: async (worker, now) => {
            const task = await store.claimTask(worker, now);
            if (task) {
              claimed.push(task.id); running += 1; busiest = Math.max(busiest, running);
              leases.push(Number((await pool.query(`select extract(epoch from (lease_until - $2::timestamptz))::int as s from public.tasks where id = $1`, [task.id, now.toISOString()])).rows[0].s));
              await sleep(25); // work that takes a moment
            }
            return task;
          },
          finishTask: async (...args) => { running -= 1; return store.finishTask(...args); },
        },
      };
      const sids: string[] = [];
      for (let i = 0; i < TASKS; i++) {
        const messageSid = sid();
        sids.push(messageSid);
        await pool.query('select * from public.enqueue_inbound_text($1, $2, $3, $4)', [messageSid, ownerPhone, '+15550100001', 'STATUS']);
      }
      const cycles = await runConcurrently(watched, 2, () => false, { untilIdle: true });
      expect(cycles).toBeGreaterThanOrEqual(TASKS);
      expect(new Set(claimed).size).toBe(claimed.length); // never twice
      const rows = (await pool.query(`select id, status, attempts from public.tasks where idempotency_key = any($1)`, [sids.map((s) => 'sms:' + s)])).rows as { id: string; status: string; attempts: number }[];
      expect(rows).toHaveLength(TASKS);
      expect(rows.every((r) => r.status === 'done' && r.attempts === 1)).toBe(true);
      expect(new Set(claimed)).toEqual(new Set(rows.map((r) => r.id)));
      expect(busiest).toBe(2); // two tasks were being handled at once
      // A task stays its loop's for 15 minutes, longer than a round of plans can take, so the other loop never claims it again.
      expect(leases).toHaveLength(TASKS);
      expect(leases.every((s) => s === 900)).toBe(true);
      expect(sms.filter((m) => m.to === ownerPhone && m.body.startsWith('Open items')).length).toBe(TASKS);
    });

    it('stops after maxCycles, however much is queued', async () => {
      const sids: string[] = [];
      for (let i = 0; i < 6; i++) {
        const messageSid = sid();
        sids.push(messageSid);
        await pool.query('select * from public.enqueue_inbound_text($1, $2, $3, $4)', [messageSid, ownerPhone, '+15550100001', 'STATUS']);
      }
      expect(await runConcurrently(deps, 1, () => false, { untilIdle: true, maxCycles: 4 })).toBe(4);
      const done = (await pool.query(`select count(*)::int as n from public.tasks where idempotency_key = any($1) and status = 'done'`, [sids.map((s) => 'sms:' + s)])).rows[0].n as number;
      expect(done).toBe(4);
      await runUntilIdle(deps); // the rest, so no other test finds them waiting
    });

    it('stops when asked, and a loop that finds nothing waits and then looks again', async () => {
      expect(await runConcurrently(deps, 3, () => true, { untilIdle: false })).toBe(0);
      let stop = false;
      setTimeout(() => { stop = true; }, 150);
      const messageSid = sid();
      setTimeout(() => { void pool.query('select * from public.enqueue_inbound_text($1, $2, $3, $4)', [messageSid, ownerPhone, '+15550100001', 'STATUS']); }, 60);
      const cycles = await runConcurrently(deps, 2, () => stop, { untilIdle: false, idleMs: 10 });
      expect(cycles).toBeGreaterThanOrEqual(1);
      expect((await taskOfText(messageSid)).status).toBe('done');
    });
  });

  it('keeps plan texts working through the screen: SEND needs no model at all', async () => {
    // A round's proposal, asked for by the owner through the full path, then sent on with the code.
    model.script('front-door', routerReply('finance', 'plans'));
    model.script('finance.plans', JSON.stringify(validPlans));
    await textIn(ownerPhone, 'Three plans please.');
    const code = /SEND <1-3> (\d{6})/.exec(lastTo(ownerPhone))?.[1] ?? '';
    expect(code).toMatch(/^\d{6}$/);
    const before = model.calls.length;
    await textIn(ownerPhone, `SEND 1 ${code}`);
    expect(lastTo(ownerPhone)).toContain('Sent plan 1');
    expect(model.calls.length).toBe(before);
  });
});
