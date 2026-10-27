// The assistant worker. Usage: npm run worker            (runs until stopped)
//                              npm run worker -- --once  (drains the queue, then exits)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DataPort, DeliveryPort } from '@fahq/contracts';
import { openBrain } from '@fahq/brain';
import { createCodeModeRunner } from '@fahq/codemode';
import { modelsFromEnv, positiveInt } from '@fahq/models';
import { loadProfiles } from '@fahq/profiles';
import type { WorkerDeps } from './flows.ts';
import { runConcurrently } from './runner.ts';
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
const profiles = loadProfiles(env);
// How many claim loops run in this one process. claim_task skips rows another loop holds, outbox claims are
// atomic, the World Model queues its writes and H-MEM writes are synchronous, so loops never share a task.
const concurrency = positiveInt(env, 'WORKER_CONCURRENCY', 2);
const deps: WorkerDeps = {
  store: createStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY),
  brain: await openBrain({
    meterlessDir: path.resolve(root, env.METERLESS_DIR ?? '.local/meterless'),
    dataDir: path.join(root, '.local/brain'),
    actor: `worker@${os.hostname()}`,
  }),
  models: { nvidia: models.nvidia, planModel: models.planModel, routerModel: models.routerModel },
  // The safety screen in front of every free text; GUARD=off turns it off.
  guard: models.guard ? { model: models.guardModel } : null,
  data: await optional<DataPort>('@fahq/data', 'createZetarisDataPort', 'business data (packages/data)'),
  delivery: await optional<DeliveryPort>('@fahq/delivery', 'createDeliveryPort', 'delivery (packages/delivery)'),
  // Each assistant's read-only profile: its skill text, the model for each job, its read tools.
  codeMode: createCodeModeRunner({ model: models.nvidia }),
  profiles: {
    skill: (id) => profiles[id].skill,
    model: (id, job) => {
      const setting = profiles[id].models[job];
      if (!setting) throw new Error(`The ${profiles[id].title} assistant has no model for "${job}".`);
      return setting.model;
    },
    reads: (id) => profiles[id].reads,
  },
  now: () => new Date(),
  worker: `worker@${os.hostname()}:${process.pid}`,
  live: true,
  period: env.FINANCE_PERIOD === '2026-10-mtd' ? '2026-10-mtd' : '2026-09',
  smsLive: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET),
  printers: { owner: env.PRINTNODE_PRINTER_OWNER || undefined, finance: env.PRINTNODE_PRINTER_FINANCE || undefined },
  printDir: path.join(root, '.local/print'),
};

let stopping = false;
if (process.argv.includes('--once')) {
  const cycles = await runConcurrently(deps, concurrency, () => stopping, { untilIdle: true });
  console.error(`worker: drained the queue in ${cycles} cycles`);
} else {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { stopping = true; });
  console.error(`worker: running as ${deps.worker} with ${concurrency} claim loops`);
  await runConcurrently(deps, concurrency, () => stopping, { untilIdle: false });
  console.error('worker: stopped');
}
