import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { SESSION_REPORT_MAX_BYTES, SessionReport } from '@fahq/contracts';
import { createBrainMcpServer, type BrainMcpDeps, type FileReport } from '../src/index.ts';

// file_work_report: the one tool at a door that writes. A mock stands in for the database; what the database
// does with the report (masking, one row per key, the token's assistant) is in doors-db.test.ts.

const ID = '0c1f6f0e-6f0e-4c1f-8f0e-0c1f6f0e0c1f';
const brain = { memory: () => ({ recallDecisions: () => [] }), record: { timeline: () => [] } } as unknown as Awaited<ReturnType<BrainMcpDeps['openBrain']>>;

async function open(fileReport: FileReport | undefined, clientName = 'claude-code') {
  const server = createBrainMcpServer({ data: null, openBrain: async () => brain, now: () => new Date('2026-10-27T12:00:00Z'), fileReport }, 'online');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: clientName, version: '1.2.3' });
  await client.connect(clientSide);
  return client;
}
const filer = (duplicate = false) => vi.fn<FileReport>(async () => ({ id: ID, duplicate }));
const call = (client: Client, args: Record<string, unknown>) => client.callTool({ name: 'file_work_report', arguments: args });
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? '';

describe('file_work_report', () => {
  it('is offered only when the door has somewhere to file a report', async () => {
    const without = await open(undefined);
    expect((await without.listTools()).tools.map((t) => t.name)).not.toContain('file_work_report');
    const refused = await call(without, { summary: 'x' }).catch((e: Error) => e);
    expect(refused instanceof Error || (refused as { isError?: boolean }).isError).toBeTruthy();
    const withIt = await open(filer());
    expect((await withIt.listTools()).tools.map((t) => t.name)).toContain('file_work_report');
  });

  it('says in its schema what it takes: a summary, and optional steps, suggestions and lessons', async () => {
    const client = await open(filer());
    const tool = (await client.listTools()).tools.find((t) => t.name === 'file_work_report')!;
    expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(['lessons', 'steps', 'suggestions', 'summary']);
    expect(tool.inputSchema.required).toEqual(['summary']);
    expect(tool.description).toMatch(/HQ Manager/);
    expect(tool.description).toMatch(/phone numbers and six-digit codes are masked/i);
  });

  it('files the report as the contract shapes it, naming the tool the client said it was', async () => {
    const file = filer();
    const client = await open(file, 'claude-code');
    const result = await call(client, {
      summary: '  Checked the finance numbers and found one gap.  ',
      steps: ['Read the metrics', 'Compared two periods'],
      suggestions: ['Add the ad spend to the weekly view'],
      lessons: ['Ask for the period first'],
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toEqual({ filed: true, id: ID, duplicate: false });
    expect(file).toHaveBeenCalledOnce();
    const sent = file.mock.calls[0]![0];
    expect(sent).toEqual({
      tool: 'claude-code',
      summary: 'Checked the finance numbers and found one gap.',
      steps: [{ step: 'Read the metrics' }, { step: 'Compared two periods' }],
      suggestions: [{ text: 'Add the ad spend to the weekly view' }],
      lessons: [{ text: 'Ask for the period first' }],
    });
    expect(SessionReport.safeParse(sent).success).toBe(true);
  });

  it('files a report that is only a summary, and passes a duplicate on as one', async () => {
    const file = filer(true);
    const client = await open(file, 'gemini-cli');
    const result = await call(client, { summary: 'Nothing to change.', steps: [], lessons: [] });
    expect(JSON.parse(text(result))).toEqual({ filed: true, id: ID, duplicate: true });
    expect(file.mock.calls[0]![0]).toEqual({ tool: 'gemini-cli', summary: 'Nothing to change.' });
  });

  it('cuts a long client name to what the database takes', async () => {
    const file = filer();
    await call(await open(file, 'c'.repeat(100)), { summary: 'Done.' });
    expect(file.mock.calls[0]![0].tool).toBe('c'.repeat(60));
  });

  it('refuses what is out of bounds, naming the field, and files nothing', async () => {
    const file = filer();
    const client = await open(file);
    const bad: [string, Record<string, unknown>][] = [
      ['no summary', {}],
      ['an empty summary', { summary: '' }],
      ['a blank summary', { summary: '   ' }],
      ['a summary over 2000 characters', { summary: 'x'.repeat(2001) }],
      ['31 steps', { summary: 'ok', steps: Array.from({ length: 31 }, (_, i) => `step ${i}`) }],
      ['a step over 80 characters', { summary: 'ok', steps: ['x'.repeat(81)] }],
      ['an empty step', { summary: 'ok', steps: [''] }],
      ['11 suggestions', { summary: 'ok', suggestions: Array.from({ length: 11 }, (_, i) => `idea ${i}`) }],
      ['a suggestion over 300 characters', { summary: 'ok', suggestions: ['x'.repeat(301)] }],
      ['11 lessons', { summary: 'ok', lessons: Array.from({ length: 11 }, (_, i) => `lesson ${i}`) }],
      ['a lesson over 300 characters', { summary: 'ok', lessons: ['x'.repeat(301)] }],
      ['a step that is not text', { summary: 'ok', steps: [{ step: 'a' }] }],
    ];
    for (const [why, args] of bad) {
      const result = await call(client, args);
      expect(result.isError, why).toBe(true);
    }
    expect(file).not.toHaveBeenCalled();
  });

  it('takes the largest report the limits allow and refuses one over the size cap', async () => {
    const file = filer();
    const client = await open(file);
    const full = (char: string) => ({
      summary: char.repeat(2000),
      steps: Array.from({ length: 30 }, () => char.repeat(80)),
      suggestions: Array.from({ length: 10 }, () => char.repeat(300)),
      lessons: Array.from({ length: 10 }, () => char.repeat(300)),
    });
    expect((await call(client, full('a'))).isError).toBeFalsy(); // about 17 KB
    const big = await call(client, full('€')); // three bytes a character: over the cap
    expect(big.isError).toBe(true);
    expect(text(big)).toBe(`The report is larger than ${SESSION_REPORT_MAX_BYTES / 1024} KB. Shorten the summary and the lists.`);
    expect(file).toHaveBeenCalledOnce();
  });

  it('turns a failed filing into one plain sentence and never throws', async () => {
    const down = vi.fn<FileReport>(async () => {
      throw new Error('The door refused this token: it is not valid, or it was revoked.');
    });
    const result = await call(await open(down), { summary: 'Done.' });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('The report was not filed. The door refused this token: it is not valid, or it was revoked.');
    const odd = vi.fn<FileReport>(async () => {
      throw 'boom';
    });
    expect(text(await call(await open(odd), { summary: 'Done.' }))).toBe('The report was not filed. Unknown error.');
  });

  it('returns only the id and whether it was a duplicate, nothing the database said about anyone', async () => {
    const leaky = vi.fn<FileReport>(async () => ({ id: ID, duplicate: false, token: 'secret', phone: '+15551234567' }) as never);
    const result = await call(await open(leaky), { summary: 'Done.' });
    expect(JSON.parse(text(result))).toEqual({ filed: true, id: ID, duplicate: false });
  });
});
