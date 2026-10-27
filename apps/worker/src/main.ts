// The assistant worker. Usage: npm run worker            (runs until stopped)
//                              npm run worker -- --once  (drains the queue, then exits)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DataPort, DeliveryPort } from '@fahq/contracts';
import { openBrain } from '@fahq/brain';
import { modelsFromEnv } from '@fahq/models';
import type { WorkerDeps } from './flows.ts';
import { runOnce, runUntilIdle } from './runner.ts';
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
const deps: WorkerDeps = {
  store: createStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY),
  brain: await openBrain({
    meterlessDir: path.resolve(root, env.METERLESS_DIR ?? '.local/meterless'),
    dataDir: path.join(root, '.local/brain'),
    actor: `worker@${os.hostname()}`,
  }),
  models: { nvidia: models.nvidia, planModel: models.planModel, routerModel: models.routerModel },
  data: await optional<DataPort>('@fahq/data', 'createZetarisDataPort', 'business data (packages/data)'),
  delivery: await optional<DeliveryPort>('@fahq/delivery', 'createDeliveryPort', 'delivery (packages/delivery)'),
  // TEMP: Code Mode and the assistants' profiles are wired here after the profiles lane merges
  // (packages/profiles). Until then the steps that need Code Mode (questions, the manager's review)
  // fail with a plain sentence, and no assistant has a read tool.
  codeMode: null,
  profiles: {
    skill: () => '',
    model: () => models.planModel,
    reads: () => [],
  },
  now: () => new Date(),
  worker: `worker@${os.hostname()}:${process.pid}`,
  live: true,
  period: env.FINANCE_PERIOD === '2026-10-mtd' ? '2026-10-mtd' : '2026-09',
  smsLive: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET),
  printers: { owner: env.PRINTNODE_PRINTER_OWNER || undefined, finance: env.PRINTNODE_PRINTER_FINANCE || undefined },
  printDir: path.join(root, '.local/print'),
};

if (process.argv.includes('--once')) {
  const cycles = await runUntilIdle(deps);
  console.error(`worker: drained the queue in ${cycles} cycles`);
} else {
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { stopping = true; });
  console.error(`worker: running as ${deps.worker}`);
  while (!stopping) {
    const busy = await runOnce(deps).catch((error: unknown) => {
      console.error(`worker.loop_error: ${error instanceof Error ? error.message : 'unknown'}`);
      return false;
    });
    if (!busy) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  console.error('worker: stopped');
}
