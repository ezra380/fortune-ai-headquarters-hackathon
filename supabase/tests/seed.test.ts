import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DIVISION_ASSISTANT, MANAGERS, ManagedDivision } from '@fahq/contracts';

// The synthetic seed (supabase/seed.sql), read as text: no database. Each division's assistant carries its manager's
// name (George, Georgette, Cindy) and each head is a stand-in for the person the manager reports to (Alan, Emma, Esther),
// with a fictional 555 number and no email address.

const seed = fs.readFileSync(path.join(import.meta.dirname, '..', 'seed.sql'), 'utf8');
/** The quoted values of each row of an insert, by its first value (the id). */
function rowsOf(table: string): Map<string, string[]> {
  const block = new RegExp(`insert into public\\.${table} \\([^)]*\\) values\\n([\\s\\S]*?);`).exec(seed)?.[1] ?? '';
  return new Map(block.split('\n').filter((l) => l.trim().startsWith('(')).map((l) => {
    const values = [...l.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!.replaceAll("''", "'"));
    return [values[0]!, values];
  }));
}
const HEAD_ID: Record<ManagedDivision, string> = { finance: 'demo-p-finance-owner', online: 'demo-p-online-staff', salon: 'demo-p-head-stylist' };

describe('the synthetic seed', () => {
  it.each(ManagedDivision.options)("names the %s assistant after its manager, and its head after the manager's head, as a demo stand-in", (division) => {
    const { manager, head } = MANAGERS[division];
    const assistant = rowsOf('assistants').get(DIVISION_ASSISTANT[division])!;
    expect(assistant[1]).toBe(`${manager} (${division})`);
    const person = rowsOf('people').get(HEAD_ID[division])!;
    expect(person[1]).toBe(`Demo ${head}`);
    expect(person[4]).toBe(DIVISION_ASSISTANT[division]);
  });

  it('holds only fictional 555 numbers and no email address', () => {
    for (const table of ['assistants', 'people']) {
      for (const values of rowsOf(table).values()) {
        for (const v of values.filter((x) => x.startsWith('+'))) expect(v, table).toMatch(/^\+1555\d{7}$/);
      }
    }
    expect(seed).not.toMatch(/@/);
  });
});
