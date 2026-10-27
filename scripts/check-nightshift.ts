// Is Nightshift's Meterless Runtime reachable, and which model ids does it offer? Prints the status and
// the ids only (never the token). Usage: npx tsx scripts/check-nightshift.ts
// Reads METERLESS_BASE_URL (default 127.0.0.1:8088) and METERLESS_TOKEN or METERLESS_TOKEN_FILE from .env.local.
import fs from 'node:fs';
import { checkMeterless, meterlessToken, normalizeMeterlessUrl } from '@fahq/models';

if (fs.existsSync('.env.local')) process.loadEnvFile('.env.local');
const base = process.env.METERLESS_BASE_URL ?? '127.0.0.1:8088';
const result = await checkMeterless(base, meterlessToken(process.env));
console.log(`Meterless Runtime at ${normalizeMeterlessUrl(base)}: ${result.status}`);
for (const id of result.models) console.log(`  ${id}`);
if (result.status !== 'online') process.exitCode = 1;
