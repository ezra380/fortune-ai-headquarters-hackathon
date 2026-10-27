import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { AssistantId, PERIOD_KEYS, type DataPort, type Metric } from '@fahq/contracts';
import type { Brain } from '@fahq/brain';
import { READ_TOOL_NAMES, doorSkill, loadProfiles } from '@fahq/profiles';
import { createBrainMcpServer, createCodeModeBrainServer, doorReads, doorTools, type BrainMcpDeps, type DoorProfileArg } from '../src/index.ts';

// The doors with MOCK data and a MOCK brain: this file tests which tools each profile's door offers
// and what it serves, not Zetaris or Meterless.

const profiles = loadProfiles({});
const source = { system: 'zetaris' as const, view: 'fortune_demo.finance_mart', queryHash: 'b'.repeat(64), asOf: '2026-10-26T12:00:00Z' };
const metric = (id: string, business: Metric['business'], value: number): Metric => ({ id: id as Metric['id'], label: id, value, unit: 'usd', business, period: '2026-09', source });
const allMetrics = [metric('m:online.revenue.mazali', 'online', 12400), metric('m:salon.revenue.wash_set', 'salon', 6200), metric('m:combined.revenue.total', 'combined', 18600)];

function makeDeps(extra: Partial<BrainMcpDeps> = {}) {
  const recalled: string[] = [];
  const data: DataPort = { health: async () => ({ ok: true, detail: 'mock' }), getFinanceMetrics: async () => ({ metrics: allMetrics, queryHash: source.queryHash, view: source.view }) };
  const brain = {
    memory: (who: string) => ({ recallDecisions: (q: string) => { recalled.push(`${who}:${q}`); return [{ memory: { id: `mem-${who}`, content: `Decision by ${who}`, tags: ['decision'] }, relevance: 0.5 }]; } }),
    record: { timeline: () => [{ id: 'e1', type: 'request', at: '2026-10-26T12:00:00Z' }] },
  } as unknown as Brain;
  const deps: BrainMcpDeps = { data, openBrain: async () => brain, now: () => new Date('2026-10-26T12:00:00Z'), ...extra };
  return { deps, recalled };
}

/** A FAKE version 2 port: division reads, row reads (30 rows each) and series, recording what it was asked. */
const V2_ATTENTION = [
  { metricId: 'm:online.budget.google.used', level: 'act' as const, rule: 'Ad spend went over the approved budget.' },
  { metricId: 'm:salon.ap.overdue.count', level: 'act' as const, rule: 'Supplier invoices are overdue.' },
];
function v2Port() {
  const asked: unknown[] = [];
  const v2 = (id: string, business: Metric['business'], value: number): Metric => ({ ...metric(id, business, value), period: '2026-10-mtd' });
  const byDivision: Record<string, Metric[]> = {
    finance: [
      v2('m:online.budget.google.cap', 'online', 2000), v2('m:online.budget.google.room', 'online', -100), v2('m:online.ads.google.spend', 'online', 2100),
      v2('m:online.ads.total.spend', 'online', 2900), v2('m:online.season.last_year_index', 'online', 1.35), v2('m:online.revenue.total', 'online', 15000), v2('m:salon.ap.overdue', 'salon', 800),
    ],
    hq: [v2('m:salon.revenue.total', 'salon', 9000), v2('m:salon.dq.rejected_repairs', 'salon', 1), v2('m:online.dq.rejected_orders', 'online', 2), v2('m:combined.dq.rejected_invoices', 'combined', 1)],
  };
  const data: DataPort = {
    ...makeDeps().deps.data!, periods: PERIOD_KEYS,
    getDivisionMetrics: async ({ division, period }) => {
      asked.push({ division, period });
      return { division, metrics: byDivision[division] ?? [], attention: division === 'finance' ? V2_ATTENTION : [], queryHash: source.queryHash, view: `fortune_demo_v2_${division}_mart` };
    },
    readRows: async ({ asOf: _a, ...read }) => { asked.push(read); return { table: read.table, rows: Array.from({ length: 30 }, (_, i) => ({ n: i })), totals: { count: 30 }, dataDate: '2026-10-26', queryHash: source.queryHash, view: 'v' }; },
  };
  return { data, asked };
}

