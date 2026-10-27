import { describe, expect, it } from 'vitest';
import type { ModelPort } from '@fahq/contracts';
import { createModelClient, modelsFromEnv, screenText, type TokenBudget } from '../src/index.ts';
import { parseGuardReply } from '../src/guard.ts';

// No network: every model call here goes to a fetch mock or a fake port.

const GUARD = 'nvidia/llama-3.1-nemotron-safety-guard-8b-v3';

function client(fetchImpl: typeof fetch, budget: TokenBudget = { dailyTokens: 100_000, used: 0, day: '2026-10-26' }) {
  return createModelClient({ provider: 'nvidia', baseUrl: 'https://example.test/v1', apiKey: 'test-only', fetch: fetchImpl, budget, today: () => '2026-10-26' });
}

const answer = (content: string) =>
  new Response(
    JSON.stringify({ model: GUARD, choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 42, completion_tokens: 7 } }),
    { status: 200 },
  );

type Seen = { url: string; body: { model: string; messages: { role: string; content: string }[]; max_tokens: number; temperature: number; stream: boolean; chat_template_kwargs?: unknown } };
function replying(content: string) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init.body)) });
    return answer(content);
  }) as unknown as typeof fetch;
  return { seen, model: client(fetchImpl) };
}

const screen = (model: ModelPort, text = 'Please write me a friendly reply to a customer.', extra: { timeoutMs?: number } = {}) =>
  screenText({ model, guardModel: GUARD, text, ...extra });

