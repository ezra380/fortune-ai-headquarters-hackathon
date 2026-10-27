import { describe, expect, it } from 'vitest';
import { DIVISIONS, LAYERS, filterViewBody } from '../src/divisions.ts';
import { SOURCES, VERSIONS, financeViewBody } from '../src/finance-sql.ts';
import { derivedViewBody, standingViewBody } from '../src/layers.ts';
import { SOURCE_ROUTES } from '../src/source-server.ts';
import { generateBusiness, generateYear } from '../src/synthetic.ts';
import { SOURCE_PORT_V2_DEFAULT, V2_DATABASES, V2_TABLES, v2CreateStatements, v2DropStatements, v2Marts } from '../src/zetaris-objects.ts';

// Version 2's Zetaris objects are built beside version 1's. These checks keep every statement away from
// version 1's tables, views and mart, so building, rebuilding or dropping version 2 cannot touch what the
// live worker reads.

const V1_TABLES = ['fortune_demo_salon.appointments', 'fortune_demo_online.orders', 'fortune_demo_marketing.ads', 'fortune_demo_marketing.email'];
const V1_PREFIXES = ['fortune_hq.', 'fortune_demo_finance_mart'];
const BASE = 'http://host.docker.internal:18121';

describe('version 2 Zetaris objects', () => {
  const create = v2CreateStatements(BASE);
  const drop = v2DropStatements();
  const marts = v2Marts().flatMap((m) => [m.create, ...m.tables.map((t) => t.sql), m.drop]);

  it('never name a version 1 object, in creation, in a mart or in a drop', () => {
    for (const sql of [...create, ...drop].map((s) => s.sql).concat(marts)) {
      // A whole name: fortune_demo_salon.appointments_v2 is version 2's own table, not version 1's.
      for (const v1 of V1_TABLES) expect(new RegExp(`${v1.replace('.', '\\.')}(?![a-z0-9_])`).test(sql), `${sql.slice(0, 60)}: ${v1}`).toBe(false);
      for (const v1 of V1_PREFIXES) expect(sql.includes(v1), `${sql.slice(0, 60)}: ${v1}`).toBe(false);
      expect(sql).not.toContain(';');
    }
    // Rebuilding drops only version 2's marts, views and REST tables; databases and the container stay.
    expect(drop.every((s) => /^DROP (DATAMART fortune_demo_v2_[a-z]+_mart$|VIEW fortune_hq_v2\.|LIGHTNING DATABASE TABLE fortune_demo_[a-z]+\.[a-z0-9_]+$)/.test(s.sql))).toBe(true);
  });

  it('use fortune_demo names, and no database shares a name with a container', () => {
    for (const t of V2_TABLES) expect(t.db.startsWith('FORTUNE_DEMO_')).toBe(true);
    const containers = ['fortune_hq', 'fortune_hq_v2', 'fortune_demo_probe'];
    for (const { db } of V2_DATABASES) expect(containers).not.toContain(db.toLowerCase());
    for (const m of v2Marts()) expect([...containers, ...V2_DATABASES.map((d) => d.db.toLowerCase())]).not.toContain(m.mart);
  });

  it('read their own port and routes, and every row view keeps exactly the columns its rows carry', () => {
    expect(SOURCE_PORT_V2_DEFAULT).not.toBe(18120);
    const served = { v1: generateBusiness(), v2: generateYear() };
    for (const t of V2_TABLES) {
      const rows: readonly object[] = SOURCE_ROUTES[t.path](served);
      expect(rows.length, t.path).toBeGreaterThan(0);
      expect(new Set(rows.flatMap((r) => Object.keys(r))), t.path).toEqual(new Set(t.cols));
      expect(create.find((s) => s.label.endsWith(`.${t.table}`))!.sql).toContain(`endpoint "${BASE}${t.path}"`);
    }
    // Every version 2 route has its table, and the support inbox is its own system: its own database.
    expect(Object.keys(SOURCE_ROUTES).filter((p) => p.startsWith('/v2/')).sort()).toEqual(V2_TABLES.map((t) => t.path).sort());
    expect(V2_TABLES.find((t) => t.view === 'support_messages')!.db).toBe('FORTUNE_DEMO_SUPPORT');
    expect(V2_DATABASES.map((d) => d.db)).toContain('FORTUNE_DEMO_SUPPORT');
  });

  it('give every version 2 source a row view, read once by the period view', () => {
    const body = financeViewBody(2);
    expect(V2_TABLES.map((t) => t.view).sort()).toEqual(VERSIONS[2].sources.map((s) => SOURCES[s].table).sort());
    for (const t of V2_TABLES) expect(body.split(`fortune_hq_v2.${t.view} `).length - 1, t.view).toBe(1);
  });

  it('create each view after the views it reads: period, then derived and standing, then the twelve division filter views', () => {
    const at = (label: string) => create.findIndex((s) => s.label === label);
    expect(create[at('fortune_hq_v2.period_metrics')]!.sql).toBe(`CREATE SCHEMASTORE VIEW period_metrics WITH CONTAINER fortune_hq_v2 AS ${financeViewBody(2)}`);
    expect(create[at('fortune_hq_v2.derived_metrics')]!.sql).toBe(`CREATE SCHEMASTORE VIEW derived_metrics WITH CONTAINER fortune_hq_v2 AS ${derivedViewBody()}`);
    expect(create[at('fortune_hq_v2.standing_metrics')]!.sql).toBe(`CREATE SCHEMASTORE VIEW standing_metrics WITH CONTAINER fortune_hq_v2 AS ${standingViewBody()}`);
    expect(at('fortune_hq_v2.derived_metrics')).toBeGreaterThan(at('fortune_hq_v2.period_metrics'));
    for (const t of V2_TABLES) expect(at('fortune_hq_v2.standing_metrics')).toBeGreaterThan(at(`fortune_hq_v2.${t.view}`));
    for (const d of DIVISIONS) {
      for (const l of LAYERS) {
        const i = at(`fortune_hq_v2.${d}_${l}_metrics`);
        expect(create[i]!.sql).toBe(`CREATE SCHEMASTORE VIEW ${d}_${l}_metrics WITH CONTAINER fortune_hq_v2 AS ${filterViewBody(d, l)}`);
        expect(i).toBeGreaterThan(at(`fortune_hq_v2.${l}_metrics`));
      }
    }
    expect(create.filter((s) => /_(period|derived|standing)_metrics$/.test(s.label))).toHaveLength(12);
  });

  it('drop the marts first and every view before the view it reads', () => {
    const at = (sql: string) => drop.findIndex((s) => s.sql === sql);
    const lastMart = Math.max(...v2Marts().map((m) => at(m.drop)));
    expect(lastMart).toBe(3);
    for (const d of DIVISIONS) for (const l of LAYERS) expect(at(`DROP VIEW fortune_hq_v2.${d}_${l}_metrics`)).toBeLessThan(at(`DROP VIEW fortune_hq_v2.${l}_metrics`));
    expect(at('DROP VIEW fortune_hq_v2.derived_metrics')).toBeLessThan(at('DROP VIEW fortune_hq_v2.period_metrics'));
  });
});
