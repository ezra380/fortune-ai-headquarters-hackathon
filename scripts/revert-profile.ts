// Puts an earlier version of an assistant's profile back, as a new version (the history keeps every version, so this
// can be undone too). Use it to undo what the HQ Manager applied by itself, or anything the owner approved.
//   npx tsx scripts/revert-profile.ts <assistant> <version>     e.g. finance 3
//   npx tsx scripts/revert-profile.ts <assistant> --list        shows the versions: who made each, when, and why
//   --db <url>   the Postgres to write to. Default: SUPABASE_DB_URL, else the local stack (127.0.0.1:54322).
// The database is never taken from .env.local, so a cloud address in there cannot be written to by accident.
import { parseArgs } from 'node:util';
import pg from 'pg';
import { AssistantId } from '@fahq/contracts';
import { restoreProfileVersion } from '@fahq/profiles';

const { values, positionals } = parseArgs({ options: { db: { type: 'string' }, list: { type: 'boolean' } }, allowPositionals: true });
const assistant = AssistantId.safeParse(positionals[0]);
const version = Number(positionals[1]);
const listing = values.list === true;
if (!assistant.success || (!listing && !Number.isInteger(version))) {
  console.error('usage: npx tsx scripts/revert-profile.ts <owner|finance|salon|online|manager|legal> <version>   (or <assistant> --list)');
  process.exit(2);
}
const dbUrl = values.db ?? process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const target = new URL(dbUrl);
console.error(`revert-profile: ${target.hostname}:${target.port || '5432'}${target.pathname}`);

const client = new pg.Client({ connectionString: dbUrl });
await client.connect();
try {
  if (listing) {
    const { rows } = await client.query(
      'select version, made_by, reason, created_at, jsonb_array_length(snapshot->\'lessons\') as lessons from public.assistant_profile_versions where assistant_id = $1 order by version',
      [assistant.data],
    );
    for (const r of rows) console.log(`${String(r.version).padStart(3)}  ${String(r.made_by).padEnd(8)} ${new Date(r.created_at).toISOString()}  ${r.reason}`);
  } else {
    await client.query('begin');
    const done = await restoreProfileVersion(client, assistant.data, version);
    await client.query('commit');
    console.log(`${done.assistant} version ${done.restored} is back as version ${done.version} (it replaced version ${done.replaced})`);
  }
} catch (error) {
  await client.query('rollback').catch(() => undefined);
  console.error(`revert-profile: ${error instanceof Error ? error.message : 'failed'}. Nothing was written.`);
  process.exitCode = 1;
} finally {
  await client.end();
}
