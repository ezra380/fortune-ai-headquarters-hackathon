import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { AssistantId, type DataPort, type Metric } from '@fahq/contracts';
import type { Brain } from '@fahq/brain';
import { loadProfiles } from '@fahq/profiles';
import { createBrainMcpServer, createCodeModeBrainServer, type BrainMcpDeps } from '../src/index.ts';

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

async function connect(server: McpServer) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.1' });
  await client.connect(clientSide);
  return client;
}

// A client lists tools only when the server advertises them; a door with nothing to offer does not.
const toolNames = async (c: Client) => (c.getServerCapabilities()?.tools ? (await c.listTools()).tools.map((t) => t.name).sort() : []);
const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? '');

describe('profile doors (plain tools)', () => {
  it('offers each profile only the tools it may read', async () => {
    const expected: Record<AssistantId, string[]> = {
      owner: ['get_finance_metrics', 'get_timeline', 'recall_decisions'],
      finance: ['get_finance_metrics', 'recall_my_decisions'],
      online: ['get_online_metrics', 'recall_my_decisions'],
      salon: [],
      manager: ['get_timeline', 'recall_decisions'],
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
    expect(await toolNames(client)).toEqual(['get_finance_metrics', 'get_timeline', 'recall_decisions']);
    await client.close();
  });

  it('serves the profile skill as the `skill` prompt on every door', async () => {
    for (const id of AssistantId.options) {
      const client = await connect(createBrainMcpServer(makeDeps().deps, id));
      const { prompts } = await client.listPrompts();
      expect(prompts.map((p) => p.name), id).toEqual(['skill']);
      expect(prompts[0]!.description).toMatch(/read-only/i);
      const got = await client.getPrompt({ name: 'skill' });
      expect(got.messages).toHaveLength(1);
      const content = got.messages[0]!.content as { type: string; text: string };
      expect(content.type).toBe('text');
      expect(content.text).toBe(profiles[id].skill);
      expect(content.text).toContain('read-only');
      await client.close();
    }
  });

  it('gives the online door online numbers only', async () => {
    const client = await connect(createBrainMcpServer(makeDeps().deps, 'online'));
    const r = JSON.parse(text(await client.callTool({ name: 'get_online_metrics', arguments: { period: '2026-09' } }))) as { metrics: { id: string; business: string }[] };
    expect(r.metrics.map((m) => m.id)).toEqual(['m:online.revenue.mazali']);
    expect(r.metrics.every((m) => m.business === 'online')).toBe(true);
    await client.close();
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
    expect((await finance.getPrompt({ name: 'skill' })).messages[0]!.content).toMatchObject({ text: profiles.finance.skill });
    await finance.close();

    const manager = await connect(await createCodeModeBrainServer(makeDeps().deps, {}, 'manager'));
    const description = (await manager.listTools()).tools[0]!.description ?? '';
    expect(description).toContain('get_timeline');
    expect(description).not.toContain('get_finance_metrics');
    await manager.close();
  });

  it('gives the salon placeholder no code tool at all, only its skill', async () => {
    const salon = await connect(await createCodeModeBrainServer(makeDeps().deps, {}, 'salon'));
    expect(await toolNames(salon)).toEqual([]);
    expect((await salon.listPrompts()).prompts.map((p) => p.name)).toEqual(['skill']);
    expect((await salon.getPrompt({ name: 'skill' })).messages[0]!.content).toMatchObject({ text: profiles.salon.skill });
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
