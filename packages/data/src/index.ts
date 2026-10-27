import { createHash } from 'node:crypto';
import { Division, Metric, PERIOD_KEYS, type DataPort, type MetricInfo, type MetricSeries, type Period } from '@fahq/contracts';
import { VERSIONS, dataVersionFromEnv, financeQuery, financeViewBody, round } from './finance-sql.ts';
import {
  CATALOG_V2, CATALOG_V2_BY_ID, MARTS_V2, attentionFor, divisionHashText, divisionIds, divisionQueries, layerHashText, layerQueries, seriesHashText,
  seriesQuery, type LayerQuery,
} from './divisions.ts';
import { ROW_CAP, checkRowRead, rowHashText, rowQuery, rowSql, rowsResult } from './rows.ts';
import { SOURCE_PORT_DEFAULT, ensureSourceServer } from './source-server.ts';
import { createZetarisClient, zetarisConfigFromEnv, type ZetarisClient } from './zetaris-client.ts';
import { SOURCE_PORT_V2_DEFAULT } from './zetaris-objects.ts';

export { generateBusiness, generateDivisions, generateHistory, generateOperations, generateYear, PERIODS, SEASON } from './synthetic.ts';
export { createSourceServer, ensureSourceServer, SOURCE_PORT_DEFAULT } from './source-server.ts';
export { createZetarisClient, zetarisConfigFromEnv, ZetarisError } from './zetaris-client.ts';
export { METRICS, FINANCE_VIEW, PERIOD_VIEW_V2, VERSIONS, computeAll, dataVersionFromEnv, type DataVersion } from './finance-sql.ts';
export { AS_OF, DERIVED, STANDING_METRICS, computeLayers } from './layers.ts';
export { ATTENTION, CATALOG_V2, MARTS_V2, attentionFor, divisionIds, divisionSlice, seriesOf } from './divisions.ts';
export { ROW_CAP, WANTED_VIEWS, oracleRows } from './rows.ts';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const WHOLE_MONTHS: readonly Period[] = PERIOD_KEYS.filter((p) => p !== '2026-10-mtd');

/** Zetaris's rows of a series as points, oldest first: each a served period once, each value a number. */
function seriesPoints(metricId: string, raw: readonly string[][]): MetricSeries['points'] {
  const points = raw.map(([period, value]) => {
    const n = Number(value);
    if (!PERIOD_KEYS.includes(period as Period)) throw new Error(`Zetaris returned an unknown period for ${metricId}`);
    if (value === undefined || value === '' || !Number.isFinite(n)) throw new Error(`Zetaris returned a non-numeric value for ${metricId}`);
    return { period: period as Period, value: n };
  });
  if (new Set(points.map((p) => p.period)).size !== points.length) throw new Error(`Zetaris returned a period twice for ${metricId}`);
  if (points.length === 0) throw new Error(`Zetaris returned no values for ${metricId}`);
  return points.sort((a, b) => PERIOD_KEYS.indexOf(a.period) - PERIOD_KEYS.indexOf(b.period));
}

/** The range and the mean of the whole months present (the season index's denominator), rounded as the metric is. */
function seriesStats(points: MetricSeries['points'], unit: Metric['unit']): MetricSeries['stats'] {
  const values = points.map((p) => p.value);
  const year = points.filter((p) => WHOLE_MONTHS.includes(p.period)).map((p) => p.value);
  const mean = year.length === 0 ? null : round(year.reduce((t, v) => t + v, 0) / year.length, unit === 'ratio' ? 4 : 2);
  return { min: Math.min(...values), max: Math.max(...values), mean12: mean };
}
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

  /**
   * The unsliced read's statements and hash. Version 1: one statement on its view, hashed exactly as at
   * bb29578 (a plan's provenance does not move). Version 2: the three layer views, one hash over their
   * bodies and the three queries.
   */
  function financeRead(p: Period): { queries: Ask[]; queryHash: string } {
    if (version === 1) {
      const sql = financeQuery(p, 1);
      return { queries: [{ sql, table: view, period: p, allowed: new Set(served.keys()) }], queryHash: sha256(`${financeViewBody(1)}\n--\n${sql}`) };
    }
    const layered = layerQueries(p);
    return { queries: layered.map((q) => ({ ...q, allowed: ids(q.layer) })), queryHash: sha256(layerHashText(layered)) };
  }

  const base: DataPort = {
    catalog: defs.map(({ id, label, unit, business, divisions, layer, about, nouns, planUse }): MetricInfo => ({
      id, label, unit, business, divisions, layer, ...(about ? { about } : {}), ...(nouns ? { nouns } : {}), ...(planUse === false ? { planUse } : {}),
    })),
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
      const { queries, queryHash } = financeRead(servedPeriod(period));
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

    // The rows behind a standing number: one fixed statement over the source's row view, every matching row,
    // and the totals added up here.
    async readRows({ asOf: _asOf, ...input }) {
      const read = checkRowRead(input);
      const q = rowQuery(read);
      await ensureSources();
      const raw = await client.run(rowSql(q), ROW_CAP + 1);
      return rowsResult(read, raw, sha256(rowHashText(q)));
    },

    // One metric over every period, from the division's own mart.
    async getMetricSeries({ division, metricId }) {
      const d = Division.safeParse(division);
      if (!d.success) throw new Error(`unknown division "${String(division).slice(0, 40)}"`);
      const q = seriesQuery(d.data, String(metricId));
      const def = CATALOG_V2_BY_ID.get(String(metricId))!;
      await ensureSources();
      const points = seriesPoints(def.id, await client.run(q.sql, 50));
      return {
        metricId: def.id, label: def.label, unit: def.unit, business: def.business, points, stats: seriesStats(points, def.unit),
        queryHash: sha256(seriesHashText(d.data, q)), view: q.table,
      };
    },
  };
}
