import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openBrain } from '@fahq/brain';
import type { WorkerDeps } from '../src/flows.ts';
import { runUntilIdle } from '../src/runner.ts';
import { createStore } from '../src/store.ts';
import { dataMock, modelMock } from './fixtures.ts';

// The whole chain on the real local database and the real Meterless engines. Only NVIDIA and the
// Zetaris adapter are MOCKED (fixtures.ts) until lanes B and C are merged; SMS is a dry run.

const dbUrl = process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const meterlessDir = path.resolve(process.env.METERLESS_DIR ?? '.local/meterless');

function localApi(): { url: string; key: string } | null {
  try {
    const out = execSync('npx supabase status -o env', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 });
    const get = (name: string) => out.match(new RegExp(`^${name}="?([^"\\n]*)"?$`, 'm'))?.[1];
    const url = get('API_URL');
    const key = get('SERVICE_ROLE_KEY') ?? get('SECRET_KEY');
    return url && key ? { url, key } : null;
  } catch {
    return null;
  }
}

const api = fs.existsSync(path.join(meterlessDir, 'engines')) ? localApi() : null;
if (!api) console.warn('SKIPPED chain test: needs local Supabase (npm run db:start) and Meterless (scripts/setup-meterless.sh)');

const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
afterAll(async () => pool.end());

describe.skipIf(!api)('finance chain end to end (real DB + real Meterless; models and data mocked)', () => {
  const sms: { to: string; body: string }[] = [];
  let deps: WorkerDeps;
  let ownerPhone = '';
  let financePhone = '';

  beforeAll(async () => {
    // A clean queue for this run (local test database only).
    await pool.query(`update public.tasks set status = 'cancelled' where status in ('queued','running','waiting')`);
    await pool.query(`update public.approvals set status = 'expired' where status = 'pending'`);
    await pool.query(`update public.outbox set status = 'skipped', last_error = 'reset by chain test' where status in ('pending','sending')`);
    const phones = await pool.query(`select assistant_id, phone from public.people where assistant_id in ('owner','finance')`);
    for (const r of phones.rows as { assistant_id: string; phone: string }[]) {
      if (r.assistant_id === 'owner') ownerPhone = r.phone; else financePhone = r.phone;
    }
    deps = {
      store: createStore(api!.url, api!.key),
      brain: await openBrain({ meterlessDir, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fahq-chain-')), actor: 'chain-test' }),
      models: { nvidia: modelMock(), planModel: 'nvidia/nemotron-3-ultra-550b-a55b', routerModel: 'nvidia/nemotron-3.5-lightning-30b-a3b' },
      data: dataMock,
      delivery: null,
      now: () => new Date(),
      worker: 'chain-test-worker',
      live: false,
      period: '2026-09',
      smsLive: false,
      printers: {},
      printDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fahq-print-')),
      smsSink: (m) => sms.push(m),
    };
  });

  const textIn = async (from: string, body: string) => {
    await pool.query('select * from public.enqueue_inbound_text($1, $2, $3, $4)', ['SM' + randomBytes(16).toString('hex'), from, '+15550100001', body]);
    await runUntilIdle(deps);
  };
  const lastTo = (phone: string) => sms.filter((m) => m.to === phone).at(-1)?.body ?? '';

  it('runs request → plans → forward → decision, with codes enforced at each step', async () => {
    await textIn(ownerPhone, 'Ask the finance assistant for three aggressive plans to double profit this month.');
    const proposalSms = lastTo(ownerPhone);
    expect(proposalSms).toContain("Your finance assistant's 3 plans");
    expect(proposalSms).toContain('1. Push Google ads on Mazali');
    const forwardCode = /SEND <1-3> (\d{6})/.exec(proposalSms)?.[1];
    expect(forwardCode).toMatch(/^\d{6}$/);

    await textIn(ownerPhone, 'yes');
    expect(lastTo(ownerPhone)).toContain('To approve, reply exactly');

    await textIn(ownerPhone, `SEND 2 ${forwardCode}`);
    expect(lastTo(ownerPhone)).toContain('Sent plan 2');
    const forwardSms = lastTo(financePhone);
    expect(forwardSms).toContain('plan 2: Evening wash and set slots');
    const decideCode = /CONFIRM (\d{6})/.exec(forwardSms)?.[1];
    expect(decideCode).toMatch(/^\d{6}$/);

    await textIn(ownerPhone, `SEND 2 ${forwardCode}`); // the same code again
    expect(lastTo(ownerPhone)).toContain("didn't work");

    await textIn(financePhone, `CONFIRM ${decideCode}`);
    expect(lastTo(financePhone)).toContain('Recorded: you approved plan 2');
    expect(lastTo(ownerPhone)).toContain('approved plan 2: Evening wash and set slots');

    // The shared record and the finance assistant's memory both hold the decision.
    expect(deps.brain.record.timeline(500).length).toBeGreaterThan(10);
    const remembered = deps.brain.memory('finance').recallDecisions('evening wash and set slots');
    expect(remembered[0]?.memory.content).toContain('approved plan 2');

    // Codes are blanked in stored outbox bodies once handled; receipts exist for each step.
    const stored = await pool.query(`select body from public.outbox where body like '%SEND <1-3>%' order by created_at desc limit 1`);
    expect(stored.rows[0].body).not.toMatch(/\d{6}/);
    const steps = await pool.query(`select step, outcome from public.receipts where step in ('front-door','finance.plans','approval.forward','approval.decide') order by id desc limit 10`);
    expect(steps.rows.map((r: { step: string }) => r.step)).toEqual(expect.arrayContaining(['front-door', 'finance.plans', 'approval.forward', 'approval.decide']));
  });
});
