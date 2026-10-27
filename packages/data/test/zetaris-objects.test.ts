import { describe, expect, it } from 'vitest';
import { financeViewBody } from '../src/finance-sql.ts';
import { SOURCE_ROUTES } from '../src/source-server.ts';
import { generateYear } from '../src/synthetic.ts';
import { SOURCE_PORT_V2_DEFAULT, V2_DATABASES, V2_TABLES, v2CreateStatements, v2DropStatements } from '../src/zetaris-objects.ts';

// Version 2's Zetaris objects are built beside version 1's. These checks keep every statement away from
// version 1's tables, views and mart, so building, rebuilding or dropping version 2 cannot touch what the
// live worker reads.

const V1_TABLES = ['fortune_demo_salon.appointments', 'fortune_demo_online.orders', 'fortune_demo_marketing.ads', 'fortune_demo_marketing.email'];
const V1_PREFIXES = ['fortune_hq.', 'fortune_demo_finance_mart'];
const BASE = 'http://host.docker.internal:18121';

describe('version 2 Zetaris objects', () => {
  const create = v2CreateStatements(BASE);
  const drop = v2DropStatements();

  it('never name a version 1 object, in creation or in a drop', () => {
    for (const s of [...create, ...drop]) {
      // A whole name: fortune_demo_salon.appointments_v2 is version 2's own table, not version 1's.
      for (const v1 of V1_TABLES) expect(new RegExp(`${v1.replace('.', '\\.')}(?![a-z0-9_])`).test(s.sql), `${s.label}: ${v1}`).toBe(false);
      for (const v1 of V1_PREFIXES) expect(s.sql.includes(v1), `${s.label}: ${v1}`).toBe(false);
      expect(s.sql).not.toContain(';');
    }
    // Rebuilding drops only views and REST tables; databases and the container stay.
    expect(drop.every((s) => /^DROP (VIEW fortune_hq_v2\.|LIGHTNING DATABASE TABLE fortune_demo_[a-z]+\.[a-z0-9_]+$)/.test(s.sql))).toBe(true);
  });

  it('use fortune_demo names, and no database shares a name with a container', () => {
    for (const t of V2_TABLES) expect(t.db.startsWith('FORTUNE_DEMO_')).toBe(true);
    const containers = ['fortune_hq', 'fortune_hq_v2', 'fortune_demo_probe'];
    for (const { db } of V2_DATABASES) expect(containers).not.toContain(db.toLowerCase());
  });

  it('read their own port and routes, and every row view keeps exactly the columns its rows carry', () => {
    expect(SOURCE_PORT_V2_DEFAULT).not.toBe(18120);
    const year = generateYear();
    const served: Record<string, readonly object[]> = {
      '/v2/salon/appointments': year.salon.appointments, '/v2/online/orders': year.online.orders, '/v2/marketing/ads': year.marketing.ads,
      '/v2/marketing/email': year.marketing.email, '/v2/finance/budgets': year.finance.budgets,
    };
    for (const t of V2_TABLES) {
      expect(Object.keys(SOURCE_ROUTES)).toContain(t.path);
      expect(new Set(served[t.path]!.flatMap((r) => Object.keys(r)))).toEqual(new Set(t.cols));
      expect(create.find((s) => s.label.endsWith(`.${t.table}`))!.sql).toContain(`endpoint "${BASE}${t.path}"`);
    }
  });

  it('create the period view last, from the version 2 body', () => {
    expect(create.at(-1)!.sql).toBe(`CREATE SCHEMASTORE VIEW period_metrics WITH CONTAINER fortune_hq_v2 AS ${financeViewBody(2)}`);
  });
});
