import { describe, expect, it } from 'vitest';
import { checkMeterless, createModelClient, ModelError, modelsFromEnv, normalizeMeterlessUrl, parseJsonObject, positiveInt, type TokenBudget } from '../src/index.ts';

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

describe('Nightshift (the Meterless Runtime) as the provider', () => {
  it('normalizes any pasted runtime address to <host>/v1, never /v1/v1', () => {
    for (const raw of ['127.0.0.1:8088', 'http://127.0.0.1:8088', 'http://127.0.0.1:8088/v1', 'http://127.0.0.1:8088/v1/chat/completions', 'http://127.0.0.1:8088/healthz', '127.0.0.1:8088/v1/models']) {
      expect(normalizeMeterlessUrl(raw)).toBe('http://127.0.0.1:8088/v1');
    }
  });

  it('sends the bearer token, the app id and the scope, and passes the thinking switch only for NVIDIA models', async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => { seen.push(init); return okResponse('ok'); }) as unknown as typeof fetch;
    const { nvidia } = modelsFromEnv({ MODEL_PROVIDER: 'meterless', METERLESS_BASE_URL: '172.23.224.1:8088', METERLESS_TOKEN: 'tok-test' }, { fetch: fetchImpl });
    expect(nvidia.provider).toBe('meterless');
    await nvidia.chat({ ...ask, model: 'nvidia/nemotron-3.5-lightning-30b-a3b', thinking: false });
    await nvidia.chat({ ...ask, model: 'meterless/fast', thinking: false });
    const headers = seen[0]!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-test');
    expect(headers['meterless-app']).toBe('fortune-ai-hq');
    expect(headers['meterless-scope']).toBe('user');
    expect(JSON.parse(String(seen[0]!.body)).chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(JSON.parse(String(seen[1]!.body)).chat_template_kwargs).toBeUndefined();
  });

  it('screens through NVIDIA directly when GUARD_PROVIDER=nvidia, because the runtime may not serve the safety model', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => { seen.push({ url, init }); return okResponse('ok'); }) as unknown as typeof fetch;
    const env = { MODEL_PROVIDER: 'meterless', METERLESS_BASE_URL: '172.23.224.1:8088', METERLESS_TOKEN: 'tok-test', NEMOTRON_API_KEY: 'nv-test' };
    const split = modelsFromEnv({ ...env, GUARD_PROVIDER: 'nvidia' }, { fetch: fetchImpl });
    await split.nvidia.chat({ ...ask, model: 'nvidia/nemotron-3.5-lightning-30b-a3b' });
    await split.guardClient.chat({ ...ask, model: split.guardModel });
    expect(seen.map((s) => s.url)).toEqual(['http://172.23.224.1:8088/v1/chat/completions', 'https://integrate.api.nvidia.com/v1/chat/completions']);
    expect((seen[1]!.init.headers as Record<string, string>).Authorization).toBe('Bearer nv-test');
    // By default the screen goes wherever every other call goes.
    const one = modelsFromEnv(env, { fetch: fetchImpl });
    expect(one.guardClient).toBe(one.nvidia);
    expect(() => modelsFromEnv({ ...env, GUARD_PROVIDER: 'openai' })).toThrow(/GUARD_PROVIDER/);
  });

  it('refuses the rt-local placeholder token and an unknown provider', () => {
    expect(() => modelsFromEnv({ MODEL_PROVIDER: 'meterless', METERLESS_TOKEN: 'rt-local' })).toThrow(/rt-local/);
    expect(() => modelsFromEnv({ MODEL_PROVIDER: 'openai' })).toThrow(/MODEL_PROVIDER/);
  });

  it('reads the runtime status the way the contract says: /v1/models decides', async () => {
    const answer = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await checkMeterless('127.0.0.1:8088', 't', answer(200, { data: [{ id: 'meterless/auto' }, { id: 'nvidia/nemotron-3-ultra-550b-a55b' }] })))
      .toEqual({ status: 'online', models: ['meterless/auto', 'nvidia/nemotron-3-ultra-550b-a55b'] });
    expect((await checkMeterless('127.0.0.1:8088', 'bad', answer(401))).status).toBe('unauthorized');
    expect((await checkMeterless('127.0.0.1:8088', 't', answer(500))).status).toBe('offline');
    expect((await checkMeterless('127.0.0.1:8088', 't', (async () => { throw new Error('refused'); }) as unknown as typeof fetch)).status).toBe('offline');
  });
});
