import { createHash } from 'node:crypto';
import { Division, Metric, type DataPort, type MetricInfo, type Period } from '@fahq/contracts';
import { VERSIONS, dataVersionFromEnv, financeQuery, financeViewBody } from './finance-sql.ts';
import {
  CATALOG_V2, MARTS_V2, attentionFor, divisionHashText, divisionIds, divisionQueries, layerHashText, layerQueries, type LayerQuery,
} from './divisions.ts';
import { SOURCE_PORT_DEFAULT, ensureSourceServer } from './source-server.ts';
import { createZetarisClient, zetarisConfigFromEnv, type ZetarisClient } from './zetaris-client.ts';
import { SOURCE_PORT_V2_DEFAULT } from './zetaris-objects.ts';

export { generateBusiness, generateDivisions, generateHistory, generateYear, PERIODS, SEASON } from './synthetic.ts';
export { createSourceServer, ensureSourceServer, SOURCE_PORT_DEFAULT } from './source-server.ts';
export { createZetarisClient, zetarisConfigFromEnv, ZetarisError } from './zetaris-client.ts';
export { METRICS, FINANCE_VIEW, PERIOD_VIEW_V2, VERSIONS, computeAll, dataVersionFromEnv, type DataVersion } from './finance-sql.ts';
export { AS_OF, DERIVED, STANDING_METRICS, computeLayers } from './layers.ts';
export { ATTENTION, CATALOG_V2, MARTS_V2, attentionFor, divisionIds, divisionSlice } from './divisions.ts';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/** One statement of a read, with the ids it may return. */
type Ask = Pick<LayerQuery, 'sql' | 'table' | 'period'> & { allowed: ReadonlySet<string> };

/**
 * The assistants' numbers, read through Zetaris. Version 1 (the default): the governed view
 * fortune_hq.finance_metrics, one statement. Version 2 (FAHQ_DATA_VERSION=2): three layers (period totals,
 * derived numbers, standing numbers as of the data date), each its own view and statement; getFinanceMetrics
 * reads all of them unsliced, and getDivisionMetrics reads one division's own Virtual Data Mart. A query hash
 * covers every view body involved and the queries, so a plan's provenance changes if any of them changes.
 * Any failure throws; there is no fallback data.
 */
export function createZetarisDataPort(
  env: NodeJS.ProcessEnv,
  deps: { fetch?: typeof fetch; client?: ZetarisClient; ensureSources?: () => Promise<unknown> } = {},
): DataPort {
  const version = dataVersionFromEnv(env);
  const { periods, view } = VERSIONS[version];
  const defs = version === 2 ? CATALOG_V2 : VERSIONS[1].metrics;
  const served = new Map(defs.map((d) => [d.id, d]));
  const client = deps.client ?? createZetarisClient({ ...zetarisConfigFromEnv(env), ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  // The demo's source systems are a local synthetic API; make sure it is up before Zetaris reads it.
  // Version 2's tables read their own port, so the server version 1 reads is never involved.
  const sourcePort = Number(version === 2 ? (env.FAHQ_SOURCE_PORT_V2 ?? SOURCE_PORT_V2_DEFAULT) : (env.FAHQ_SOURCE_PORT ?? SOURCE_PORT_DEFAULT));
  const ensureSources = deps.ensureSources ?? (() => ensureSourceServer(sourcePort));

  const servedPeriod = (period: string): Period => {
    if (!periods.includes(period as Period)) throw new Error(`unknown period "${period}"`);
    return period as Period;
  };

  /** Runs the statements together; each row must be a metric that statement may return, with a number. */
  async function read(queries: readonly Ask[], asOf: string, queryHash: string): Promise<Metric[]> {
    await ensureSources();
    const answers = await Promise.all(queries.map((q) => client.run(q.sql, 500)));
    const metrics = answers.flatMap((rows, i) => rows.map(([id, raw]) => {
      const q = queries[i]!;
      const def = id && q.allowed.has(id) ? served.get(id) : undefined;
      if (!def) throw new Error(`Zetaris returned a metric this adapter does not know: ${String(id).slice(0, 80)}`);
      const value = Number(raw);
      if (raw === undefined || raw === '' || !Number.isFinite(value)) throw new Error(`Zetaris returned a non-numeric value for ${def.id}`);
      return Metric.parse({
        id: def.id, label: def.label, value, unit: def.unit, business: def.business, period: q.period,
        source: { system: 'zetaris', view: q.table, queryHash, asOf },
      });
    }));
    if (new Set(metrics.map((m) => m.id)).size !== metrics.length) throw new Error('Zetaris returned a metric twice');
    return metrics.sort((a, b) => a.id.localeCompare(b.id));
  }

  const ids = (layer: LayerQuery['layer'], division?: Division) =>
    new Set(division ? divisionIds(division, layer) : CATALOG_V2.filter((m) => m.layer === layer).map((m) => m.id));

  const base: DataPort = {
    catalog: defs.map(({ id, label, unit, business, divisions, layer }): MetricInfo => ({ id, label, unit, business, divisions, layer })),
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
      const p = servedPeriod(period);
      // Version 1: one statement on its view, hashed exactly as before (a plan's provenance does not move).
      // Version 2: the three layer views, unsliced, one hash over their bodies and the three queries.
      const queries = version === 1
        ? [{ sql: financeQuery(p, 1), table: view, period: p, allowed: new Set(served.keys()) }]
        : layerQueries(p).map((q) => ({ ...q, allowed: ids(q.layer) }));
      const queryHash = sha256(version === 1 ? `${financeViewBody(1)}\n--\n${queries[0]!.sql}` : layerHashText(layerQueries(p)));
      const metrics = await read(queries, asOf, queryHash);
      if (metrics.length === 0) throw new Error(`Zetaris returned no finance metrics for ${period}`);
      return { metrics, queryHash, view };
    },
  };
  if (version === 1) return base;

  return {
    ...base,
    // One division's own numbers, from its own mart: period totals and derived numbers for the period, and
    // the standing numbers as of the data date, with the attention rules that fired on them.
    async getDivisionMetrics({ division, period, asOf }) {
      const d = Division.safeParse(division);
      if (!d.success) throw new Error(`unknown division "${String(division).slice(0, 40)}"`);
      const queries = divisionQueries(d.data, servedPeriod(period));
      const queryHash = sha256(divisionHashText(d.data, queries));
      const metrics = await read(queries.map((q) => ({ ...q, allowed: ids(q.layer, d.data) })), asOf, queryHash);
      if (metrics.length === 0) throw new Error(`Zetaris returned no ${d.data} metrics for ${period}`);
      return { division: d.data, metrics, attention: attentionFor(metrics), queryHash, view: MARTS_V2[d.data] };
    },
  };
}
