import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  AssistantId, DEFAULT_PERIODS, MetricId, SESSION_REPORT_MAX_BYTES, SessionReport, type DataPort, type Division, type DivisionData, type Metric,
  type Period, type RowRead,
} from '@fahq/contracts';
import type { Brain } from '@fahq/brain';
import { READ_TOOL_NAMES, doorSkill, loadProfiles, skillFrontmatter, type AssistantProfile, type DoorTool, type ReadToolName } from '@fahq/profiles';

// The company brain as one MCP server: the door every AI tool (Claude, Cursor, Codex, Gemini,
// ChatGPT, staff accounts) uses to read the same facts. Reads are read-only; the only write is a
// proposal into the queue, which a person must approve before anything consequential happens.
// Each door belongs to one assistant profile: it offers only what that profile may read, and it
// serves the profile's skill as the `skill` prompt so every tool loads the same read-only rules. The one
// write is `file_work_report`: the end-of-work log and suggested lessons go to the HQ Manager, who decides
// what changes. A door never changes data, a profile or a decision.

export type BrainMcpDeps = {
  /** Lane B's Zetaris adapter; null until connected, and the tool says so plainly. */
  data: DataPort | null;
  /** Opens a fresh read view of the brain (the worker is the only writer). */
  openBrain: () => Promise<Brain>;
  /** Queues a request for an assistant; omitted = the tool is not offered. */
  propose?: (input: { assistant: AssistantId; text: string; by: string }) => Promise<{ taskId: string }>;
  /** Files a session report with the HQ Manager (through the database door); omitted = `file_work_report` is not offered. */
  fileReport?: FileReport;
  now: () => Date;
};

export type FiledReport = { id: string; duplicate: boolean };
export type FileReport = (report: SessionReport) => Promise<FiledReport>;

/** A door serves a stored profile (an object) or, offline, the profile of that id from the files. */
export type DoorProfileArg = AssistantId | AssistantProfile;
const profileOf = (arg: DoorProfileArg): AssistantProfile => (typeof arg === 'string' ? loadProfiles({})[arg] : arg);

// What a client may assume about a tool before it calls it: the reads change nothing; the report adds one row.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITES_ONE_ROW = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const query = z.string().min(2).max(300);
const limit = z.number().int().min(1).max(10).optional();

const ok = (data: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  structuredContent: data,
});
const refuse = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

/** What each tool does, in the words a door uses for the tool and, where the skill has no line for it, for the skill. */
function describeReads(profile: AssistantProfile): Partial<Record<ReadToolName, string>> {
  return {
    get_finance_metrics:
      'Salon and online finance metrics for one period, read through Zetaris (read-only). Salon and online stay separate; combined totals are labeled "combined". Every metric carries the query hash it came from.',
    get_online_metrics:
      'Online store metrics for one period, read through Zetaris (read-only). Online only: salon and combined metrics are not returned. Every metric carries the query hash it came from.',
    get_salon_metrics:
      'Salon metrics for one period, read through Zetaris (read-only; synthetic data standing in for the head stylist\'s own backend). Salon only. Every metric carries the query hash it came from.',
    get_budget_room:
      "Each ad channel's approved budget, spend, budget left and share used for one period, from the finance owner's budget sheet and the ad reports in Zetaris (read-only), with the budget attention rules that fired.",
    get_metric_series:
      "One of your division's metrics in every period, oldest first, from its Zetaris mart (read-only), with its lowest, highest and mean of the twelve whole months.",
    get_company_overview:
      'The whole company for one period from the HQ mart in Zetaris (read-only): salon and online side by side, never added together, and the attention list (empty means running normally).',
    get_data_quality:
      'Rows each source system sent that failed the data checks and were left out of the numbers, for one period, from Zetaris (read-only): one count per source, each under its business.',
    get_repair_tickets:
      'Salon repair tickets through Zetaris (read-only): open, late (open over two weeks) or done in the last 30 days, with the count and fee and cost totals of every matching ticket.',
    get_supplier_invoices:
      'Unpaid supplier invoices through Zetaris (read-only): open, overdue or due in the next 30 days, one business or both, with what is owed per business (never added across the two).',
    get_waiting_conversations:
      'Customer messages from the last week still waiting for a first answer, through Zetaris (read-only): channel, topic and hours waited; never the text or the customer.',
    get_low_stock_interest:
      'Store products at or below their reorder point on the data date, through Zetaris (read-only), most viewed first, with how many are wanted and how many wanted ones are out of stock.',
    get_marketplace_stock:
      'Amazon and Walmart warehouse stock on the data date, through Zetaris (read-only): each listing on hand, inbound, sold in the last 28 days and its days of cover; all, or only those out of stock or under three weeks of cover; with the totals.',
    get_product_performance:
      "Each store product's units, revenue, cost, refunds, profit, views and rating for one period, through Zetaris (read-only), best or worst profit first, with the totals and how many lost money.",
    get_store_journey:
      "The store site's visits, carts, checkouts and orders for one period, through Zetaris (read-only), by where the visits came from, with the cart and conversion rates and the totals.",
    get_return_cases:
      "Each refund of one period, through Zetaris (read-only): reason, amount, days after the sale, and the customer's (a synthetic id) refunds this year, reviews and message topics; never a name or a message's text; totals by reason.",
    recall_decisions: "What people approved or declined before, from one assistant's memory. Returns decisions only, never unapproved ideas.",
    recall_my_decisions: `What people approved or declined before, from your own memory (${profile.memory}) only. Returns decisions only, never unapproved ideas.`,
    get_timeline: 'The latest events in the shared record: who asked, which assistant proposed, which numbers were cited, who decided.',
  };
}

