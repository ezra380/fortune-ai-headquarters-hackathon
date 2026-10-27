import { describe, expect, it } from 'vitest';
import { CATALOG_V2, DIVISIONS, LAYERS, filterViewBody } from '../src/divisions.ts';
import { financeViewBody } from '../src/finance-sql.ts';
import { derivedViewBody, standingViewBody } from '../src/layers.ts';
import { SOURCE_ROUTES } from '../src/source-server.ts';
import { SOURCE_ENUMS, generateBusiness, generateYear } from '../src/synthetic.ts';
import { V2_TABLES } from '../src/zetaris-objects.ts';

// Fortune rule 6: hair-loss data (and anything medical) is never written, read or targeted. No source may
// carry such a column or value, no allowed value of any enumerated column may name one, and no metric or
// view may ask for one. The support inbox keeps when and what about, never what was said.

const BANNED = /medical|hair.?loss|alopecia|chemo|diagnos|fj_interest|topper_interest/i;
const served = { v1: generateBusiness(), v2: generateYear() };
const routes = Object.entries(SOURCE_ROUTES).map(([path, rows]) => [path, rows(served) as readonly Record<string, unknown>[]] as const);

describe('no medical or hair-loss data anywhere', () => {
  it('in any column or string value of any source, version 1 and version 2, planted bad rows included', () => {
    expect(routes.length).toBe(21);
    for (const [path, rows] of routes) {
      expect(rows.length, path).toBeGreaterThan(0);
      for (const row of rows) {
        for (const [key, value] of Object.entries(row)) {
          expect(key, path).not.toMatch(BANNED);
          if (typeof value === 'string') expect(value, `${path} ${key}`).not.toMatch(BANNED);
        }
      }
    }
    for (const t of V2_TABLES) for (const c of t.cols) expect(c, t.table).not.toMatch(BANNED);
  });

  it('in any allowed value of any enumerated column, and every good row keeps to those values', () => {
    for (const [column, values] of Object.entries(SOURCE_ENUMS)) for (const v of values) expect(v, column).not.toMatch(BANNED);
    // The lists are complete: a good row's value in an enumerated column is always one of them.
    for (const [path, rows] of routes) {
      for (const row of rows.filter((r) => !String(Object.values(r)[0]).includes('-bad-'))) {
        for (const [column, values] of Object.entries(SOURCE_ENUMS)) {
          if (column in row) expect(values as readonly unknown[], `${path} ${column}`).toContain(row[column]);
        }
      }
    }
  });

  it('in the support inbox: no body, subject or text column, and no intent that names a health matter', () => {
    const inbox = V2_TABLES.find((t) => t.view === 'support_messages')!;
    expect(inbox.cols.filter((c) => /body|text|subject|content|message$|note|transcript/i.test(c))).toEqual([]);
    expect(Object.keys(served.v2.support.messages[0]!).sort()).toEqual([...inbox.cols].sort());
    expect(SOURCE_ENUMS.intent).not.toContain('health');
  });

  it('in any metric (id, label, about) or any view a division reads', () => {
    for (const m of CATALOG_V2) for (const text of [m.id, m.label, m.about ?? '']) expect(text, m.id).not.toMatch(BANNED);
    const bodies = [financeViewBody(1), financeViewBody(2), derivedViewBody(), standingViewBody(), ...DIVISIONS.flatMap((d) => LAYERS.map((l) => filterViewBody(d, l)))];
    for (const body of bodies) expect(body).not.toMatch(BANNED);
  });
});
