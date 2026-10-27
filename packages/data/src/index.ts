import { createHash } from 'node:crypto';
import { Metric, type DataPort } from '@fahq/contracts';
import { FINANCE_VIEW, METRICS, METRIC_BY_ID, financeQuery, financeViewBody } from './finance-sql.ts';
import { SOURCE_PORT_DEFAULT, ensureSourceServer } from './source-server.ts';
import { PERIODS, type Period } from './synthetic.ts';
import { createZetarisClient, zetarisConfigFromEnv, type ZetarisClient } from './zetaris-client.ts';

export { generateBusiness, PERIODS } from './synthetic.ts';
export { createSourceServer, ensureSourceServer, SOURCE_PORT_DEFAULT } from './source-server.ts';
export { createZetarisClient, zetarisConfigFromEnv, ZetarisError } from './zetaris-client.ts';
export { METRICS, FINANCE_VIEW, computeFinanceMetricsLocally } from './finance-sql.ts';

/**
 * The finance assistant's numbers, read through Zetaris from the governed view
 * fortune_hq.finance_metrics (which federates the salon, online and marketing sources and applies
 * the data-quality rules). The query hash covers the view definition and the query, so a plan's
 * provenance changes if either changes. Any failure throws; there is no fallback data.
 */
export function createZetarisDataPort(
  env: NodeJS.ProcessEnv,
  deps: { fetch?: typeof fetch; client?: ZetarisClient; ensureSources?: () => Promise<unknown> } = {},
): DataPort {
  const client = deps.client ?? createZetarisClient({ ...zetarisConfigFromEnv(env), ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  // The demo's three source systems are a local synthetic API; make sure it is up before Zetaris reads it.
  const port = Number(env.FAHQ_SOURCE_PORT ?? SOURCE_PORT_DEFAULT);
  const ensureSources = deps.ensureSources ?? (() => ensureSourceServer(port));

  return {
    catalog: METRICS.map(({ id, label, unit, business }) => ({ id, label, unit, business })),

    async health() {
      try {
        await ensureSources();
        await client.run('SELECT 1', 1);
        return { ok: true, detail: `Zetaris reachable; finance view ${FINANCE_VIEW}` };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : 'unknown error' };
      }
    },

    async getFinanceMetrics({ asOf, period }) {
      if (!(period in PERIODS)) throw new Error(`unknown period "${period}"`);
      const sql = financeQuery(period as Period);
      const queryHash = createHash('sha256').update(`${financeViewBody()}\n--\n${sql}`).digest('hex');
      await ensureSources();
      const rows = await client.run(sql, 500);
      const metrics = rows.map(([id, raw]) => {
        const def = id ? METRIC_BY_ID.get(id) : undefined;
        if (!def) throw new Error(`Zetaris returned a metric this adapter does not know: ${String(id).slice(0, 80)}`);
        const value = Number(raw);
        if (raw === undefined || raw === '' || !Number.isFinite(value)) throw new Error(`Zetaris returned a non-numeric value for ${def.id}`);
        return Metric.parse({
          id: def.id, label: def.label, value, unit: def.unit, business: def.business, period,
          source: { system: 'zetaris', view: FINANCE_VIEW, queryHash, asOf },
        });
      });
      if (metrics.length === 0) throw new Error(`Zetaris returned no finance metrics for ${period}`);
      if (new Set(metrics.map((m) => m.id)).size !== metrics.length) throw new Error('Zetaris returned a metric twice');
      metrics.sort((a, b) => a.id.localeCompare(b.id));
      return { metrics, queryHash, view: FINANCE_VIEW };
    },
  };
}