/** The read tools this door offers a profile, with the words it describes them in. */
export function doorTools(arg: DoorProfileArg): DoorTool[] {
  const profile = profileOf(arg);
  const words = describeReads(profile);
  return doorReads(profile).map((name) => ({ name, description: words[name] ?? name }));
}

/**
 * Serves the profile's skill as the `skill` prompt, rewritten so it names only the tools this door offers
 * (and says so when the door has nowhere to file a work report). The profile's standing lessons come with it.
 */
export function registerSkillPrompt(server: McpServer, arg: DoorProfileArg, options: { canReport?: boolean } = {}): void {
  const profile = profileOf(arg);
  const skill = doorSkill(profile, { tools: doorTools(profile), canReport: options.canReport ?? false, readNames: READ_TOOL_NAMES });
  const front = skillFrontmatter(profile.id);
  server.registerPrompt('skill', { title: front.name, description: front.description }, () => ({
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text: skill } }],
  }));
}

const NOT_CONNECTED = 'Business data is not connected yet (packages/data).';
const READ_FAILED = 'Business data could not be read (ZETARIS_READ).';
const plain = (m: Metric) => ({ id: m.id, label: m.label, value: m.value, unit: m.unit, business: m.business, period: m.period });

/** A refusal the door words itself: a plain sentence, safe to show. Any other error is the provider's text. */
class DoorRefusal extends Error {}

/** The failure for the server log: its kind and text, cut short, with any email address or phone number masked. */
const logDetail = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : 'unknown')
  .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]').replace(/\+?\d[\d ().-]{8,}\d/g, '[phone]').slice(0, 300);

/**
 * Runs one read of the data port; a missing port or a failed read is a plain refusal, never a guess. A provider's
 * own text (an HTTP body, SQL, a host name) never reaches the client: it gets a fixed sentence with a code, and
 * the detail goes to the server log (Law 7; doors.test.ts "keeps the provider's text out of the answer").
 */
async function fromData(deps: BrainMcpDeps, read: (data: DataPort, asOf: string) => Promise<Record<string, unknown>>) {
  if (!deps.data) return refuse(NOT_CONNECTED);
  try {
    return ok(await read(deps.data, deps.now().toISOString()));
  } catch (error) {
    if (error instanceof DoorRefusal) return refuse(`Business data could not be read: ${error.message}`);
    console.error(`fortune-brain.zetaris_read_failed ${logDetail(error)}`);
    return refuse(READ_FAILED);
  }
}

