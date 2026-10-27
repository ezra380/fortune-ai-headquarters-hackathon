import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AssistantId, SESSION_REPORT_MAX_BYTES, SessionReport, type DataPort } from '@fahq/contracts';
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

const period = z.enum(['2026-09', '2026-10-mtd']);
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

async function readMetrics(deps: BrainMcpDeps, forPeriod: z.infer<typeof period>, only?: 'online') {
  if (!deps.data) return refuse('Business data is not connected yet (packages/data).');
  try {
    const r = await deps.data.getFinanceMetrics({ asOf: deps.now().toISOString(), period: forPeriod });
    return ok({
      view: r.view,
      queryHash: r.queryHash,
      metrics: r.metrics
        .filter((m) => !only || m.business === only)
        .map((m) => ({ id: m.id, label: m.label, value: m.value, unit: m.unit, business: m.business, period: m.period })),
    });
  } catch (error) {
    return refuse(`Business data could not be read: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

// The reads this door can serve today. The rest of a profile's reads (lessons, work reports, usage,
// open items, the latest proposal) are served inside the worker only.
const DOOR_READS: readonly ReadToolName[] = ['get_finance_metrics', 'get_online_metrics', 'recall_decisions', 'recall_my_decisions', 'get_timeline'];

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

  if (may('get_finance_metrics')) {
    server.registerTool(
      'get_finance_metrics',
      {
        description: words.get_finance_metrics,
        inputSchema: { period },
      },
      ({ period: p }) => readMetrics(deps, p),
    );
  }

  if (may('get_online_metrics')) {
    server.registerTool(
      'get_online_metrics',
      {
        description: words.get_online_metrics,
        inputSchema: { period },
      },
      ({ period: p }) => readMetrics(deps, p, 'online'),
    );
  }

  if (may('recall_decisions')) {
    server.registerTool(
      'recall_decisions',
      {
        description: words.recall_decisions,
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

  if (deps.fileReport) registerWorkReportTool(server, deps.fileReport);

  return server;
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
  server.registerTool('file_work_report', { description: WORK_REPORT_DESCRIPTION, inputSchema: reportInput }, async (input) => {
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
