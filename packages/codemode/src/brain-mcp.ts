import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  AssistantId, DEFAULT_PERIODS, MetricId, type DataPort, type Division, type DivisionData, type Metric, type Period, type RowRead,
} from '@fahq/contracts';
import type { Brain } from '@fahq/brain';
import { loadProfiles, skillFrontmatter, type ReadToolName } from '@fahq/profiles';

// The company brain as one MCP server: the door every AI tool (Claude, Cursor, Codex, Gemini,
// ChatGPT, staff accounts) uses to read the same facts. Reads are read-only; the only write is a
// proposal into the queue, which a person must approve before anything consequential happens.
// Each door belongs to one assistant profile: it offers only what that profile may read, and it
// serves the profile's skill as the `skill` prompt so every tool loads the same read-only rules.

export type BrainMcpDeps = {
  /** Lane B's Zetaris adapter; null until connected, and the tool says so plainly. */
  data: DataPort | null;
  /** Opens a fresh read view of the brain (the worker is the only writer). */
  openBrain: () => Promise<Brain>;
  /** Queues a request for an assistant; omitted = the tool is not offered. */
  propose?: (input: { assistant: AssistantId; text: string; by: string }) => Promise<{ taskId: string }>;
  now: () => Date;
};

const query = z.string().min(2).max(300);
const limit = z.number().int().min(1).max(10).optional();

const ok = (data: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  structuredContent: data,
});
const refuse = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

/** Serves the profile's skill (its read-only rules) as the `skill` prompt. */
export function registerSkillPrompt(server: McpServer, profileId: AssistantId): void {
  const skill = loadProfiles({})[profileId].skill;
  server.registerPrompt(
    'skill',
    { title: skillFrontmatter(profileId).name, description: skillFrontmatter(profileId).description },
    () => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text: skill } }] }),
  );
}

const NOT_CONNECTED = 'Business data is not connected yet (packages/data).';
const plain = (m: Metric) => ({ id: m.id, label: m.label, value: m.value, unit: m.unit, business: m.business, period: m.period });

