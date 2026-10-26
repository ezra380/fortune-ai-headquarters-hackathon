import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { DataPort, Metric } from '@fahq/contracts';
import { openBrain } from '@fahq/brain';
import { createCodeModeBrainServer, QuickJsExecutor } from '../src/index.ts';

describe('QuickJS sandbox executor', () => {
  const exec = new QuickJsExecutor({ timeoutMs: 1500, maxToolCalls: 3 });
  const tools = [{ name: 'codemode', fns: { add: async (input: unknown) => (input as { a: number; b: number }).a + (input as { a: number; b: number }).b } }];

  it('runs code that calls a host tool and captures console output', async () => {
    const r = await exec.execute('async () => { const s = await codemode.add({ a: 2, b: 3 }); console.log("sum", s); return { s }; }', tools);
    expect(r.error).toBeUndefined();
    expect(r.result).toEqual({ s: 5 });
    expect(r.logs).toEqual(['sum 5']);
  });

  it('gives the code no network, process, module loader or timers', async () => {
    const r = await exec.execute('async () => [typeof fetch, typeof process, typeof require, typeof setTimeout, typeof XMLHttpRequest]', tools);
    expect(r.result).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
  });

  it('stops an infinite loop at the deadline', async () => {
    const r = await exec.execute('async () => { while (true) {} }', tools);
    expect(r.error).toMatch(/timed out|interrupted/i);
  });

  it('times out when a host tool never answers', async () => {
    const r = await exec.execute('async () => codemode.hang({})', [{ name: 'codemode', fns: { hang: () => new Promise(() => {}) } }]);
    expect(r.error).toMatch(/timed out/);
  });

  it('refuses unknown tools and caps the number of tool calls', async () => {
    expect((await exec.execute('async () => codemode.deleteEverything({})', tools)).error).toMatch(/unknown tool/);
    const many = await exec.execute('async () => { for (let i = 0; i < 5; i++) await codemode.add({ a: i, b: 1 }); }', tools);
    expect(many.error).toMatch(/tool call limit/);
  });

  it('reports a thrown error as a plain message, never an empty one', async () => {
    expect((await exec.execute('async () => { throw new Error("nope"); }', tools)).error).toBe('nope');
    expect((await exec.execute('async () => { throw ""; }', tools)).error).toBeTruthy();
  });

  it('enforces the memory limit on typed arrays and arrays, and gives the memory back', async () => {
    const small = new QuickJsExecutor({ timeoutMs: 10_000, memoryBytes: 16 * 1024 * 1024 });
    const rssBefore = process.memoryUsage().rss;
    for (const grow of ['a.push(new Uint8Array(100000))', 'a.push(new Array(1000).fill(1))']) {
      const t = Date.now();
      const r = await small.execute(`async () => { const a = []; while (true) ${grow}; }`, tools);
      expect(r.error).toMatch(/out of memory/);
      expect(Date.now() - t).toBeLessThan(5000); // stopped by the cap, not by the 10 s deadline
    }
    // Before the fix the first loop alone grew the process by more than 1 GB.
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(400 * 1024 * 1024);
    expect((await small.execute('async () => 1 + 1', tools)).result).toBe(2);
  });

  it('turns deep recursion into an error, before or after a tool call, and stays usable', async () => {
    for (let i = 0; i < 12; i++) {
      const r = await exec.execute('async () => { const f = (n) => f(n + 1) + 1; return f(0); }', tools);
      expect(r.error).toMatch(/stack overflow/i);
    }
    // After an awaited tool call this used to escape as an unhandled rejection and kill the process.
    const after = await exec.execute('async () => { await codemode.add({ a: 1, b: 1 }); const f = (n) => f(n + 1) + 1; return f(0); }', tools);
    expect(after.error).toMatch(/stack overflow/i);
    expect((await exec.execute('async () => 1 + 1', tools)).result).toBe(2);
  });
});

const meterlessDir = path.resolve(process.env.METERLESS_DIR ?? '.local/meterless');
const haveMeterless = fs.existsSync(path.join(meterlessDir, 'engines/world-model/reference/src/index.ts'));

describe.skipIf(!haveMeterless)('brain behind Cloudflare Code Mode (MCP)', () => {
  it('exposes one typed code tool and answers a multi-tool script in a single call', async () => {
    const source = { system: 'zetaris' as const, view: 'fortune_demo.finance_mart', queryHash: 'b'.repeat(64), asOf: '2026-10-26T12:00:00Z' };
    const metrics: Metric[] = [
      { id: 'm:online.revenue.mazali', label: 'Online Mazali revenue', value: 12400, unit: 'usd', business: 'online', period: '2026-09', source },
      { id: 'm:salon.revenue.wash_set', label: 'Salon wash and set revenue', value: 6200, unit: 'usd', business: 'salon', period: '2026-09', source },
    ];
    // MOCK: stands in for lane B's Zetaris adapter in this unit test only.
    const dataMock: DataPort = { health: async () => ({ ok: true, detail: 'mock' }), getFinanceMetrics: async () => ({ metrics, queryHash: source.queryHash, view: source.view }) };
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fahq-cm-'));
    // One real decision and one recorded request, so recall and timeline return real engine shapes.
    const seed = await openBrain({ meterlessDir, dataDir, actor: 'seed' });
    seed.memory('finance').rememberDecision({ proposalId: 'p1', personId: 'demo-p-finance-owner', verdict: 'declined', planRank: 1, planTitle: 'Mazali discount twenty percent', runId: 'r1' });
    await seed.record.request({ taskId: '11111111-1111-4111-8111-111111111111', personId: 'demo-p-owner', personName: 'Demo Owner', from: 'owner', to: 'finance', text: 'Plans please', at: '2026-10-26T12:00:00Z', runId: '00000000-0000-4000-8000-000000000001' });
    const server = await createCodeModeBrainServer({
      data: dataMock,
      openBrain: () => openBrain({ meterlessDir, dataDir, actor: 'test' }),
      now: () => new Date('2026-10-26T12:00:00Z'),
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '0.0.1' });
    await client.connect(clientSide);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['code']);
    expect(tools[0]?.description).toContain('get_finance_metrics');

    const code = `async () => {
      const m = await codemode.get_finance_metrics({ period: '2026-09' });
      const d = await codemode.recall_decisions({ assistant: 'finance', query: 'mazali discount' });
      const t = await codemode.get_timeline({ limit: 50 });
      const salon = m.metrics.filter((x) => x.business === 'salon').map((x) => x.id);
      return {
        metricCount: m.metrics.length, salon, decisions: d.decisions.length, hash: m.queryHash.slice(0, 8),
        relevanceIsNumber: typeof d.decisions[0].relevance === 'number',
        typedEvents: t.events.length > 0 && t.events.every((e) => typeof e.type === 'string'),
        hasRelate: t.events.some((e) => e.type === 'relate'),
      };
    }`;
    const result = await client.callTool({ name: 'code', arguments: { code } });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(JSON.parse(text)).toEqual({
      metricCount: 2, salon: ['m:salon.revenue.wash_set'], decisions: 1, hash: 'bbbbbbbb',
      relevanceIsNumber: true, typedEvents: true, hasRelate: true,
    });
    await client.close();
  });
});
