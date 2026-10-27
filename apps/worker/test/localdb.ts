import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Shared by the worker tests that need the real local database and the real Meterless engines.
// Both are optional: a test file that cannot get them skips itself (and says so).

export const dbUrl = process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
export const meterlessDir = path.resolve(process.env.METERLESS_DIR ?? '.local/meterless');
export const haveMeterless = fs.existsSync(path.join(meterlessDir, 'engines'));

/** The local Supabase API address and service key, from `supabase status`; null when the stack is not running. */
export function localApi(): { url: string; key: string } | null {
  try {
    const out = execSync('npx supabase status -o env', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 });
    const get = (name: string) => out.match(new RegExp(`^${name}="?([^"\\n]*)"?$`, 'm'))?.[1];
    const url = get('API_URL');
    const key = get('SERVICE_ROLE_KEY') ?? get('SECRET_KEY');
    return url && key ? { url, key } : null;
  } catch {
    return null;
  }
}