/** Runs one read of the data port; a missing port or a failed read is a plain refusal, never a guess. */
async function fromData(deps: BrainMcpDeps, read: (data: DataPort, asOf: string) => Promise<Record<string, unknown>>) {
  if (!deps.data) return refuse(NOT_CONNECTED);
  try {
    return ok(await read(deps.data, deps.now().toISOString()));
  } catch (error) {
    return refuse(`Business data could not be read: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

/** One division's read (data version 2); refused by a port without divisions. */
async function divisionRead(data: DataPort, division: Division, period: Period, asOf: string): Promise<DivisionData> {
  if (!data.getDivisionMetrics) throw new Error(`this data source has no ${division} division read (it needs data version 2)`);
  return data.getDivisionMetrics({ division, period, asOf });
}

// A division tool reads its division's mart when the port has divisions; otherwise its business, as before.
const readMetrics = (deps: BrainMcpDeps, forPeriod: Period, division: 'finance' | 'online' | 'salon') => fromData(deps, async (data, asOf) => {
  if (data.getDivisionMetrics) {
    const r = await divisionRead(data, division, forPeriod, asOf);
    return { view: r.view, queryHash: r.queryHash, metrics: r.metrics.map(plain), attention: r.attention };
  }
  const r = await data.getFinanceMetrics({ asOf, period: forPeriod });
  return { view: r.view, queryHash: r.queryHash, metrics: r.metrics.filter((m) => division === 'finance' || m.business === division).map(plain) };
});

/** The rows of one fixed read, at most `limit` shown; the totals cover every matching row. */
const readRows = (deps: BrainMcpDeps, read: RowRead, limit: number | undefined) => fromData(deps, async (data, asOf) => {
  if (!data.readRows) throw new Error('this data source has no row reads (they need data version 2)');
  const r = await data.readRows({ ...read, asOf });
  return { dataDate: r.dataDate, view: r.view, queryHash: r.queryHash, totals: r.totals, rows: r.rows.slice(0, limit ?? 20) };
});

// Whose metrics a profile's series may be asked for (as in the worker's read tools).
const SERIES_DIVISIONS: Record<AssistantId, readonly Division[]> = { owner: ['finance', 'hq'], finance: ['finance'], online: ['online'], salon: ['salon'], manager: [] };
const BUDGET_IDS = /^m:online\.(budget\.|ads\.[a-z]+\.spend$|season\.last_year_index$)/;
const rowLimit = z.number().int().min(1).max(50).optional();

// The reads this door can serve. The rest of a profile's reads (lessons, work reports, usage, open items, the
// latest proposal) are served inside the worker only.
const DOOR_READS: readonly ReadToolName[] = [
  'get_finance_metrics', 'get_online_metrics', 'get_salon_metrics', 'recall_decisions', 'recall_my_decisions', 'get_timeline',
  // The division data: these need only the data port.
  'get_budget_room', 'get_metric_series', 'get_company_overview', 'get_data_quality', 'get_repair_tickets', 'get_supplier_invoices',
  'get_waiting_conversations', 'get_low_stock_interest',
];

/** What a profile's door offers: its reads, limited to what the door can serve. Empty for the salon placeholder. */
export function doorReads(profileId: AssistantId): ReadToolName[] {
  return loadProfiles({})[profileId].reads.filter((name) => DOOR_READS.includes(name));
}

export function createBrainMcpServer(deps: BrainMcpDeps, profileId: AssistantId = 'owner'): McpServer {
  const profile = loadProfiles({})[profileId];
  const reads = doorReads(profileId);
  const may = (name: ReadToolName) => reads.includes(name);
  const server = new McpServer({ name: 'fortune-brain', version: '0.1.0' });
  registerSkillPrompt(server, profileId);
  // Exactly the periods the data serves (version 1: the last two).
  const period = z.enum(deps.data?.periods ?? DEFAULT_PERIODS);

  if (may('get_finance_metrics')) {
    server.registerTool(
      'get_finance_metrics',
      {
        description:
          'Salon and online finance metrics for one period, read through Zetaris (read-only). Salon and online stay separate; combined totals are labeled "combined". Every metric carries the query hash it came from.',
        inputSchema: { period },
      },
      ({ period: p }) => readMetrics(deps, p, 'finance'),
    );
  }

  if (may('get_online_metrics')) {
    server.registerTool(
      'get_online_metrics',
      {
        description:
          'Online store metrics for one period, read through Zetaris (read-only). Online only: salon and combined metrics are not returned. Every metric carries the query hash it came from.',
        inputSchema: { period },
      },
      ({ period: p }) => readMetrics(deps, p, 'online'),
    );
  }

  if (may('get_salon_metrics')) {
    server.registerTool(
      'get_salon_metrics',
      {
        description:
          'Salon metrics for one period, read through Zetaris (read-only; synthetic data standing in for the head stylist\'s own backend). Salon only. Every metric carries the query hash it came from.',
        inputSchema: { period },
      },
      ({ period: p }) => readMetrics(deps, p, 'salon'),
    );
  }

  registerDivisionReads(server, deps, profileId, may, period);

  if (may('recall_decisions')) {
    server.registerTool(
      'recall_decisions',
      {
        description: "What people approved or declined before, from one assistant's memory. Returns decisions only, never unapproved ideas.",
        inputSchema: { assistant: AssistantId, query, limit },
      },
      async ({ assistant: who, query: q, limit: n }) => recall(deps, who, q, n),
    );
  }

  if (may('recall_my_decisions')) {
    server.registerTool(
      'recall_my_decisions',
      {
        description: `What people approved or declined before, from your own memory (${profile.memory}) only. Returns decisions only, never unapproved ideas.`,
        inputSchema: { query, limit },
      },
      async ({ query: q, limit: n }) => recall(deps, profile.memory, q, n),
    );
  }

  if (may('get_timeline')) {
    server.registerTool(
      'get_timeline',
      {
        description: 'The latest events in the shared record: who asked, which assistant proposed, which numbers were cited, who decided.',
        inputSchema: { limit: z.number().int().min(1).max(100).optional() },
      },
      async ({ limit: n }) => {
        const brain = await deps.openBrain();
        return ok({ events: brain.record.timeline(n ?? 25).map((e) => ({ id: e.id, type: e.type, at: e.at })) });
      },
    );
  }

  if (profile.writes.includes('propose') && deps.propose) {
    const propose = deps.propose;
    server.registerTool(
      'propose_task',
      {
        description: 'Queue a request for an assistant. This only proposes: a person approves anything that touches money, customers or ads.',
        inputSchema: { assistant: AssistantId, text: z.string().min(3).max(1000), by: z.string().min(2).max(80) },
      },
      async (input) => ok(await propose(input)),
    );
  }

  return server;
}

/** The division data's reads (data version 2), each offered only when the profile lists it. */
function registerDivisionReads(server: McpServer, deps: BrainMcpDeps, profileId: AssistantId, may: (name: ReadToolName) => boolean, period: z.ZodType<Period>) {
  const tool = (name: ReadToolName, description: string, inputSchema: z.ZodRawShape, run: (args: any) => ReturnType<typeof fromData>) => {
    if (may(name)) server.registerTool(name, { description, inputSchema }, run);
  };
  tool('get_budget_room', "Each ad channel's approved budget, spend, budget left and share used for one period, from the finance owner's budget sheet and the ad reports in Zetaris (read-only), with the budget attention rules that fired.", { period }, ({ period: p }) =>
    fromData(deps, async (data, asOf) => {
      const r = await divisionRead(data, 'finance', p, asOf);
      return { view: r.view, queryHash: r.queryHash, metrics: r.metrics.filter((m) => BUDGET_IDS.test(m.id)).map(plain), attention: r.attention.filter((a) => a.metricId.startsWith('m:online.budget.')) };
    }));
  tool('get_metric_series', "One of your division's metrics in every period, oldest first, from its Zetaris mart (read-only), with its lowest, highest and mean of the twelve whole months.", { metricId: MetricId }, ({ metricId }) =>
    fromData(deps, async (data, asOf) => {
      if (!data.getMetricSeries) throw new Error('this data source has no series (it needs data version 2)');
      const info = data.catalog?.find((m) => m.id === metricId);
      const division = SERIES_DIVISIONS[profileId].find((d) => info?.divisions?.includes(d));
      if (!division) throw new Error(`${metricId} is not one of the metrics your division reads`);
      return data.getMetricSeries({ division, metricId, asOf });
    }));
  tool('get_company_overview', 'The whole company for one period from the HQ mart in Zetaris (read-only): salon and online side by side, never added together, and the attention list (empty means running normally).', { period }, ({ period: p }) =>
    fromData(deps, async (data, asOf) => {
      const r = await divisionRead(data, 'hq', p, asOf);
      const side = (b: string) => r.metrics.filter((m) => m.business === b).map(plain);
      return { view: r.view, queryHash: r.queryHash, normal: r.attention.length === 0, salon: side('salon'), online: side('online'), combined: side('combined'), attention: r.attention };
    }));
  tool('get_data_quality', 'Rows each source system sent that failed the data checks and were left out of the numbers, for one period, from Zetaris (read-only).', { period }, ({ period: p }) =>
    fromData(deps, async (data, asOf) => {
      const r = await divisionRead(data, 'hq', p, asOf);
      return { view: r.view, queryHash: r.queryHash, rejected: r.metrics.filter((m) => /\.dq\.rejected_/.test(m.id)).map(plain) };
    }));
  tool('get_repair_tickets', 'Salon repair tickets through Zetaris (read-only): open, late (open over two weeks) or done in the last 30 days, with the count and fee and cost totals of every matching ticket.', { status: z.enum(['open', 'late', 'done']), limit: rowLimit }, ({ status, limit }) =>
    readRows(deps, { table: 'repairs', status }, limit));
  tool('get_supplier_invoices', 'Unpaid supplier invoices through Zetaris (read-only): open, overdue or due in the next 30 days, one business or both, with what is owed per business (never added across the two).', { status: z.enum(['open', 'overdue', 'due_30d']), business: z.enum(['salon', 'online']).optional(), limit: rowLimit }, ({ status, business, limit }) =>
    readRows(deps, { table: 'invoices', status, ...(business ? { business } : {}) }, limit));
  tool('get_waiting_conversations', 'Customer messages from the last week still waiting for a first answer, through Zetaris (read-only): channel, topic and hours waited; never the text or the customer.', { olderThanHours: z.number().min(0).max(720).optional(), limit: rowLimit }, ({ olderThanHours, limit }) =>
    readRows(deps, { table: 'waiting', olderThanHours: olderThanHours ?? 0 }, limit));
  tool('get_low_stock_interest', 'Store products at or below their reorder point on the data date, through Zetaris (read-only), most viewed first, with how many are wanted and how many wanted ones are out of stock.', { limit: rowLimit }, ({ limit }) =>
    readRows(deps, { table: 'low_stock' }, limit));
}

async function recall(deps: BrainMcpDeps, who: AssistantId, q: string, n: number | undefined) {
  const brain = await deps.openBrain();
  const decisions = brain.memory(who).recallDecisions(q, n ?? 5);
  return ok({ decisions: decisions.map((d) => ({ id: d.memory.id, text: d.memory.content, tags: d.memory.tags, relevance: Number(d.relevance.toFixed(3)) })) });
}
