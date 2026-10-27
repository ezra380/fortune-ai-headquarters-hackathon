import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { AssistantId, type DataPort, type Metric } from '@fahq/contracts';
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
      owner: ['get_finance_metrics', 'get_timeline', 'recall_decisions'],
      finance: ['get_finance_metrics', 'recall_my_decisions'],
      online: ['get_online_metrics', 'recall_my_decisions'],
      salon: ['recall_my_decisions'], // its salon numbers are served inside the worker only
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
    expect(await toolNames(plain)).toEqual(['file_work_report', 'get_finance_metrics', 'recall_my_decisions']);
    const code = await connect(await createCodeModeBrainServer(deps, {}, 'finance'));
    expect(await toolNames(code)).toEqual(['code', 'file_work_report']);
    await plain.close();
    await code.close();
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
    const lessons = [{ text: 'Say the period with every number.', source: 'rec-1', adoptedAt: '2026-10-20T10:00:00Z' }];
    const client = await connect(createBrainMcpServer(makeDeps().deps, storedProfile('finance', { lessons })));
    const text = await promptText(client);
    expect(text).toContain('## Standing lessons');
    expect(text).toContain('- Say the period with every number.');
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
