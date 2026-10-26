import { describe, expect, it } from 'vitest';
import { createModelClient, ModelError, modelsFromEnv, parseJsonObject, positiveInt, type TokenBudget } from '../src/index.ts';

const ask = { purpose: 'test', model: 'nvidia/x', system: 'sys', user: 'hi', maxTokens: 100, temperature: 0, json: true };

function client(fetchImpl: typeof fetch, budget: TokenBudget = { dailyTokens: 10_000, used: 0, day: '2026-10-26' }) {
  return createModelClient({ provider: 'nvidia', baseUrl: 'https://example.test/v1', apiKey: 'test-only', fetch: fetchImpl, budget, today: () => '2026-10-26' });
}

const okResponse = (content: string, finish = 'stop') =>
  new Response(JSON.stringify({ model: 'nvidia/x', choices: [{ finish_reason: finish, message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }), { status: 200 });
const ok = (content: string, finish = 'stop') => (async () => okResponse(content, finish)) as unknown as typeof fetch;

describe('model client', () => {
  it('calls the chat endpoint without redirects and returns the answer without reasoning', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return okResponse('<think>scratch</think>{"a":1}');
    }) as unknown as typeof fetch;
    const result = await client(fetchImpl).chat(ask);
    expect(seen?.url).toBe('https://example.test/v1/chat/completions');
    expect(seen?.init.redirect).toBe('error');
    expect(JSON.parse(String(seen?.init.body)).stream).toBe(false);
    expect(result.text).toBe('{"a":1}');
    expect(result.inputTokens + result.outputTokens).toBe(30);
  });

  it('never echoes a provider error body', async () => {
    const fetchImpl = (async () => new Response('secret details', { status: 401 })) as unknown as typeof fetch;
    const error = await client(fetchImpl).chat(ask).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelError);
    expect(String((error as Error).message)).not.toContain('secret');
    expect((error as Error).message).toContain('HTTP 401');
  });

  it('rejects an answer that was cut off', async () => {
    await expect(client(ok('{"a":', 'length')).chat(ask)).rejects.toThrow(/incomplete/);
  });

  it('refuses before calling when the daily budget would be exceeded', async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch;
    await expect(client(fetchImpl, { dailyTokens: 50, used: 0, day: '2026-10-26' }).chat(ask)).rejects.toThrow(/budget/);
    expect(called).toBe(false);
  });
});

describe('parseJsonObject', () => {
  it('reads fenced JSON and refuses prose', () => {
    expect(parseJsonObject('```json\n{"plans":[]}\n```')).toEqual({ plans: [] });
    expect(() => parseJsonObject('no json here')).toThrow(/JSON object/);
  });
});

describe('daily token budget (review finding 5)', () => {
  it('stops startup on a setting that is not a positive whole number, instead of disabling the cap', () => {
    expect(() => modelsFromEnv({ MODEL_DAILY_TOKENS: '2,000,000' })).toThrow(/MODEL_DAILY_TOKENS/);
    expect(() => modelsFromEnv({ MODEL_TIMEOUT_MS: 'soon' })).toThrow(/MODEL_TIMEOUT_MS/);
    expect(modelsFromEnv({ MODEL_DAILY_TOKENS: '2_000_000' }).budget.dailyTokens).toBe(2_000_000);
    expect(positiveInt({}, 'X', 7)).toBe(7);
  });

  it('refuses every call when the budget is not a number (fails closed)', async () => {
    const budget = { dailyTokens: Number.NaN, used: 0, day: '2026-10-26' };
    await expect(client(ok('{}'), budget).chat(ask)).rejects.toThrow(/budget/);
  });

  it('gives the reservation back when the provider refused, keeps it when usage is missing', async () => {
    const refused = { dailyTokens: 10_000, used: 0, day: '2026-10-26' };
    await client((async () => new Response('', { status: 503 })) as unknown as typeof fetch, refused).chat(ask).catch(() => null);
    expect(refused.used).toBe(0);

    const silent = { dailyTokens: 10_000, used: 0, day: '2026-10-26' };
    const noUsage = (async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }), { status: 200 })) as unknown as typeof fetch;
    await client(noUsage, silent).chat(ask);
    expect(silent.used).toBeGreaterThan(100); // the worst case stays counted, not zero
  });
});