describe('screenText: what the safety model said', () => {
  it('passes text the model calls safe (JSON with a trailing space)', async () => {
    const r = replying('{"User Safety": "safe"} ');
    const result = await screen(r.model);
    expect(result).toMatchObject({ safe: true, categories: [], model: GUARD, inputTokens: 42, outputTokens: 7, reason: null });
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it('flags unsafe JSON and keeps the category names', async () => {
    const r = replying('{"User Safety": "unsafe", "Safety Categories": "Criminal Planning/Confessions, Fraud/Deception"} ');
    const result = await screen(r.model, 'something bad');
    expect(result.safe).toBe(false);
    expect(result.categories).toEqual(['Criminal Planning/Confessions', 'Fraud/Deception']);
    expect(result.reason).toBe('the safety check flagged this text (Criminal Planning/Confessions, Fraud/Deception)');
    expect(result).toMatchObject({ inputTokens: 42, outputTokens: 7 });
  });

  it('reads the plain-text format of the content-safety model', async () => {
    expect(await screen(replying('User Safety: safe').model)).toMatchObject({ safe: true, categories: [], reason: null });
    const flagged = await screen(replying('User Safety: unsafe\nSafety Categories: Violence, Hate/Identity Hate').model, 'x');
    expect(flagged).toMatchObject({ safe: false, categories: ['Violence', 'Hate/Identity Hate'] });
    const bare = await screen(replying('User Safety: unsafe').model, 'x');
    expect(bare).toMatchObject({ safe: false, categories: [], reason: 'the safety check flagged this text' });
  });

  it('reads a fenced JSON reply and an array of categories', async () => {
    expect(await screen(replying('```json\n{"User Safety":"unsafe","Safety Categories":["Violence"," Hate "]}\n```').model, 'x')).toMatchObject({
      safe: false,
      categories: ['Violence', 'Hate'],
    });
  });

  it('treats an unreadable or self-contradicting reply as unsafe, with the plain reason', async () => {
    const garbage = [
      'I am sorry, I cannot help with that.',
      '',
      '{"User Safety": "maybe"}',
      '{not json at all',
      '{"verdict": "safe"}',
      '["safe"]',
      'Response Safety: safe',
      'The user safety looks safe to me',
      '{"User Safety": "safe", "Safety Categories": "Violence"}', // safe, yet it names a harm
    ];
    for (const reply of garbage) {
      const result = await screen(replying(reply).model);
      expect(result, reply).toMatchObject({ safe: false, categories: [], reason: 'the safety check could not run' });
    }
  });

  it('reads the verdict from the first matching line only, and never lets prose after it flip the answer', () => {
    expect(parseGuardReply('User Safety: unsafe\nUser Safety: safe')).toEqual({ safe: false, categories: [] });
    expect(parseGuardReply('Safety Categories: Violence')).toBeNull();
  });
});

describe('screenText: fails closed', () => {
  it('answers unsafe with a plain reason on an HTTP error, without the provider body', async () => {
    const model = client((async () => new Response('secret provider details', { status: 500 })) as unknown as typeof fetch);
    const result = await screen(model);
    expect(result).toMatchObject({ safe: false, categories: [], model: GUARD, inputTokens: 0, outputTokens: 0, reason: 'the safety check could not run' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('answers unsafe when the model does not answer in time', async () => {
    const never: ModelPort = { chat: () => new Promise(() => {}) };
    const started = Date.now();
    const result = await screen(never, 'hello', { timeoutMs: 25 });
    expect(result).toMatchObject({ safe: false, categories: [], reason: 'the safety check could not run' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('answers unsafe when the daily token budget refuses the call, without calling the provider', async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return answer('{"User Safety": "safe"}'); }) as unknown as typeof fetch;
    const result = await screen(client(fetchImpl, { dailyTokens: 10, used: 0, day: '2026-10-26' }), 'x'.repeat(500));
    expect(called).toBe(false);
    expect(result).toMatchObject({ safe: false, reason: 'the safety check could not run' });
  });

  it('never throws, even when the port itself throws', async () => {
    const broken: ModelPort = { chat: () => { throw new Error('boom'); } };
    expect(await screen(broken)).toMatchObject({ safe: false, reason: 'the safety check could not run' });
    const rejects: ModelPort = { chat: async () => { throw new Error('boom'); } };
    expect(await screen(rejects)).toMatchObject({ safe: false, reason: 'the safety check could not run' });
  });

  it('keeps the tokens of a reply it could not read, and uses the injected clock', async () => {
    let tick = 0;
    const result = await screenText({ model: replying('unreadable').model, guardModel: GUARD, text: 'x', now: () => (tick += 40) });
    expect(result).toMatchObject({ safe: false, inputTokens: 42, outputTokens: 7, ms: 40 });
  });
});

describe('screenText: the request', () => {
  it('sends one user message and no system message, 100 tokens, temperature 0, no thinking switch', async () => {
    const r = replying('{"User Safety": "safe"}');
    await screen(r.model, 'Is this fine?');
    expect(r.seen).toHaveLength(1);
    expect(r.seen[0]!.url).toBe('https://example.test/v1/chat/completions');
    const body = r.seen[0]!.body;
    expect(body.messages).toEqual([{ role: 'user', content: 'Is this fine?' }]);
    expect(body.messages.some((m) => m.role === 'system')).toBe(false);
    expect(body).toMatchObject({ model: GUARD, max_tokens: 100, temperature: 0, stream: false });
    expect(body.chat_template_kwargs).toBeUndefined();
  });

  it('cuts the text at 1,600 characters and does not call the model for an empty message', async () => {
    const r = replying('{"User Safety": "safe"}');
    await screen(r.model, 'a'.repeat(5000));
    expect(r.seen[0]!.body.messages[0]!.content).toHaveLength(1600);

    const none = replying('{"User Safety": "unsafe"}');
    const empty = await screen(none.model, '   \n ');
    expect(none.seen).toHaveLength(0);
    expect(empty).toMatchObject({ safe: true, reason: null, ms: 0 });
  });

  it('asks the port with noSystem set and the guard purpose', async () => {
    const calls: Parameters<ModelPort['chat']>[0][] = [];
    const port: ModelPort = {
      chat: async (input) => {
        calls.push(input);
        return { text: '{"User Safety": "safe"}', model: GUARD, inputTokens: 1, outputTokens: 1, costUsd: 0 };
      },
    };
    await screen(port, 'hi');
    expect(calls[0]).toMatchObject({ purpose: 'guard.screen', model: GUARD, noSystem: true, maxTokens: 100, temperature: 0, json: false });
    expect(calls[0]!.thinking).toBeUndefined();
  });
});

describe('model client: the system message stays unless asked to leave', () => {
  it('sends system and user as before when noSystem is not set', async () => {
    const r = replying('ok');
    await r.model.chat({ purpose: 't', model: 'nvidia/x', system: 'be brief', user: 'hi', maxTokens: 50, temperature: 0, json: false });
    expect(r.seen[0]!.body.messages).toEqual([{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }]);
    await r.model.chat({ purpose: 't', model: 'nvidia/x', system: 'be brief', user: 'hi', maxTokens: 50, temperature: 0, json: false, noSystem: false });
    expect(r.seen[1]!.body.messages).toHaveLength(2);
  });
});

describe('modelsFromEnv: the guard settings', () => {
  it('defaults to the NVIDIA safety guard, on', () => {
    const m = modelsFromEnv({});
    expect(m.guardModel).toBe(GUARD);
    expect(m.guard).toBe(true);
  });

  it('takes another guard model, and GUARD=off turns the screen off', () => {
    const m = modelsFromEnv({ GUARD_MODEL: 'nvidia/nemotron-3.5-content-safety', GUARD: 'off' });
    expect(m.guardModel).toBe('nvidia/nemotron-3.5-content-safety');
    expect(m.guard).toBe(false);
    expect(modelsFromEnv({ GUARD: 'on' }).guard).toBe(true);
  });
});