/** One division's read (data version 2); refused by a port without divisions. */
async function divisionRead(data: DataPort, division: Division, period: Period, asOf: string): Promise<DivisionData> {
  if (!data.getDivisionMetrics) throw new DoorRefusal(`this data source has no ${division} division read (it needs data version 2)`);
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
  if (!data.readRows) throw new DoorRefusal('this data source has no row reads (they need data version 2)');
  const r = await data.readRows({ ...read, asOf });
  return { dataDate: r.dataDate, view: r.view, queryHash: r.queryHash, totals: r.totals, rows: r.rows.slice(0, limit ?? 20) };
});

// Whose metrics a profile's series may be asked for (as in the worker's read tools).
const SERIES_DIVISIONS: Record<AssistantId, readonly Division[]> = { owner: ['finance', 'hq'], finance: ['finance'], online: ['online'], salon: ['salon'], manager: [], legal: [] };
const BUDGET_IDS = /^m:online\.(budget\.|ads\.[a-z]+\.spend$|season\.last_year_index$)/;
const rowLimit = z.number().int().min(1).max(50).optional();

// The reads this door can serve. The rest of a profile's reads (lessons, work reports, usage, open items, the
// latest proposal) are served inside the worker only.
const DOOR_READS: readonly ReadToolName[] = [
  'get_finance_metrics', 'get_online_metrics', 'get_salon_metrics', 'recall_decisions', 'recall_my_decisions', 'get_timeline',
  // The division data: these need only the data port.
  'get_budget_room', 'get_metric_series', 'get_company_overview', 'get_data_quality', 'get_repair_tickets', 'get_supplier_invoices',
  'get_waiting_conversations', 'get_low_stock_interest', 'get_marketplace_stock', 'get_product_performance', 'get_return_cases',
  'get_store_journey',
];

/** What a profile's door offers: its reads, limited to what the door can serve. Empty for the salon placeholder. */
export function doorReads(arg: DoorProfileArg): ReadToolName[] {
  return profileOf(arg).reads.filter((name) => DOOR_READS.includes(name));
}

export function createBrainMcpServer(deps: BrainMcpDeps, arg: DoorProfileArg = 'owner'): McpServer {
  const profile = profileOf(arg);
  const reads = doorReads(profile);
  const may = (name: ReadToolName) => reads.includes(name);
  const words = describeReads(profile);
  const server = new McpServer({ name: 'fortune-brain', version: '0.1.0' });
  registerSkillPrompt(server, profile, { canReport: deps.fileReport !== undefined });
  // Exactly the periods the data serves (version 1: the last two).
  const period = z.enum(deps.data?.periods ?? DEFAULT_PERIODS);

  if (may('get_finance_metrics')) {
    server.registerTool(
      'get_finance_metrics',
      {
        description: words.get_finance_metrics,
        annotations: READ_ONLY,
        inputSchema: { period },
      },
      ({ period: p }) => readMetrics(deps, p, 'finance'),
    );
  }

  if (may('get_online_metrics')) {
    server.registerTool(
      'get_online_metrics',
      {
        description: words.get_online_metrics,
        annotations: READ_ONLY,
        inputSchema: { period },
      },
      ({ period: p }) => readMetrics(deps, p, 'online'),
    );
  }

  if (may('get_salon_metrics')) {
    server.registerTool(
      'get_salon_metrics',
      {
        description: words.get_salon_metrics,
        annotations: READ_ONLY,
        inputSchema: { period },
      },
      ({ period: p }) => readMetrics(deps, p, 'salon'),
    );
  }

  registerDivisionReads(server, deps, profile, may, period);

  if (may('recall_decisions')) {
    server.registerTool(
      'recall_decisions',
      {
        description: words.recall_decisions,
        annotations: READ_ONLY,
        inputSchema: { assistant: AssistantId, query, limit },
      },
      async ({ assistant: who, query: q, limit: n }) => recall(deps, who, q, n),
    );
  }

  if (may('recall_my_decisions')) {
    server.registerTool(
      'recall_my_decisions',
      {
        description: words.recall_my_decisions,
        annotations: READ_ONLY,
        inputSchema: { query, limit },
      },
      async ({ query: q, limit: n }) => recall(deps, profile.memory, q, n),
    );
  }

  if (may('get_timeline')) {
    server.registerTool(
      'get_timeline',
      {
        description: words.get_timeline,
        annotations: READ_ONLY,
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
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        inputSchema: { assistant: AssistantId, text: z.string().min(3).max(1000), by: z.string().min(2).max(80) },
      },
      async (input) => ok(await propose(input)),
    );
  }

  if (deps.fileReport) registerWorkReportTool(server, deps.fileReport);

  return server;
}

