import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The migration files as one set (merge wave 1): every file has its own timestamp, and the whole set, applied in order
// to an empty database, builds what the other database tests expect of the shared stack. The scratch database starts
// with Supabase's default grants to the Data API roles (as profiles.test.ts builds its own), so a migration that
// forgets to take them back is caught here. Made here, never named from input, and dropped afterwards.

const DIR = path.resolve(import.meta.dirname, '../migrations');
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const url = process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const isLocal = /@(127\.0\.0\.1|localhost|\[::1\]):/.test(url);

describe('the migration files', () => {
  it('give every migration its own timestamp, so the order they run in is never a tie', () => {
    const versions = FILES.map((f) => f.split('_')[0]!);
    expect(versions.every((v) => /^\d{14}$/.test(v)), versions.join(' ')).toBe(true);
    expect(versions.filter((v, i) => versions.indexOf(v) !== i)).toEqual([]);
  });
});

describe('every migration, in order, on an empty database', () => {
  let admin: pg.Pool | undefined;
  let scratch: pg.Pool | undefined;
  let name = '';
  let failed: string | null = null;

  beforeAll(async () => {
    if (!isLocal) return;
    try {
      admin = new pg.Pool({ connectionString: url, max: 1 });
      name = `migrations_scratch_${randomBytes(4).toString('hex')}`;
      await admin.query(`create database ${name}`);
      const target = new URL(url);
      target.pathname = `/${name}`;
      scratch = new pg.Pool({ connectionString: target.toString(), max: 2 });
      await scratch.query(`
        create schema extensions;
        create extension pgcrypto with schema extensions;
        alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
        alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
        alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
        grant usage on schema public to anon, authenticated, service_role;`);
    } catch (error) {
      console.warn(`SKIPPED the migration set: could not build a scratch database (${error instanceof Error ? error.message : 'unknown'})`);
      name = '';
      return;
    }
    for (const file of FILES) {
      try {
        await scratch.query(fs.readFileSync(path.join(DIR, file), 'utf8'));
      } catch (error) {
        failed = `${file}: ${error instanceof Error ? error.message : 'unknown'}`;
        return;
      }
    }
  }, 60_000);

  afterAll(async () => {
    await scratch?.end().catch(() => undefined);
    if (name) await admin?.query(`drop database ${name} with (force)`).catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  it('applies every file without an error', ({ skip }) => {
    if (!name) skip();
    expect(failed).toBeNull();
  });

  it('leaves the public roles no table privilege: anon is refused, never shown zero rows', async ({ skip }) => {
    if (!name || failed) skip();
    const grants = await scratch!.query(`select count(*)::int as n from information_schema.role_table_grants where grantee in ('anon', 'authenticated') and table_schema = 'public'`);
    expect(grants.rows[0].n).toBe(0);
    const client = await scratch!.connect();
    try {
      for (const table of ['tasks', 'work_reports', 'recommendations', 'division_briefs', 'assistant_profiles', 'session_reports']) {
        await client.query('begin');
        await client.query('set local role anon');
        await expect(client.query(`select count(*) from public.${table}`), table).rejects.toThrow(/permission denied/);
        await client.query('rollback');
      }
    } finally {
      client.release();
    }
  });

  it('lets anon run exactly the two doors, and takes every approval action any lane added', async ({ skip }) => {
    if (!name || failed) skip();
    const callable = await scratch!.query(`select proname from pg_proc where pronamespace = 'public'::regnamespace and has_function_privilege('anon', oid, 'execute') order by proname`);
    expect(callable.rows.map((r) => r.proname)).toEqual(['door_file_report', 'door_profile']);
    const check = await scratch!.query(`select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'approvals_action_check'`);
    const bodies = await scratch!.query(`select proname, prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname in ('issue_approval', 'use_approval_code')`);
    for (const action of ['forward_plan', 'decide_plan', 'adopt_change', 'approve_action']) {
      expect(check.rows[0].d, action).toContain(`'${action}'`);
      for (const fn of bodies.rows) expect(fn.prosrc, `${fn.proname} ${action}`).toContain(`'${action}'`);
    }
    expect(bodies.rows).toHaveLength(2);
  });
});
