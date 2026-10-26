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

  it('reports a thrown error as a plain message', async () => {
    expect((await exec.execute('async () => { throw new Error("nope"); }', tools)).error).toBe('nope');
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
      const salon = m.metrics.filter((x) => x.business === 'salon').map((x) => x.id);
      return { metricCount: m.metrics.length, salon, decisions: d.decisions.length, hash: m.queryHash.slice(0, 8) };
    }`;
    const result = await client.callTool({ name: 'code', arguments: { code } });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(JSON.parse(text)).toEqual({ metricCount: 2, salon: ['m:salon.revenue.wash_set'], decisions: 0, hash: 'bbbbbbbb' });
    await client.close();
  });
});