/** The division data's reads (data version 2), each offered only when the profile lists it. */
function registerDivisionReads(server: McpServer, deps: BrainMcpDeps, profile: AssistantProfile, may: (name: ReadToolName) => boolean, period: z.ZodType<Period>) {
  const words = describeReads(profile);
  const tool = (name: ReadToolName, inputSchema: z.ZodRawShape, run: (args: any) => ReturnType<typeof fromData>) => {
    if (may(name)) server.registerTool(name, { description: words[name], annotations: READ_ONLY, inputSchema }, run);
  };
  tool('get_budget_room', { period }, ({ period: p }) =>
    fromData(deps, async (data, asOf) => {
      const r = await divisionRead(data, 'finance', p, asOf);
      return { view: r.view, queryHash: r.queryHash, metrics: r.metrics.filter((m) => BUDGET_IDS.test(m.id)).map(plain), attention: r.attention.filter((a) => a.metricId.startsWith('m:online.budget.')) };
    }));
  tool('get_metric_series', { metricId: MetricId }, ({ metricId }) =>
    fromData(deps, async (data, asOf) => {
      if (!data.getMetricSeries) throw new DoorRefusal('this data source has no series (it needs data version 2)');
      const info = data.catalog?.find((m) => m.id === metricId);
      const division = SERIES_DIVISIONS[profile.id].find((d) => info?.divisions?.includes(d));
      if (!division) throw new DoorRefusal(`${metricId} is not one of the metrics your division reads`);
      return data.getMetricSeries({ division, metricId, asOf });
    }));
  tool('get_company_overview', { period }, ({ period: p }) =>
    fromData(deps, async (data, asOf) => {
      const r = await divisionRead(data, 'hq', p, asOf);
      const side = (b: string) => r.metrics.filter((m) => m.business === b).map(plain);
      return { view: r.view, queryHash: r.queryHash, normal: r.attention.length === 0, salon: side('salon'), online: side('online'), combined: side('combined'), attention: r.attention };
    }));
  // The same shape as the worker's read tool: one count per source under its business, never added up.
  tool('get_data_quality', { period }, ({ period: p }) =>
    fromData(deps, async (data, asOf) => {
      const r = await divisionRead(data, 'hq', p, asOf);
      const dq = r.metrics.filter((m) => /\.dq\.rejected_/.test(m.id));
      return { period: p, view: r.view, queryHash: r.queryHash, rejected: Object.fromEntries(dq.map((m) => [m.id, { label: m.label, value: m.value, business: m.business, period: m.period }])) };
    }));
  tool('get_repair_tickets', { status: z.enum(['open', 'late', 'done']), limit: rowLimit }, ({ status, limit }) =>
    readRows(deps, { table: 'repairs', status }, limit));
  tool('get_supplier_invoices', { status: z.enum(['open', 'overdue', 'due_30d']), business: z.enum(['salon', 'online']).optional(), limit: rowLimit }, ({ status, business, limit }) =>
    readRows(deps, { table: 'invoices', status, ...(business ? { business } : {}) }, limit));
  tool('get_waiting_conversations', { olderThanHours: z.number().min(0).max(720).optional(), limit: rowLimit }, ({ olderThanHours, limit }) =>
    readRows(deps, { table: 'waiting', olderThanHours: olderThanHours ?? 0 }, limit));
  tool('get_low_stock_interest', { limit: rowLimit }, ({ limit }) =>
    readRows(deps, { table: 'low_stock' }, limit));
  tool('get_marketplace_stock', { status: z.enum(['all', 'low']).optional(), marketplace: z.enum(['amazon', 'walmart']).optional(), limit: rowLimit }, ({ status, marketplace, limit }) =>
    readRows(deps, { table: 'marketplace_stock', status: status ?? 'all', ...(marketplace ? { marketplace } : {}) }, limit));
  tool('get_product_performance', { period, sort: z.enum(['best', 'worst']).optional(), limit: rowLimit }, ({ period: p, sort, limit }) =>
    readRows(deps, { table: 'products', period: p, sort: sort ?? 'best' }, limit));
  tool('get_return_cases', { period, limit: rowLimit }, ({ period: p, limit }) =>
    readRows(deps, { table: 'return_cases', period: p }, limit));
  tool('get_store_journey', { period, limit: rowLimit }, ({ period: p, limit }) =>
    readRows(deps, { table: 'journey', period: p }, limit));
}

