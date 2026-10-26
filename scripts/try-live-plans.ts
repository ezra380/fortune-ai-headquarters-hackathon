// LIVE models and LIVE Zetaris data: checks that NVIDIA Nemotron can route a text and write plans
// from the governed finance view that pass the number validator. Usage:
//   npx tsx scripts/try-live-plans.ts               (Zetaris: run npm run zetaris:setup once first)
//   npx tsx scripts/try-live-plans.ts --mock-data   (the worker tests' fixed metrics instead)
import fs from 'node:fs';
import path from 'node:path';
import type { AssistantMemory } from '@fahq/brain';
import { modelsFromEnv } from '@fahq/models';
import { createZetarisDataPort } from '../packages/data/src/index.ts';
import { PlanError, planDigest, writePlans } from '../apps/worker/src/finance.ts';
import { routeText } from '../apps/worker/src/router.ts';
import { dataMock } from '../apps/worker/test/fixtures.ts';

const envFile = path.resolve(import.meta.dirname, '../.env.local');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const models = modelsFromEnv(process.env);
const request = 'Ask the finance assistant for three aggressive plans to double profit this month.';
const mockData = process.argv.includes('--mock-data');
const data = mockData ? dataMock : createZetarisDataPort(process.env);
const dataLabel = mockData ? 'MOCK metrics' : 'LIVE Zetaris metrics';

const t0 = Date.now();
const routed = await routeText(models.nvidia, models.routerModel, request, 'owner');
console.log(`ROUTER (LIVE ${routed.model}, ${Date.now() - t0} ms, valid=${routed.valid}):`, JSON.stringify(routed.decision));

const memory = { recallDecisions: () => [], declinedSimilarTo: () => [] } as unknown as AssistantMemory; // MOCK: empty memory
const t1 = Date.now();
try {
  const result = await writePlans({ model: models.nvidia, planModel: models.planModel, data, memory, now: new Date(), request, period: '2026-09' });
  console.log(`PLANS (LIVE ${result.model}, ${dataLabel} from ${result.view}, ${result.metrics.length} metrics, query ${result.queryHash.slice(0, 12)}): passed validation on attempt ${result.attempts} in ${Date.now() - t1} ms, ${result.tokens} tokens`);
  console.log(planDigest(result.plans, result.metrics));
  for (const p of result.plans.plans) console.log(`- ${p.rank} [${p.businesses.join('+')}] ${p.summary}\n  test: ${p.test}\n  stop-loss: ${p.stopLoss}`);
} catch (error) {
  if (error instanceof PlanError) console.log(`PLANS REJECTED after 2 attempts:\n  ${error.objections.join('\n  ')}`);
  else console.log(`PLANS FAILED: ${error instanceof Error ? error.message : String(error)}`);
}
