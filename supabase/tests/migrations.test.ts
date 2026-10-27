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
      for (const table of ['tasks', 'work_reports', 'recommendations', 'division_briefs', 'assistant_profiles', 'session_reports', 'worker_reports', 'weekly_reports']) {
        await client.query('begin');
        await client.query('set local role anon');
        await expect(client.query(`select count(*) from public.${table}`), table).rejects.toThrow(/permission denied/);
        await client.query('rollback');
      }
    } finally {
      client.release();
    }
  });

  it('makes the Legal Team a real assistant with no phone number, so its door token, its profile and its reports have a row to point at', async ({ skip }) => {
    if (!name || failed) skip();
    const values = await scratch!.query(`select unnest(enum_range(null::public.assistant_id))::text as v`);
    expect(values.rows.map((r) => r.v)).toContain('legal');
    const row = await scratch!.query(`select display_name, sms_from from public.assistants where id = 'legal'`);
    expect(row.rows).toEqual([{ display_name: 'Legal Team', sms_from: null }]);
    // The new value is usable where the others are: a door token, a profile and a session report can be made for it.
    const token = await scratch!.query(`insert into public.door_tokens (assistant_id, token_hash, label) values ('legal', repeat('a', 64), 'migration test') returning id`);
    await scratch!.query(`insert into public.session_reports (token_id, assistant_id, tool, summary) values ($1, 'legal', 'claude-code', 'Read a vendor agreement.')`, [token.rows[0].id]);
    expect((await scratch!.query(`select count(*)::int as n from public.session_reports where assistant_id = 'legal'`)).rows[0].n).toBe(1);
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

  it('keys each worker report to its worker and day, and each weekly report to its division and Monday, and emails can be queued', async ({ skip }) => {
    if (!name || failed) skip();
    const client = await scratch!.connect();
    const tries: [string, string][] = [
      // [sql, expected outcome: 'ok' or an error pattern]
      [`insert into public.worker_reports (worker_id, division, report_key, report_date, period, status, written_by, report)
        values ('finance.email', 'finance', 'worker:finance.email:2026-10-27', '2026-10-27', '2026-10-mtd', 'normal', 'model', '{}')`, 'ok'],
      [`insert into public.worker_reports (worker_id, division, report_key, report_date, period, status, written_by, report)
        values ('finance.email', 'finance', 'worker:finance.email:2026-10-27:0b0e8a52-5a3c-4f43-9f7e-0c1d2e3f4a5b', '2026-10-27', '2026-10-mtd', 'normal', 'model', '{}')`, 'ok'],
      [`insert into public.worker_reports (worker_id, division, report_key, report_date, period, status, written_by, report)
        values ('finance.email', 'online', 'worker:finance.email:2026-10-28', '2026-10-28', '2026-10-mtd', 'normal', 'model', '{}')`, 'check'],
      [`insert into public.worker_reports (worker_id, division, report_key, report_date, period, status, written_by, report)
        values ('finance.email', 'finance', 'worker:financeXemail:2026-10-29', '2026-10-29', '2026-10-mtd', 'normal', 'model', '{}')`, 'check'],
      [`insert into public.weekly_reports (division, report_key, week_of, period, status, written_by, report, ceo_line)
        values ('finance', 'weekly:finance:2026-10-26', '2026-10-26', '2026-10-mtd', 'watch', 'model', '{}', 'Running normally.')`, 'ok'],
      [`insert into public.weekly_reports (division, report_key, week_of, period, status, written_by, report, ceo_line)
        values ('finance', 'weekly:finance:2026-10-27', '2026-10-27', '2026-10-mtd', 'watch', 'model', '{}', 'Not a Monday.')`, 'check'],
      [`insert into public.weekly_reports (division, report_key, week_of, period, status, written_by, report, ceo_line)
        values ('salon', 'weekly:finance:2026-10-26', '2026-10-26', '2026-10-mtd', 'watch', 'model', '{}', 'Wrong division.')`, 'check'],
      [`select 'email'::public.outbox_channel`, 'ok'],
    ];
    try {
      for (const [sql, expected] of tries) {
        await client.query('begin');
        if (expected === 'ok') await expect(client.query(sql), sql).resolves.toBeDefined();
        else await expect(client.query(sql), sql).rejects.toThrow(/check constraint/);
        await client.query('rollback');
      }
    } finally {
      client.release();
    }
  });
});