// ---- The one write: the end-of-work report -----------------------------------------------------------

const reportItem = (max: number) => z.string().trim().min(1).max(max);
const reportInput = {
  summary: reportItem(2000).describe('What you did and how it ended, in a few sentences.'),
  steps: z.array(reportItem(80)).max(30).optional().describe('The main steps you took, one short line each.'),
  suggestions: z.array(reportItem(300)).max(10).optional().describe('A change you suggest to this assistant: its instructions, settings or data.'),
  lessons: z.array(reportItem(300)).max(10).optional().describe('Something you learned that the next session should know.'),
};

const WORK_REPORT_DESCRIPTION =
  'File your end-of-work report with the HQ Manager. Call it once when the work is done, with a short summary, the steps you took, any change you suggest and any lesson worth keeping. The HQ Manager reads it and decides what changes; this changes nothing else. Phone numbers and six-digit codes are masked before anything is stored, so leave them out.';

/**
 * `file_work_report`: the only tool at a door that writes, and it writes one report row for the assistant the
 * door belongs to. The report is checked here (shape, size) so the tool can say what is wrong; the database
 * checks again and masks phone numbers and codes. A retry of the same report is stored once (the reporter's key).
 */
export function registerWorkReportTool(server: McpServer, fileReport: FileReport): void {
  server.registerTool('file_work_report', { description: WORK_REPORT_DESCRIPTION, annotations: WRITES_ONE_ROW, inputSchema: reportInput }, async (input) => {
    const note = (items: string[] | undefined) => (items?.length ? items.map((text) => ({ text })) : undefined);
    const parsed = SessionReport.safeParse({
      tool: (server.server.getClientVersion()?.name ?? 'unknown tool').slice(0, 60),
      summary: input.summary,
      steps: input.steps?.length ? input.steps.map((step) => ({ step })) : undefined,
      suggestions: note(input.suggestions),
      lessons: note(input.lessons),
    });
    if (!parsed.success) return refuse(`The report is not valid: ${parsed.error.issues[0]?.message ?? 'unreadable'}.`);
    if (Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > SESSION_REPORT_MAX_BYTES) {
      return refuse(`The report is larger than ${SESSION_REPORT_MAX_BYTES / 1024} KB. Shorten the summary and the lists.`);
    }
    try {
      const filed = await fileReport(parsed.data);
      return ok({ filed: true, id: filed.id, duplicate: filed.duplicate });
    } catch (error) {
      return refuse(`The report was not filed. ${error instanceof Error ? error.message : 'Unknown error.'}`);
    }
  });
}

async function recall(deps: BrainMcpDeps, who: AssistantId, q: string, n: number | undefined) {
  const brain = await deps.openBrain();
  const decisions = brain.memory(who).recallDecisions(q, n ?? 5);
  return ok({ decisions: decisions.map((d) => ({ id: d.memory.id, text: d.memory.content, tags: d.memory.tags, relevance: Number(d.relevance.toFixed(3)) })) });
}
