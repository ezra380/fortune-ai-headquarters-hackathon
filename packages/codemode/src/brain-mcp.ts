import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AssistantId, DataPort } from '@fahq/contracts';
import type { Brain } from '@fahq/brain';

// The company brain as one MCP server: the door every AI tool (Claude, Cursor, Codex, Gemini,
// ChatGPT, staff accounts) uses to read the same facts. Reads are read-only; the only write is a
// proposal into the queue, which a person must approve before anything consequential happens.

export type BrainMcpDeps = {
  /** Lane B's Zetaris adapter; null until connected, and the tool says so plainly. */
  data: DataPort | null;
  /** Opens a fresh read view of the brain (the worker is the only writer). */
  openBrain: () => Promise<Brain>;
  /** Queues a request for an assistant; omitted = the tool is not offered. */
  propose?: (input: { assistant: AssistantId; text: string; by: string }) => Promise<{ taskId: string }>;
  now: () => Date;
};

const assistant = z.enum(['owner', 'finance', 'salon', 'online']);

const ok = (data: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  structuredContent: data,
});
const refuse = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

export function createBrainMcpServer(deps: BrainMcpDeps): McpServer {
  const server = new McpServer({ name: 'fortune-brain', version: '0.1.0' });

  server.registerTool(
    'get_finance_metrics',
    {
      description:
        'Salon and online finance metrics for one period, read through Zetaris (read-only). Salon and online stay separate; combined totals are labeled "combined". Every metric carries the query hash it came from.',
      inputSchema: { period: z.enum(['2026-09', '2026-10-mtd']) },
    },
    async ({ period }) => {
      if (!deps.data) return refuse('Business data is not connected yet (packages/data).');
      try {
        const r = await deps.data.getFinanceMetrics({ asOf: deps.now().toISOString(), period });
        return ok({
          view: r.view,
          queryHash: r.queryHash,
          metrics: r.metrics.map((m) => ({ id: m.id, label: m.label, value: m.value, unit: m.unit, business: m.business, period: m.period })),
        });
      } catch (error) {
        return refuse(`Business data could not be read: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    },
  );

  server.registerTool(
    'recall_decisions',
    {
      description: "What people approved or declined before, from one assistant's memory. Returns decisions only, never unapproved ideas.",
      inputSchema: { assistant, query: z.string().min(2).max(300), limit: z.number().int().min(1).max(10).optional() },
    },
    async ({ assistant: who, query, limit }) => {
      const brain = await deps.openBrain();
      const decisions = brain.memory(who).recallDecisions(query, limit ?? 5);
      return ok({ decisions: decisions.map((d) => ({ id: d.memory.id, text: d.memory.content, tags: d.memory.tags, score: Number(d.score.toFixed(3)) })) });
    },
  );

  server.registerTool(
    'get_timeline',
    {
      description: 'The latest events in the shared record: who asked, which assistant proposed, which numbers were cited, who decided.',
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ limit }) => {
      const brain = await deps.openBrain();
      return ok({ events: brain.record.timeline(limit ?? 25).map((e) => ({ id: e.id, type: e.type, at: e.at ?? null })) });
    },
  );

  if (deps.propose) {
    const propose = deps.propose;
    server.registerTool(
      'propose_task',
      {
        description: 'Queue a request for an assistant. This only proposes: a person approves anything that touches money, customers or ads.',
        inputSchema: { assistant, text: z.string().min(3).max(1000), by: z.string().min(2).max(80) },
      },
      async (input) => ok(await propose(input)),
    );
  }

  return server;
}