async function connect(server: McpServer) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.1' });
  await client.connect(clientSide);
  return client;
}

/** What the `skill` prompt of a door should say: the profile's skill for exactly the tools that door offers. */
function expectedSkill(arg: DoorProfileArg, canReport: boolean) {
  const profile = typeof arg === 'string' ? profiles[arg] : arg;
  return doorSkill(profile, { tools: doorTools(profile), canReport, readNames: READ_TOOL_NAMES });
}
const promptText = async (c: Client) => ((await c.getPrompt({ name: 'skill' })).messages[0]!.content as { text: string }).text;
const namedReads = (t: string) => new Set([...t.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!).filter((n) => (READ_TOOL_NAMES as readonly string[]).includes(n)));
const filed = () => vi.fn(async () => ({ id: '0c1f6f0e-6f0e-4c1f-8f0e-0c1f6f0e0c1f', duplicate: false }));

// A client lists tools only when the server advertises them; a door with nothing to offer does not.
const toolNames = async (c: Client) => (c.getServerCapabilities()?.tools ? (await c.listTools()).tools.map((t) => t.name).sort() : []);
const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? '');

describe('profile doors (plain tools)', () => {
  it('offers each profile only the tools it may read', async () => {
    const expected: Record<AssistantId, string[]> = {
      owner: [
        'get_budget_room', 'get_company_overview', 'get_finance_metrics', 'get_marketplace_stock', 'get_metric_series', 'get_product_performance', 'get_repair_tickets',
        'get_return_cases', 'get_store_journey', 'get_supplier_invoices', 'get_timeline', 'get_waiting_conversations', 'recall_decisions',
      ],
      finance: ['get_budget_room', 'get_finance_metrics', 'get_marketplace_stock', 'get_metric_series', 'get_supplier_invoices', 'recall_my_decisions'],
      online: [
        'get_low_stock_interest', 'get_metric_series', 'get_online_metrics', 'get_product_performance', 'get_return_cases', 'get_store_journey', 'get_waiting_conversations',
        'recall_my_decisions',
      ],
      salon: ['get_metric_series', 'get_repair_tickets', 'get_salon_metrics', 'recall_my_decisions'],
      manager: ['get_data_quality', 'get_timeline', 'recall_decisions'],
      legal: ['recall_my_decisions'],
    };
    for (const id of AssistantId.options) {
      const client = await connect(createBrainMcpServer(makeDeps().deps, id));
      expect(await toolNames(client), id).toEqual(expected[id]);
      // Every tool a door offers is one the profile lists.
      const reads = new Set<string>(profiles[id].reads);
      for (const name of await toolNames(client)) expect(reads.has(name), `${id} offers ${name}`).toBe(true);
      await client.close();
    }
  });

  it('keeps the finance door away from the timeline and the manager door away from the numbers', async () => {
    const finance = await connect(createBrainMcpServer(makeDeps().deps, 'finance'));
    expect(await toolNames(finance)).not.toContain('get_timeline');
    expect(await toolNames(finance)).not.toContain('recall_decisions'); // it reads only its own memory
    const manager = await connect(createBrainMcpServer(makeDeps().deps, 'manager'));
    const names = await toolNames(manager);
    expect(names).not.toContain('get_finance_metrics');
    expect(names).not.toContain('get_online_metrics');
    await finance.close();
    await manager.close();
  });

  it('defaults to the owner door', async () => {
    const client = await connect(createBrainMcpServer(makeDeps().deps));
    expect(await toolNames(client)).toEqual(await toolNames(await connect(createBrainMcpServer(makeDeps().deps, 'owner'))));
    expect(await toolNames(client)).toContain('get_company_overview');
    await client.close();
  });

  it('gives the salon door salon numbers only', async () => {
    const client = await connect(createBrainMcpServer(makeDeps().deps, 'salon'));
    const r = JSON.parse(text(await client.callTool({ name: 'get_salon_metrics', arguments: { period: '2026-09' } }))) as { metrics: { id: string; business: string }[] };
    expect(r.metrics.map((m) => m.id)).toEqual(['m:salon.revenue.wash_set']);
    await client.close();
  });

  it('serves the division data from a version 2 port: side by side, rows with their totals, a series only of its own ids', async () => {
    const hq = [metric('m:salon.revenue.total', 'salon', 9000), metric('m:online.revenue.total', 'online', 15000), metric('m:salon.dq.rejected_repairs', 'salon', 1)];
    const asked: unknown[] = [];
    const data: DataPort = {
      ...makeDeps().deps.data!, periods: PERIOD_KEYS,
      catalog: [{ id: 'm:salon.revenue.total', label: 'x', unit: 'usd', business: 'salon', divisions: ['salon', 'finance', 'hq'] }],
      getDivisionMetrics: async ({ division }) => ({ division, metrics: hq, attention: [], queryHash: source.queryHash, view: `fortune_demo_v2_${division}_mart` }),
      readRows: async ({ asOf: _a, ...read }) => { asked.push(read); return { table: read.table, rows: Array.from({ length: 30 }, (_, i) => ({ n: i })), totals: { count: 30 }, dataDate: '2026-10-26', queryHash: source.queryHash, view: 'v' }; },
      getMetricSeries: async (q) => { asked.push(q.division); return { metricId: q.metricId, label: 'x', unit: 'usd', business: 'salon', points: [], stats: { min: 0, max: 0, mean12: null }, queryHash: source.queryHash, view: 'v' }; },
    };
    const owner = await connect(createBrainMcpServer({ ...makeDeps().deps, data }, 'owner'));
    const overview = JSON.parse(text(await owner.callTool({ name: 'get_company_overview', arguments: { period: '2026-10-mtd' } }))) as Record<string, { id: string }[]> & { normal: boolean };
    expect(overview.salon!.map((m) => m.id)).toEqual(['m:salon.revenue.total', 'm:salon.dq.rejected_repairs']);
    expect(overview.online!.map((m) => m.id)).toEqual(['m:online.revenue.total']);
    expect(overview.normal).toBe(true);
    const tickets = JSON.parse(text(await owner.callTool({ name: 'get_repair_tickets', arguments: { status: 'late', limit: 5 } }))) as { rows: unknown[]; totals: { count: number } };
    expect(tickets.rows).toHaveLength(5);
    expect(tickets.totals.count).toBe(30);
    await owner.callTool({ name: 'get_metric_series', arguments: { metricId: 'm:salon.revenue.total' } });
    expect(asked).toEqual([{ table: 'repairs', status: 'late' }, 'finance']);
    await owner.close();
    const online = await connect(createBrainMcpServer({ ...makeDeps().deps, data }, 'online'));
    const refused = await online.callTool({ name: 'get_metric_series', arguments: { metricId: 'm:salon.revenue.total' } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('not one of the metrics your division reads');
    await online.close();
    // A version 1 port has no division reads: a plain refusal, never a guess.
    const v1 = await connect(createBrainMcpServer(makeDeps().deps, 'finance'));
    const budget = await v1.callTool({ name: 'get_budget_room', arguments: { period: '2026-09' } });
    expect(budget.isError).toBe(true);
    expect(text(budget)).toContain('no finance division read (it needs data version 2)');
    await v1.close();
  });

  it('serves the budget room from the finance read: only the budget sheet, ad spend and the index, and only the budget attention', async () => {
    const { data, asked } = v2Port();
    const finance = await connect(createBrainMcpServer({ ...makeDeps().deps, data }, 'finance'));
    const room = JSON.parse(text(await finance.callTool({ name: 'get_budget_room', arguments: { period: '2026-10-mtd' } }))) as { metrics: { id: string }[]; attention: unknown[] };
    expect(asked).toEqual([{ division: 'finance', period: '2026-10-mtd' }]);
    expect(room.metrics.map((m) => m.id)).toEqual(['m:online.budget.google.cap', 'm:online.budget.google.room', 'm:online.ads.google.spend', 'm:online.ads.total.spend', 'm:online.season.last_year_index']);
    expect(room.attention).toEqual([V2_ATTENTION[0]]);
    await finance.close();
  });

  it("lists the rejected rows per source under its business, the worker's shape, and adds nothing up", async () => {
    const manager = await connect(createBrainMcpServer({ ...makeDeps().deps, data: v2Port().data }, 'manager'));
    const dq = JSON.parse(text(await manager.callTool({ name: 'get_data_quality', arguments: { period: '2026-10-mtd' } })));
    expect(dq).toEqual({
      period: '2026-10-mtd', view: 'fortune_demo_v2_hq_mart', queryHash: source.queryHash,
      rejected: {
        'm:salon.dq.rejected_repairs': { label: 'm:salon.dq.rejected_repairs', value: 1, business: 'salon', period: '2026-10-mtd' },
        'm:online.dq.rejected_orders': { label: 'm:online.dq.rejected_orders', value: 2, business: 'online', period: '2026-10-mtd' },
        'm:combined.dq.rejected_invoices': { label: 'm:combined.dq.rejected_invoices', value: 1, business: 'combined', period: '2026-10-mtd' },
      },
    });
    await manager.close();
  });

  it('passes each row read on as asked: the invoices of one business or both, the waiting messages, the low stock', async () => {
    const { data, asked } = v2Port();
    const finance = await connect(createBrainMcpServer({ ...makeDeps().deps, data }, 'finance'));
    await finance.callTool({ name: 'get_supplier_invoices', arguments: { status: 'overdue', business: 'online' } });
    await finance.callTool({ name: 'get_supplier_invoices', arguments: { status: 'due_30d' } });
    const bad = await finance.callTool({ name: 'get_supplier_invoices', arguments: { status: 'open', business: 'combined' } });
    expect(bad.isError).toBe(true);
    await finance.callTool({ name: 'get_marketplace_stock', arguments: { status: 'low', marketplace: 'amazon' } });
    expect((await finance.callTool({ name: 'get_marketplace_stock', arguments: { marketplace: 'ebay' } })).isError).toBe(true);
    await finance.close();
    const online = await connect(createBrainMcpServer({ ...makeDeps().deps, data }, 'online'));
    await online.callTool({ name: 'get_waiting_conversations', arguments: {} });
    await online.callTool({ name: 'get_waiting_conversations', arguments: { olderThanHours: 24 } });
    const stock = JSON.parse(text(await online.callTool({ name: 'get_low_stock_interest', arguments: { limit: 2 } }))) as { rows: unknown[]; totals: { count: number } };
    expect(stock.rows).toHaveLength(2);
    expect(stock.totals.count).toBe(30);
    await online.callTool({ name: 'get_product_performance', arguments: { period: '2026-09', sort: 'worst' } });
    await online.callTool({ name: 'get_return_cases', arguments: { period: '2026-10-mtd' } });
    expect((await online.callTool({ name: 'get_return_cases', arguments: { period: '2027-01' } })).isError).toBe(true);
    await online.callTool({ name: 'get_store_journey', arguments: { period: '2026-09' } });
    await online.close();
    expect(asked).toEqual([
      { table: 'invoices', status: 'overdue', business: 'online' }, { table: 'invoices', status: 'due_30d' }, { table: 'marketplace_stock', status: 'low', marketplace: 'amazon' },
      { table: 'waiting', olderThanHours: 0 }, { table: 'waiting', olderThanHours: 24 }, { table: 'low_stock' }, { table: 'products', period: '2026-09', sort: 'worst' },
      { table: 'return_cases', period: '2026-10-mtd' }, { table: 'journey', period: '2026-09' },
    ]);
  });

  // Review 2026-10-27: the door returned the provider's error text (up to 400 characters of an HTTP body).
  it("keeps the provider's text out of the answer: a fixed sentence with a code, the detail in the server log", async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing: DataPort = {
      ...v2Port().data,
      getDivisionMetrics: async () => { throw new Error('HTTP 500: AnalysisException near SELECT * FROM fortune_hq_v2.salon_metrics on zetaris-node-7.internal:18121 for demo@example.com'); },
      readRows: async () => { throw new Error('HTTP 500: SELECT ticket_id FROM fortune_demo_salon.repair_tickets at zetaris-node-7.internal'); },
    };
    const owner = await connect(createBrainMcpServer({ ...makeDeps().deps, data: failing }, 'owner'));
    for (const [name, args] of [['get_company_overview', { period: '2026-09' }], ['get_finance_metrics', { period: '2026-09' }], ['get_repair_tickets', { status: 'open' }]] as const) {
      const r = await owner.callTool({ name, arguments: args });
      expect(r.isError, name).toBe(true);
      expect(text(r), name).toBe('Business data could not be read (ZETARIS_READ).');
    }
    await owner.close();
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual(expect.arrayContaining([expect.stringMatching(/^fortune-brain\.zetaris_read_failed Error: HTTP 500: AnalysisException/)]));
    expect(log.mock.calls.join('\n')).not.toContain('demo@example.com');
    log.mockRestore();
  });

  it('serves the profile skill as the `skill` prompt on every door, naming only the tools that door offers', async () => {
    for (const id of AssistantId.options) {
      const client = await connect(createBrainMcpServer(makeDeps().deps, id));
      const { prompts } = await client.listPrompts();
      expect(prompts.map((p) => p.name), id).toEqual(['skill']);
      expect(prompts[0]!.description).toMatch(/read-only/i);
      const got = await client.getPrompt({ name: 'skill' });
      expect(got.messages).toHaveLength(1);
      const content = got.messages[0]!.content as { type: string; text: string };
      expect(content.type).toBe('text');
      expect(content.text).toBe(expectedSkill(id, false));
      expect(content.text).toContain('read-only');
      expect(content.text).toContain('## You never'); // the rules that matter come with it
      expect(namedReads(content.text), id).toEqual(new Set(await toolNames(client)));
      await client.close();
    }
  });

  it('keeps the skill and the tools in step: the skill names no tool the door lacks, and every tool the door has is named', async () => {
    // Whatever DOOR_READS holds (another lane adds to it), each read it serves has a tool, and the skill lists it.
    for (const id of AssistantId.options) {
      for (const deps of [makeDeps().deps, makeDeps({ fileReport: filed() }).deps]) {
        const client = await connect(createBrainMcpServer(deps, id));
        const tools = (await toolNames(client)).filter((n) => n !== 'file_work_report');
        expect(tools, `${id} tools`).toEqual([...doorReads(id)].sort());
        expect(namedReads(await promptText(client)), `${id} skill`).toEqual(new Set(tools));
        await client.close();
      }
    }
  });

  it('gives the online door online numbers only', async () => {
    const client = await connect(createBrainMcpServer(makeDeps().deps, 'online'));
    const r = JSON.parse(text(await client.callTool({ name: 'get_online_metrics', arguments: { period: '2026-09' } }))) as { metrics: { id: string; business: string }[] };
    expect(r.metrics.map((m) => m.id)).toEqual(['m:online.revenue.mazali']);
    expect(r.metrics.every((m) => m.business === 'online')).toBe(true);
    await client.close();
  });

  it('offers exactly the periods the data serves: the last two by default, all thirteen from a version 2 port', async () => {
    const periodsOf = async (deps: BrainMcpDeps) => {
      const client = await connect(createBrainMcpServer(deps, 'finance'));
      const tool = (await client.listTools()).tools.find((x) => x.name === 'get_finance_metrics')!;
      await client.close();
      return (tool.inputSchema.properties as { period: { enum: string[] } }).period.enum;
    };
    const { deps } = makeDeps();
    expect(await periodsOf(deps)).toEqual(['2026-09', '2026-10-mtd']);
    expect(await periodsOf({ ...deps, data: { ...deps.data!, periods: PERIOD_KEYS } })).toEqual([...PERIOD_KEYS]);
  });

  it('gives the owner and finance doors both businesses, still separate and labeled', async () => {
    const client = await connect(createBrainMcpServer(makeDeps().deps, 'finance'));
    const r = JSON.parse(text(await client.callTool({ name: 'get_finance_metrics', arguments: { period: '2026-09' } }))) as { metrics: { business: string }[] };
    expect(r.metrics.map((m) => m.business)).toEqual(['online', 'salon', 'combined']);
    await client.close();
  });

  it('binds recall_my_decisions to the profile, so a door cannot read another memory', async () => {
    const t = makeDeps();
    const client = await connect(createBrainMcpServer(t.deps, 'finance'));
    const tool = (await client.listTools()).tools.find((x) => x.name === 'recall_my_decisions')!;
    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(['query', 'limit']); // no assistant argument
    await client.callTool({ name: 'recall_my_decisions', arguments: { query: 'mazali discount', assistant: 'owner' } });
    expect(t.recalled).toEqual(['finance:mazali discount']);
    await client.close();
  });

  it('lets owner and manager recall any assistant, and says plainly when data is not connected', async () => {
    const t = makeDeps();
    const client = await connect(createBrainMcpServer(t.deps, 'manager'));
    await client.callTool({ name: 'recall_decisions', arguments: { assistant: 'finance', query: 'ads plan' } });
    expect(t.recalled).toEqual(['finance:ads plan']);
    await client.close();

    const offline = await connect(createBrainMcpServer({ ...makeDeps().deps, data: null }, 'owner'));
    const r = await offline.callTool({ name: 'get_finance_metrics', arguments: { period: '2026-09' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not connected/);
    await offline.close();
  });

  it('offers propose_task only to a profile that may propose, and only when a proposer is given', async () => {
    const propose = vi.fn(async () => ({ taskId: 'task-1' }));
    for (const id of AssistantId.options) {
      const withProposer = await connect(createBrainMcpServer(makeDeps({ propose }).deps, id));
      const mayPropose = profiles[id].writes.includes('propose');
      expect((await toolNames(withProposer)).includes('propose_task'), `${id} with a proposer`).toBe(mayPropose);
      await withProposer.close();
      const without = await connect(createBrainMcpServer(makeDeps().deps, id));
      expect(await toolNames(without), `${id} without a proposer`).not.toContain('propose_task');
      await without.close();
    }
    const manager = await connect(createBrainMcpServer(makeDeps({ propose }).deps, 'manager'));
    expect(await toolNames(manager)).not.toContain('propose_task');
    await manager.close();

    const owner = await connect(createBrainMcpServer(makeDeps({ propose }).deps, 'owner'));
    const r = await owner.callTool({ name: 'propose_task', arguments: { assistant: 'finance', text: 'Three plans please', by: 'demo owner' } });
    expect(JSON.parse(text(r))).toEqual({ taskId: 'task-1' });
    expect(propose).toHaveBeenCalledWith({ assistant: 'finance', text: 'Three plans please', by: 'demo owner' });
    await owner.close();
  });
});

describe('profile doors (Code Mode)', () => {
  it('shows one code tool whose API lists only the profile reads, plus the skill prompt', async () => {
    const finance = await connect(await createCodeModeBrainServer(makeDeps().deps, {}, 'finance'));
    const { tools } = await finance.listTools();
    expect(tools.map((t) => t.name)).toEqual(['code']);
    expect(tools[0]!.description).toContain('get_finance_metrics');
    expect(tools[0]!.description).toContain('recall_my_decisions');
    expect(tools[0]!.description).not.toContain('get_timeline');
    expect(tools[0]!.description).not.toContain('propose_task');
    expect((await finance.listPrompts()).prompts.map((p) => p.name)).toEqual(['skill']);
    expect(await promptText(finance)).toBe(expectedSkill('finance', false));
    await finance.close();

    const manager = await connect(await createCodeModeBrainServer(makeDeps().deps, {}, 'manager'));
    const description = (await manager.listTools()).tools[0]!.description ?? '';
    expect(description).toContain('get_timeline');
    expect(description).not.toContain('get_finance_metrics');
    await manager.close();
  });

  it('gives the salon stand-in a code tool for what the door can serve, and its skill', async () => {
    const salon = await connect(await createCodeModeBrainServer(makeDeps().deps, {}, 'salon'));
    const description = (await salon.listTools()).tools[0]!.description ?? '';
    expect(description).toContain('recall_my_decisions');
    expect(description).not.toContain('get_finance_metrics');
    expect(description).not.toContain('get_online_metrics');
    expect((await salon.listPrompts()).prompts.map((p) => p.name)).toEqual(['skill']);
    expect(await promptText(salon)).toBe(expectedSkill('salon', false));
    await salon.close();
  });

  it('runs a script on a profile door, and a script cannot reach a tool that door does not offer', async () => {
    const t = makeDeps();
    const finance = await connect(await createCodeModeBrainServer(t.deps, {}, 'finance'));
    const good = await finance.callTool({ name: 'code', arguments: { code: 'async () => { const m = await codemode.get_finance_metrics({ period: "2026-09" }); return m.metrics.length; }' } });
    expect(text(good)).toBe('3');
    const bad = await finance.callTool({ name: 'code', arguments: { code: 'async () => codemode.get_timeline({})' } });
    expect(bad.isError).toBe(true);
    await finance.close();
  });
});

// ---- Doors that serve a stored profile and file reports -------------------------------------------------------

const WRITE_LOOKING = /^(propose|send|create|update|delete|set|adopt|approve|file|write|save|issue)/;
const storedProfile = (id: AssistantId, over: Partial<(typeof profiles)[AssistantId]> = {}) => ({ ...profiles[id], source: 'database' as const, version: 5, ...over });

describe('a door with a report to file (how serve.ts builds it)', () => {
  it('has no write tool but file_work_report, on every profile, plain and Code Mode', async () => {
    for (const id of AssistantId.options) {
      const deps = makeDeps({ fileReport: filed() }).deps;
      for (const client of [await connect(createBrainMcpServer(deps, id)), await connect(await createCodeModeBrainServer(deps, {}, id))]) {
        const names = await toolNames(client);
        expect(names.filter((n) => WRITE_LOOKING.test(n)), id).toEqual(['file_work_report']);
        expect(names, id).toContain('file_work_report');
        expect(names.includes('propose_task'), id).toBe(false);
        await client.close();
      }
    }
  });

  it('offers a plain door its reads and the report, and a Code Mode door `code` and the report', async () => {
    const deps = makeDeps({ fileReport: filed() }).deps;
    const plain = await connect(createBrainMcpServer(deps, 'finance'));
    expect(await toolNames(plain)).toEqual(['file_work_report', ...doorReads('finance')].sort());
    const code = await connect(await createCodeModeBrainServer(deps, {}, 'finance'));
    expect(await toolNames(code)).toEqual(['code', 'file_work_report']);
    await plain.close();
    await code.close();
  });

  it('marks every read tool read-only and the report as the one thing that writes, adding a single row', async () => {
    for (const id of AssistantId.options) {
      const client = await connect(createBrainMcpServer(makeDeps({ fileReport: filed() }).deps, id));
      for (const tool of (await client.listTools()).tools) {
        if (tool.name === 'file_work_report') {
          expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
        } else {
          expect(tool.annotations, `${id} ${tool.name}`).toMatchObject({ readOnlyHint: true, destructiveHint: false });
        }
      }
      await client.close();
    }
  });

  it('keeps the report out of the sandbox: a script cannot file one, and `code` does not offer it', async () => {
    const report = filed();
    const client = await connect(await createCodeModeBrainServer(makeDeps({ fileReport: report }).deps, {}, 'finance'));
    const description = (await client.listTools()).tools.find((t) => t.name === 'code')!.description ?? '';
    expect(description).not.toContain('file_work_report');
    const attempt = await client.callTool({ name: 'code', arguments: { code: 'async () => codemode.file_work_report({ summary: "sneaky" })' } });
    expect(attempt.isError).toBe(true);
    expect(report).not.toHaveBeenCalled();
    await client.close();
  });

  it('tells the tool to file its report only when there is somewhere to file it', async () => {
    for (const id of AssistantId.options) {
      const withReport = await connect(createBrainMcpServer(makeDeps({ fileReport: filed() }).deps, id));
      expect(await promptText(withReport), id).toBe(expectedSkill(id, true));
      expect(await promptText(withReport), id).toContain('call `file_work_report` once');
      const offline = await connect(createBrainMcpServer(makeDeps().deps, id));
      expect(await promptText(offline), id).not.toContain('file_work_report');
      await withReport.close();
      await offline.close();
    }
    const code = await connect(await createCodeModeBrainServer(makeDeps({ fileReport: filed() }).deps, {}, 'manager'));
    expect(await promptText(code)).toContain('call `file_work_report` once');
    await code.close();
  });

  it('files a report on a door whose profile has no reads at all', async () => {
    const report = filed();
    const bare = storedProfile('salon', { reads: [] });
    const client = await connect(await createCodeModeBrainServer(makeDeps({ fileReport: report }).deps, {}, bare));
    expect(await toolNames(client)).toEqual(['file_work_report']);
    const done = await client.callTool({ name: 'file_work_report', arguments: { summary: 'Looked around.' } });
    expect(done.isError).toBeFalsy();
    expect(report).toHaveBeenCalledOnce();
    await client.close();
  });
});

describe('a door that serves a stored profile', () => {
  it('offers the reads of the stored profile, not those of the file, and lists them in the skill', async () => {
    const stored = storedProfile('finance', { reads: ['recall_my_decisions'] });
    const client = await connect(createBrainMcpServer(makeDeps().deps, stored));
    expect(await toolNames(client)).toEqual(['recall_my_decisions']);
    expect(namedReads(await promptText(client))).toEqual(new Set(['recall_my_decisions']));
    await client.close();
    const code = await connect(await createCodeModeBrainServer(makeDeps().deps, {}, stored));
    const description = (await code.listTools()).tools[0]!.description ?? '';
    expect(description).toContain('recall_my_decisions');
    expect(description).not.toContain('get_finance_metrics');
    await code.close();
  });

  it('serves a read the stored profile newly lists, as far as the door can serve it', async () => {
    const stored = storedProfile('online', { reads: ['get_online_metrics', 'recall_my_decisions', 'get_timeline'] });
    const client = await connect(createBrainMcpServer(makeDeps().deps, stored));
    expect(await toolNames(client)).toEqual(['get_online_metrics', 'get_timeline', 'recall_my_decisions']);
    await client.close();
  });

  it('gives the standing lessons to the outside tool with the skill', async () => {
    const lessons = [{ text: 'Say the period with every number.', source: 'rec-1', adoptedAt: '2026-10-20T10:00:00Z', by: 'owner' as const }];
    const client = await connect(createBrainMcpServer(makeDeps().deps, storedProfile('finance', { lessons })));
    const text = await promptText(client);
    expect(text).toContain('## Standing lessons');
    expect(text).toContain('- Say the period with every number.');
    await client.close();
  });

  it('tells the outside tool which lessons the owner adopted and which the HQ Manager added by itself', async () => {
    const lessons = [
      { text: 'Say the period with every number.', source: 'rec-1', adoptedAt: '2026-10-20T10:00:00Z', by: 'owner' as const },
      { text: 'Round to the nearest hundred.', source: 'rec-2', adoptedAt: '2026-10-21T10:00:00Z', by: 'manager' as const },
    ];
    const client = await connect(createBrainMcpServer(makeDeps().deps, storedProfile('finance', { lessons })));
    const text = await promptText(client);
    expect(text).toContain('## Standing lessons\nThe owner adopted these for you. Follow them.\n- Say the period with every number.');
    expect(text).toContain('## Suggested by the HQ Manager\nThe HQ Manager suggested these. The owner did not approve them.');
    expect(text).toContain('- Round to the nearest hundred.');
    expect(text.indexOf('Round to the nearest hundred.')).toBeGreaterThan(text.indexOf('## Suggested by the HQ Manager'));
    await client.close();
  });

  it("keeps recall_my_decisions bound to the stored profile's own memory", async () => {
    const t = makeDeps();
    const client = await connect(createBrainMcpServer(t.deps, storedProfile('online', { reads: ['recall_my_decisions'] })));
    await client.callTool({ name: 'recall_my_decisions', arguments: { query: 'returns policy', assistant: 'owner' } });
    expect(t.recalled).toEqual(['online:returns policy']);
    await client.close();
  });
});
