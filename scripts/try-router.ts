// LIVE model, no writes: shows what the front door decides for a handful of owner texts, so a person can
// check the router prompt before the worker uses it. Reads NEMOTRON_API_KEY from .env.local (never printed).
// Usage:  npx tsx scripts/try-router.ts            (the eight phrases below)
//         npx tsx scripts/try-router.ts "any text"  (your own phrase instead)
import fs from 'node:fs';
import path from 'node:path';
import { modelsFromEnv } from '@fahq/models';
import { routeText } from '../apps/worker/src/router.ts';

const envFile = path.resolve(import.meta.dirname, '../.env.local');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const models = modelsFromEnv(process.env);

const PHRASES = [
  'Give me three plans to grow profit this month.',
  'Ask online for ideas to bring back customers who stopped ordering.',
  'What did the salon take in last week?',
  'Why did you propose plan 2?',
  'How are my assistants doing lately?',
  'What does Cindy have on tomorrow?',
  'Any ideas for the slow weekday appointments at the salon?',
  'Is anything waiting on me?',
];

const phrases = process.argv.slice(2).length > 0 ? [process.argv.slice(2).join(' ')] : PHRASES;
console.log(`front door model: ${models.routerModel} (LIVE; nothing is written anywhere)\n`);
for (const phrase of phrases) {
  const started = Date.now();
  try {
    const { decision, valid, inputTokens, outputTokens } = await routeText(models.nvidia, models.routerModel, phrase, 'owner');
    const risks = decision.risks.join(',') || 'none';
    console.log(`"${phrase}"\n  → intent ${decision.intent}, target ${decision.targetAssistant}, risks ${risks}, confidence ${decision.confidence}${valid ? '' : ' (did NOT validate)'}`);
    console.log(`  ${decision.reason}  [${Date.now() - started} ms, ${inputTokens} in / ${outputTokens} out]\n`);
  } catch (error) {
    console.log(`"${phrase}"\n  → FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
