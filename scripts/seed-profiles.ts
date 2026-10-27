// Puts the assistant profiles (skills/<id>/SKILL.md, the read tools, the models for each job) into
// public.assistant_profiles, one version row made by "seed" for each profile it writes. Run it as often as you like.
//   npx tsx scripts/seed-profiles.ts             stores the profiles that have no row yet; every other row is left as it is
//   npx tsx scripts/seed-profiles.ts --force     replaces title, skill, reads and models with the files' as a new version
//                                                (lessons a person adopted, the manager's notes, and the read tools and
//                                                models the owner approved with his code are kept; it says which)
//   --db <url>   the Postgres to write to. Default: SUPABASE_DB_URL, else the local stack (127.0.0.1:54322).
// The database is never taken from .env.local, so a cloud address in there cannot be written to by accident.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { seedProfiles } from '@fahq/profiles';

const { values } = parseArgs({ options: { force: { type: 'boolean' }, db: { type: 'string' } } });
const dbUrl = values.db ?? process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const force = values.force === true;

// Model names (NEMOTRON_PLAN_MODEL, CODE_MODEL and the like) come from .env.local when it exists.
const envFile = path.resolve(import.meta.dirname, '..', '.env.local');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const target = new URL(dbUrl);
console.error(`seed-profiles: ${force ? 'reseeding' : 'seeding'} ${target.hostname}:${target.port || '5432'}${target.pathname}`);

const client = new pg.Client({ connectionString: dbUrl });
await client.connect();
try {
  await client.query('begin');
  const results = await seedProfiles(client, process.env, { force });
  await client.query('commit');
  for (const r of results) {
    const note = r.action === 'kept' && r.differsFromFiles
      ? '; differs from the files (--force puts the files back)'
      : r.keptFromOwner ? `; kept what the owner approved: ${r.keptFromOwner.join(', ')}` : '';
    console.log(`${r.assistant.padEnd(8)} ${r.action} (version ${r.version})${note}`);
  }
} catch (error) {
  await client.query('rollback').catch(() => undefined);
  console.error(`seed-profiles: failed (${error instanceof Error ? error.message : 'unknown error'}). Nothing was written.`);
  process.exitCode = 1;
} finally {
  await client.end();
}
