import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { issueDoorToken, newDoorToken, tokenHash, writeTokenFile, type Queryable } from '../src/index.ts';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fahq-tokens-'));
  made.push(dir);
  return dir;
};

describe('door tokens', () => {
  it('makes 256 random bits in the form the database accepts', () => {
    const a = newDoorToken();
    const b = newDoorToken();
    expect(a).toMatch(/^fahq_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{32,128}$/); // the pattern door_token() checks before it looks anything up
  });

  it('hashes with SHA-256 over the UTF-8 text, as lowercase hex', () => {
    expect(tokenHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(tokenHash(newDoorToken())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores only the hash of the token it issues', async () => {
    const calls: { text: string; params: unknown[] }[] = [];
    const db: Queryable = { query: async (text, params = []) => { calls.push({ text, params }); return { rows: [{ id: 'row-1' }] }; } };
    const issued = await issueDoorToken(db, 'finance', 'Claude Code on the office laptop', 'fahq_' + 'x'.repeat(43));
    expect(issued).toEqual({ id: 'row-1', token: 'fahq_' + 'x'.repeat(43) });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params).toEqual(['finance', tokenHash('fahq_' + 'x'.repeat(43)), 'Claude Code on the office laptop']);
    expect(JSON.stringify(calls)).not.toContain('x'.repeat(43));
  });

  it('writes the token to <assistant>.token readable by its owner only', () => {
    const dir = path.join(tmp(), 'nested', 'door-tokens');
    const file = writeTokenFile(dir, 'owner', 'fahq_secret');
    expect(file).toBe(path.join(dir, 'owner.token'));
    expect(fs.readFileSync(file, 'utf8')).toBe('fahq_secret\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('never overwrites a token file unless asked, and keeps the mode when it does', () => {
    const dir = tmp();
    const file = writeTokenFile(dir, 'salon', 'fahq_one');
    expect(() => writeTokenFile(dir, 'salon', 'fahq_two')).toThrow(/already exists.*--replace/);
    expect(fs.readFileSync(file, 'utf8')).toBe('fahq_one\n');
    fs.chmodSync(file, 0o644);
    writeTokenFile(dir, 'salon', 'fahq_two', { replace: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('fahq_two\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
