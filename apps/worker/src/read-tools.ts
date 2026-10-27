import { z } from 'zod';
import { AssistantId, type DataPort, type ReadTool } from '@fahq/contracts';
import type { Brain } from '@fahq/brain';
import { explainProposal } from './explain.ts';
import { summarizeUsage } from './reports.ts';
import type { Store } from './store.ts';

// The read-only functions an assistant's Code Mode script may call as codemode.<name>(args). Writes are
// never tools: proposals, reports and reviews are fixed code paths in the worker. Each tool validates
// its own arguments (a bad call throws a plain sentence the sandbox shows the script), clamps its row
// limits, and never returns phone numbers, codes, code hashes or message bodies (only plan titles).

export type ReadToolContext = {
  store: Pick<Store, 'workReports' | 'adoptedLessons' | 'openItems' | 'latestProposal' | 'latestFinalProposal' | 'proposalByPrefix' | 'approvalsOf'>;
  brain: Pick<Brain, 'record' | 'memory'>;
  data: DataPort | null;
  now: () => Date;
};

const MAX_ROWS = 50;
const MAX_HOURS = 24 * 30;
const HOUR_MS = 3_600_000;

const Period = z.enum(['2026-09', '2026-10-mtd']);
const Limit = z.number().min(1).optional();
const Query = z.string().min(1).max(200);
const Hours = z.number().positive();
// A proposal's id, or the first characters of it (a uuid: hex digits and dashes).
const ProposalRef = z.string().regex(/^[0-9a-fA-F-]{8,36}$/, 'must be a proposal id or its first 8 characters');

const clampRows = (limit: number | undefined, fallback: number) => Math.min(MAX_ROWS, Math.max(1, Math.floor(limit ?? fallback)));
const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

/** Plain words for a failed argument check: which argument, and what is wrong with it. */
function plainIssues(error: z.ZodError): string {
  return error.issues.slice(0, 3).map((i) => {
    const where = i.path.length > 0 ? `argument "${i.path.join('.')}"` : 'the arguments';
    if (i.code === 'unrecognized_keys') return `${where} has a name this function does not take (${i.keys.map((k) => `"${k}"`).join(', ')})`;
    return `${where}: ${i.message}`;
  }).join('; ');
}

// A phone number or a one-time code must never reach a script, whatever text it was found in.
function scrub(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/\+1\d{10}\b/g, '[phone]')
      .replace(/(\b(?:SEND|CONFIRM|DECLINE|ADOPT|code)\b[^\n]{0,14}?)\b\d{6}\b/gi, '$1••••••');
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
  return value;
}

function tool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  signature: string;
  schema: S;
  run: (args: z.infer<S>) => Promise<unknown>;
}): ReadTool {
  return {
    name: def.name,
    description: def.description,
    signature: def.signature,
    run: async (raw) => {
      const parsed = def.schema.safeParse(raw === undefined || raw === null ? {} : raw);
      if (!parsed.success) throw new Error(`${def.name}: ${plainIssues(parsed.error)}.`);
      return scrub(await def.run(parsed.data));
    },
  };
}

const Metrics = '{ view: string; queryHash: string; metrics: { id: string; label: string; value: number; unit: "usd" | "count" | "ratio" | "percent"; business: "salon" | "online" | "combined" }[] }';
const Suggestion = '{ kind: string; about: string; text: string }';
const Explained = '{ proposal: { id: string; createdAt: string; from: string; requestText: string; view: string; queryHash: string; pickedBy: "model" | "rule" | null; failedDepartments: string[] } | null; plans: { rank: number; title: string; department: string; originalRank: number; why: string | null; cites: string[] }[]; cited: { id: string; label: string; value: number; unit: string; business: string }[]; approvals: { action: string; status: string; planRank: number | null; decidedAt: string | null }[]; decisions: { by: string; action: string; planRank: number | null; at: string }[]; record: { askedBy: string | null; request: { text: string; from: string; at: string } | null; cites: string[] } | null; notes: string[] }';

