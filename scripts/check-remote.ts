// Read-only health check of the Supabase project in .env.local. Prints counts and outcomes only,
// never keys or row contents. Usage: npx tsx scripts/check-remote.ts
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const envFile = path.resolve(import.meta.dirname, '../.env.local');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const url = process.env.SUPABASE_URL ?? '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local');
console.log('project host:', new URL(url).host);

const db = createClient(url, key, { auth: { persistSession: false } });
for (const table of ['assistants', 'people', 'tasks', 'assistant_messages', 'approvals', 'outbox', 'receipts']) {
  const r = await db.from(table).select('*', { count: 'exact', head: true });
  console.log(`${table}: ${r.error ? `ERROR ${r.error.code ?? ''}` : r.count}`);
}
const numbers = await db.from('assistants').select('id, sms_from');
for (const a of (numbers.data ?? []) as { id: string; sms_from: string | null }[]) {
  console.log(`assistant ${a.id} texts from …${(a.sms_from ?? '').slice(-4) || 'none'}`);
}

const outsider = createClient(url, 'not-a-real-key', { auth: { persistSession: false } });
const leak = await outsider.from('people').select('id');
console.log(`request without a valid key: ${leak.error ? 'refused' : `RETURNED ${leak.data?.length ?? 0} ROWS`}`);
