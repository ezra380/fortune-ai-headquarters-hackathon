// Makes a door token for one assistant: the secret an outside AI tool presents to read that assistant's profile and
// file its end-of-work report. Only the token's SHA-256 goes into the database. The token itself is written to
// .local/door-tokens/<assistant>.token (readable by you only) and the script prints that path and nothing else.
//   npx tsx scripts/issue-door-token.ts <owner|finance|salon|online|manager> [label] [--replace] [--db <url>]
//   --replace   overwrite an existing token file (the old token stays valid until its row is revoked:
//               update public.door_tokens set revoked_at = now() where id = '<id>')
//   --db <url>  the Postgres to write to. Default: SUPABASE_DB_URL, else the local stack (127.0.0.1:54322).
//   --dir <dir> where the token file goes. Default: .local/door-tokens
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { AssistantId } from '@fahq/contracts';
import { issueDoorToken, writeTokenFile } from '@fahq/profiles';

const root = path.resolve(import.meta.dirname, '..');
const { values, positionals } = parseArgs({ allowPositionals: true, options: { replace: { type: 'boolean' }, db: { type: 'string' }, dir: { type: 'string' } } });
const assistant = AssistantId.safeParse(positionals[0]);
if (!assistant.success) {
  console.error(`issue-door-token: the first argument must be one of ${AssistantId.options.join(', ')}`);
  process.exit(2);
}
const label = (positionals[1] ?? `${assistant.data} door`).slice(0, 60);
const replace = values.replace === true;
const dbUrl = values.db ?? process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const dir = path.resolve(values.dir ?? path.join(root, '.local', 'door-tokens'));

if (fs.existsSync(path.join(dir, `${assistant.data}.token`)) && !replace) {
  console.error(`issue-door-token: ${path.join(dir, `${assistant.data}.token`)} already exists. Remove it, or pass --replace.`);
  process.exit(2);
}

const target = new URL(dbUrl);
console.error(`issue-door-token: ${assistant.data} (${label}) on ${target.hostname}:${target.port || '5432'}${target.pathname}`);

const client = new pg.Client({ connectionString: dbUrl });
await client.connect();
try {
  // The row and the file go together: if the file cannot be written, the row is rolled back.
  await client.query('begin');
  const issued = await issueDoorToken(client, assistant.data, label);
  const file = writeTokenFile(dir, assistant.data, issued.token, { replace });
  await client.query('commit');
  console.log(file);
} catch (error) {
  await client.query('rollback').catch(() => undefined);
  console.error(`issue-door-token: failed (${error instanceof Error ? error.message : 'unknown error'}). No token was issued.`);
  process.exitCode = 1;
} finally {
  await client.end();
}
