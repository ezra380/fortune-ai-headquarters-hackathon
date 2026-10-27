import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AssistantId, DEFAULT_PERIODS, type DataPort, type Period } from '@fahq/contracts';
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

async function readMetrics(deps: BrainMcpDeps, forPeriod: Period, only?: 'online') {
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
      ({ period: p }) => readMetrics(deps, p),
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

async function recall(deps: BrainMcpDeps, who: AssistantId, q: string, n: number | undefined) {
  const brain = await deps.openBrain();
  const decisions = brain.memory(who).recallDecisions(q, n ?? 5);
  return ok({ decisions: decisions.map((d) => ({ id: d.memory.id, text: d.memory.content, tags: d.memory.tags, relevance: Number(d.relevance.toFixed(3)) })) });
}
