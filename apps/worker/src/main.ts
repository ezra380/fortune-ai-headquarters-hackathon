// The assistant worker. Usage: npm run worker            (runs until stopped)
//                              npm run worker -- --once  (drains the queue, then exits)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PERIODS, type DataPort, type DeliveryPort } from '@fahq/contracts';
import { openBrain } from '@fahq/brain';
import { createCodeModeRunner } from '@fahq/codemode';
import { modelsFromEnv, positiveInt } from '@fahq/models';
import { financePeriod } from './finance.ts';
import type { WorkerDeps } from './flows.ts';
import { workerProfiles } from './profiles.ts';
import { runConcurrently } from './runner.ts';
import { scheduleEnabled, startScheduler } from './scheduler.ts';
import { createStore } from './store.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const envFile = path.join(root, '.env.local');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const env = process.env;

async function optional<T>(pkg: string, factory: string, label: string): Promise<T | null> {
  try {
    const mod = (await import(pkg)) as Record<string, unknown>;
    const make = mod[factory];
    if (typeof make !== 'function') throw new Error(`${factory} is not exported yet`);
    return (make as (e: NodeJS.ProcessEnv, d?: unknown) => T)(env, { fetch, now: () => new Date(), sentLedger: new Set<string>() });
  } catch (error) {
    console.error(`worker: ${label} not connected (${error instanceof Error ? error.message : 'unknown'})`);
    return null;
  }
}

if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('worker: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local (npm run db:status shows the local values).');
  process.exit(1);
}

const models = modelsFromEnv(env);
const store = createStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const data = await optional<DataPort>('@fahq/data', 'createZetarisDataPort', 'business data (packages/data)');
// A period the data does not serve would pass startup and fail every finance read, so it falls back, said plainly.
const planning = financePeriod(env.FINANCE_PERIOD, data?.periods ?? DEFAULT_PERIODS);
if (planning.note) console.error(`worker: ${planning.note}`);
// How many claim loops run in this one process. claim_task skips rows another loop holds, outbox claims are
// atomic, the World Model queues its writes and H-MEM writes are synchronous, so loops never share a task.
const concurrency = positiveInt(env, 'WORKER_CONCURRENCY', 2);
const brain = await openBrain({
  meterlessDir: path.resolve(root, env.METERLESS_DIR ?? '.local/meterless'),
  dataDir: path.join(root, '.local/brain'),
  actor: `worker@${os.hostname()}`,
});
const deps: WorkerDeps = {
  store,
  brain,
  models: { nvidia: models.nvidia, planModel: models.planModel, routerModel: models.routerModel },
  // The safety screen in front of every free text; GUARD=off turns it off.
  guard: models.guard ? { model: models.guardModel } : null,
  data,
  delivery: await optional<DeliveryPort>('@fahq/delivery', 'createDeliveryPort', 'delivery (packages/delivery)'),
  // Each assistant's read-only profile (its row in the database, else its file): skill text, model for each job, read tools.
  // Reasoning on before each script: in live runs it read the right metrics more often, at about 35 s a
  // question instead of 10 (docs/research/codemode-savings-summary-2026-10-27.md). CODE_THINKING=off turns it off.
  codeMode: createCodeModeRunner({ model: models.nvidia, thinking: env.CODE_THINKING !== 'off' }),
  // The lessons in these profiles are copied into this machine's H-MEM, which the plan writers read.
  profiles: await workerProfiles(env, store, () => new Date(), console.error, brain),
  now: () => new Date(),
  worker: `worker@${os.hostname()}:${process.pid}`,
  live: true,
  period: planning.period,
  smsLive: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET),
  printers: { owner: env.PRINTNODE_PRINTER_OWNER || undefined, finance: env.PRINTNODE_PRINTER_FINANCE || undefined },
  printDir: path.join(root, '.local/print'),
};

let stopping = false;
if (process.argv.includes('--once')) {
  const cycles = await runConcurrently(deps, concurrency, () => stopping, { untilIdle: true, maxCycles: 500 });
  console.error(`worker: drained the queue in ${cycles} cycles`);
} else {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { stopping = true; });
  console.error(`worker: running as ${deps.worker} with ${concurrency} claim loops`);
  // The daily clock (the division workers at 07:00 ET, briefs at 08:00, the CEO digest at 08:30, the HQ Manager's review at 09:00);
  // FAHQ_SCHEDULE=off turns it off.
  const clock = scheduleEnabled(env) ? startScheduler(deps) : null;
  console.error(`worker: daily schedule ${clock ? 'on' : 'off'}`);
  await runConcurrently(deps, concurrency, () => stopping, { untilIdle: false });
  clock?.stop();
  console.error('worker: stopped');
}
