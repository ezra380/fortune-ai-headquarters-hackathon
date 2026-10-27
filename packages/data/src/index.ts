import { createHash } from 'node:crypto';
import { Metric, type DataPort, type Period } from '@fahq/contracts';
import { VERSIONS, dataVersionFromEnv, financeQuery, financeViewBody } from './finance-sql.ts';
import { SOURCE_PORT_DEFAULT, ensureSourceServer } from './source-server.ts';
import { createZetarisClient, zetarisConfigFromEnv, type ZetarisClient } from './zetaris-client.ts';

export { generateBusiness, generateDivisions, generateHistory, generateYear, PERIODS, SEASON } from './synthetic.ts';
export { createSourceServer, ensureSourceServer, SOURCE_PORT_DEFAULT } from './source-server.ts';
export { createZetarisClient, zetarisConfigFromEnv, ZetarisError } from './zetaris-client.ts';
export { METRICS, FINANCE_VIEW, PERIOD_VIEW_V2, VERSIONS, computeAll, dataVersionFromEnv, type DataVersion } from './finance-sql.ts';

/**
 * The assistants' numbers, read through Zetaris from a governed view (version 1:
 * fortune_hq.finance_metrics; version 2, with FAHQ_DATA_VERSION=2: fortune_hq_v2.period_metrics), which
 * federates the salon, online, marketing and finance sources and applies the data-quality rules. The
 * query hash covers the view definition and the query, so a plan's provenance changes if either changes.
 * Any failure throws; there is no fallback data.
 */
export function createZetarisDataPort(
  env: NodeJS.ProcessEnv,
  deps: { fetch?: typeof fetch; client?: ZetarisClient; ensureSources?: () => Promise<unknown> } = {},
): DataPort {
  const version = dataVersionFromEnv(env);
  const { periods, view, metrics: defs } = VERSIONS[version];
  const served = new Map(defs.map((d) => [d.id, d]));
  const client = deps.client ?? createZetarisClient({ ...zetarisConfigFromEnv(env), ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  // The demo's source systems are a local synthetic API; make sure it is up before Zetaris reads it.
  const port = Number(env.FAHQ_SOURCE_PORT ?? SOURCE_PORT_DEFAULT);
  const ensureSources = deps.ensureSources ?? (() => ensureSourceServer(port));

  return {
    catalog: defs.map(({ id, label, unit, business, divisions }) => ({ id, label, unit, business, divisions })),
    periods,

    async health() {
      try {
        await ensureSources();
        await client.run('SELECT 1', 1);
        return { ok: true, detail: `Zetaris reachable; finance view ${view}` };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : 'unknown error' };
      }
    },

    async getFinanceMetrics({ asOf, period }) {
      if (!periods.includes(period as Period)) throw new Error(`unknown period "${period}"`);
      const sql = financeQuery(period as Period, version);
      const queryHash = createHash('sha256').update(`${financeViewBody(version)}\n--\n${sql}`).digest('hex');
      await ensureSources();
      const rows = await client.run(sql, 500);
      const metrics = rows.map(([id, raw]) => {
        const def = id ? served.get(id) : undefined;
        if (!def) throw new Error(`Zetaris returned a metric this adapter does not know: ${String(id).slice(0, 80)}`);
        const value = Number(raw);
        if (raw === undefined || raw === '' || !Number.isFinite(value)) throw new Error(`Zetaris returned a non-numeric value for ${def.id}`);
        return Metric.parse({
          id: def.id, label: def.label, value, unit: def.unit, business: def.business, period,
          source: { system: 'zetaris', view, queryHash, asOf },
        });
      });
      if (metrics.length === 0) throw new Error(`Zetaris returned no finance metrics for ${period}`);
      if (new Set(metrics.map((m) => m.id)).size !== metrics.length) throw new Error('Zetaris returned a metric twice');
      metrics.sort((a, b) => a.id.localeCompare(b.id));
      return { metrics, queryHash, view };
    },
  };
}