export function createReadTools(ctx: ReadToolContext, caller: AssistantId): Record<string, ReadTool> {
  const financeMetrics = async (period: z.infer<typeof Period>, only?: 'online' | 'salon') => {
    if (!ctx.data) throw new Error('Business data is not connected, so there are no metrics to read.');
    const { metrics, queryHash, view } = await ctx.data.getFinanceMetrics({ asOf: ctx.now().toISOString(), period });
    return {
      view,
      queryHash,
      metrics: metrics.filter((m) => !only || m.business === only).map((m) => ({ id: m.id, label: m.label, value: m.value, unit: m.unit, business: m.business })),
    };
  };
  // The exact ids a script can look up, so it never guesses at a label ("Google Ads Spend" matched nothing).
  const metricIds = (only?: 'online' | 'salon') => {
    const listed = (ctx.data?.catalog ?? []).filter((m) => !only || m.business === only);
    return listed.length === 0 ? '' : ` Metric ids: ${listed.map((m) => `${m.id} (${m.label}, ${m.unit})`).join('; ')}.`;
  };
  const decisions = (assistant: AssistantId, query: string, limit: number | undefined) => ({
    decisions: ctx.brain.memory(assistant).recallDecisions(query, clampRows(limit, 5)).map((d) => ({
      id: d.memory.id, text: d.memory.content, relevance: round(d.relevance, 2),
    })),
  });
  const since = (hours: number) => new Date(ctx.now().getTime() - Math.min(hours, MAX_HOURS) * HOUR_MS);

  const tools: ReadTool[] = [
    tool({
      name: 'get_finance_metrics',
      description: `Salon, online and combined business metrics for a period, read from Zetaris. Each metric keeps its business label.${metricIds()}`,
      signature: `(args: { period: "2026-09" | "2026-10-mtd" }) => Promise<${Metrics}>`,
      schema: z.object({ period: Period }).strict(),
      run: ({ period }) => financeMetrics(period),
    }),
    tool({
      name: 'get_online_metrics',
      description: `Only the online store metrics for a period, read from Zetaris.${metricIds('online')}`,
      signature: `(args: { period: "2026-09" | "2026-10-mtd" }) => Promise<${Metrics}>`,
      schema: z.object({ period: Period }).strict(),
      run: ({ period }) => financeMetrics(period, 'online'),
    }),
    tool({
      name: 'get_salon_metrics',
      description: `Only the salon metrics for a period, read from Zetaris (synthetic data here, standing in for the head stylist's own backend).${metricIds('salon')}`,
      signature: `(args: { period: "2026-09" | "2026-10-mtd" }) => Promise<${Metrics}>`,
      schema: z.object({ period: Period }).strict(),
      run: ({ period }) => financeMetrics(period, 'salon'),
    }),
    tool({
      name: 'recall_my_decisions',
      description: "Decisions people approved or declined that are in YOUR OWN memory, most relevant first (never another assistant's).",
      signature: '(args: { query: string; limit?: number }) => Promise<{ decisions: { id: string; text: string; relevance: number }[] }>',
      schema: z.object({ query: Query, limit: Limit }).strict(),
      run: async ({ query, limit }) => decisions(caller, query, limit),
    }),
    tool({
      name: 'recall_decisions',
      description: "Decisions in any one assistant's memory, most relevant first.",
      signature: '(args: { assistant: "owner" | "finance" | "salon" | "online" | "manager"; query: string; limit?: number }) => Promise<{ decisions: { id: string; text: string; relevance: number }[] }>',
      schema: z.object({ assistant: AssistantId, query: Query, limit: Limit }).strict(),
      run: async ({ assistant, query, limit }) => decisions(assistant, query, limit),
    }),
    tool({
      name: 'my_lessons',
      description: 'The standing lessons the owner adopted for YOU, from your own memory, newest first.',
      signature: '(args: {}) => Promise<{ lessons: { text: string }[] }>',
      schema: z.object({}).strict(),
      run: async () => ({ lessons: ctx.brain.memory(caller).lessons(MAX_ROWS).map((m) => ({ text: m.content })) }),
    }),
    tool({
      name: 'list_lessons',
      description: 'Adopted recommendations (standing lessons) from the database, newest first; one assistant or all.',
      signature: '(args: { assistant?: "owner" | "finance" | "salon" | "online" | "manager" }) => Promise<{ lessons: { assistant: string; text: string; adoptedAt: string }[] }>',
      schema: z.object({ assistant: AssistantId.optional() }).strict(),
      run: async ({ assistant }) => ({
        lessons: (await ctx.store.adoptedLessons(assistant, MAX_ROWS)).map((l) => ({
          assistant: l.assistant_id, text: l.change, adoptedAt: new Date(l.decided_at).toISOString(),
        })),
      }),
    }),
    tool({
      name: 'get_timeline',
      description: 'The newest events in the shared record (id, type, time), oldest first.',
      signature: '(args: { limit?: number }) => Promise<{ events: { id: string; type: string; at: string }[] }>',
      schema: z.object({ limit: Limit }).strict(),
      run: async ({ limit }) => ({ events: ctx.brain.record.timeline(clampRows(limit, 20)).map((e) => ({ id: e.id, type: e.type, at: e.at })) }),
    }),
    tool({
      name: 'list_work_reports',
      description: "End-of-work reports of finished tasks in the last N hours, newest first: outcome, model calls, tokens, seconds and the program's suggestions. No message text.",
      signature: `(args: { sinceHours: number; assistant?: "owner" | "finance" | "salon" | "online" | "manager"; limit?: number }) => Promise<{ reports: { task: string; assistant: string; kind: string; outcome: "done" | "failed" | "retrying"; summary: string; modelCalls: number; inputTokens: number; outputTokens: number; seconds: number; suggestions: ${Suggestion}[] }[] }>`,
      schema: z.object({ sinceHours: Hours, assistant: AssistantId.optional(), limit: Limit }).strict(),
      run: async ({ sinceHours, assistant, limit }) => ({
        reports: (await ctx.store.workReports({ since: since(sinceHours), assistant, limit: clampRows(limit, 25) })).map((r) => ({
          task: r.task_id.slice(0, 8),
          assistant: r.assistant_id,
          kind: r.task_kind,
          outcome: r.outcome,
          summary: r.summary,
          modelCalls: r.model_calls,
          inputTokens: r.input_tokens,
          outputTokens: r.output_tokens,
          seconds: round((Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000, 1),
          suggestions: r.suggestions.map((s) => ({ kind: s.kind, about: s.about, text: s.text })),
        })),
      }),
    }),
    tool({
      name: 'usage_summary',
      description: 'Tasks, outcomes, model calls, tokens in and out, and average seconds per assistant over the last N hours (the newest 200 reports; truncated says whether that cap was hit).',
      signature: '(args: { sinceHours: number }) => Promise<{ since: string; truncated: boolean; byAssistant: { assistant: string; tasks: number; done: number; failed: number; retrying: number; modelCalls: number; inputTokens: number; outputTokens: number; avgSeconds: number }[]; totals: { tasks: number; done: number; failed: number; retrying: number; modelCalls: number; inputTokens: number; outputTokens: number; avgSeconds: number } }>',
      schema: z.object({ sinceHours: Hours }).strict(),
      run: async ({ sinceHours }) => {
        const from = since(sinceHours);
        const rows = await ctx.store.workReports({ since: from, limit: 200 });
        return { ...summarizeUsage(rows, from), truncated: rows.length >= 200 };
      },
    }),
    tool({
      name: 'open_items',
      description: 'Open tasks and unexpired pending approvals per assistant: counts only.',
      signature: '(args: {}) => Promise<{ byAssistant: { assistant: string; openTasks: number; pendingApprovals: number }[] }>',
      schema: z.object({}).strict(),
      run: async () => ({ byAssistant: await ctx.store.openItems(ctx.now()) }),
    }),
    tool({
      name: 'latest_proposal',
      description: 'The newest set of plans the owner sees: its short id, when it was made, the plan titles, the metric ids it cited, and whether a decision was recorded. No plan text beyond titles.',
      signature: '(args: {}) => Promise<{ proposal: { id: string; createdAt: string; titles: string[]; citedMetricIds: string[]; decided: boolean } | null }>',
      schema: z.object({}).strict(),
      run: async () => ({ proposal: await ctx.store.latestProposal() }),
    }),
    tool({
      name: 'explain_proposal',
      description: 'Why a proposal exists: the request and who asked it, which department each plan came from and why it was picked, the metrics it cited (value, unit, Zetaris view and query hash), the approvals on it (status only, never a code) and who decided. Default: the newest set of plans.',
      signature: `(args: { proposal?: string }) => Promise<${Explained}>`,
      schema: z.object({ proposal: ProposalRef.optional() }).strict(),
      run: ({ proposal }) => explainProposal(ctx, proposal),
    }),
  ];
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

/** The tools an assistant's profile allows. A name that does not exist is an error, never silently dropped. */
export function pick(tools: Record<string, ReadTool>, names: readonly string[]): ReadTool[] {
  return names.map((name) => {
    const found = tools[name];
    if (!found) throw new Error(`Unknown read tool "${name}". The tools are: ${Object.keys(tools).join(', ')}.`);
    return found;
  });
}
