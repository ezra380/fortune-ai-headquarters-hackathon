import fs from 'node:fs';
import type { ModelPort } from '@fahq/contracts';

// One OpenAI-compatible chat client for NVIDIA's hosted Nemotron models (and xAI, optionally). With
// MODEL_PROVIDER=meterless the same client talks to the Meterless Runtime that Nightshift serves (its
// "hotspot"), and Nightshift calls NVIDIA with the key set up inside it.
// Rules: a token budget is checked before every call; no redirects; a timeout on every call;
// provider error bodies are never echoed; output cut off mid-answer is rejected; no fallback model.

export class ModelError extends Error {
  constructor(
    message: string,
    readonly code: 'budget' | 'http' | 'timeout' | 'incomplete' | 'malformed',
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

export type TokenBudget = { dailyTokens: number; used: number; day: string };

export type ModelClientOptions = {
  provider: 'nvidia' | 'xai' | 'meterless';
  baseUrl: string;
  apiKey: string;
  /** Sent on every call (the Meterless Runtime wants an app id and a scope). */
  headers?: Readonly<Record<string, string>>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Shared across calls in this process; refuses a call that could exceed the day's tokens. */
  budget: TokenBudget;
  /** USD per million tokens [input, output]; when absent, cost is reported as 0 and labeled unknown. */
  pricePerMillion?: Readonly<Record<string, readonly [number, number]>>;
  today?: () => string;
};

export function createModelClient(opts: ModelClientOptions): ModelPort & { readonly provider: string } {
  const doFetch = opts.fetch ?? fetch;
  const today = opts.today ?? (() => new Date().toISOString().slice(0, 10));
  return {
    provider: opts.provider,
    async chat(input) {
      if (!opts.apiKey.trim()) throw new ModelError(`${opts.provider} API key is not set`, 'budget');
      const day = today();
      if (opts.budget.day !== day) Object.assign(opts.budget, { day, used: 0 });
      const worstCase = estimateTokens(input.system) + estimateTokens(input.user) + input.maxTokens;
      // Written so that NaN anywhere refuses the call instead of allowing it.
      if (!(opts.budget.used + worstCase <= opts.budget.dailyTokens)) {
        throw new ModelError(`daily token budget reached (${opts.budget.used} of ${opts.budget.dailyTokens})`, 'budget');
      }
      opts.budget.used += worstCase;
      // A call the provider refused before doing any work gives its reservation back; a timeout keeps it.
      const release = () => {
        opts.budget.used -= worstCase;
      };

      let response: Response;
      try {
        response = await doFetch(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
          headers: { ...opts.headers, Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: input.model,
            stream: false,
            max_tokens: input.maxTokens,
            temperature: input.temperature,
            messages: input.noSystem
              ? [{ role: 'user', content: input.user }]
              : [
                  { role: 'system', content: input.system },
                  { role: 'user', content: input.user },
                ],
            // NVIDIA-hosted Nemotron honors this switch; measured: routing 0.6 s / 41 tokens with
            // thinking off vs 14 s / 1,436 tokens with it on.
            // Through Nightshift the switch rides along when the model is an NVIDIA one.
            ...(input.thinking === false && (opts.provider === 'nvidia' || (opts.provider === 'meterless' && input.model.startsWith('nvidia/')))
              ? { chat_template_kwargs: { enable_thinking: false } }
              : {}),
          }),
        });
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        if (!timedOut) release();
        throw new ModelError(`${opts.provider} request ${timedOut ? 'timed out' : 'failed'}; no fallback model was used`, timedOut ? 'timeout' : 'http');
      }
      if (response.status !== 200) {
        release();
        throw new ModelError(`${opts.provider} returned HTTP ${response.status}; response body withheld`, 'http');
      }
      let body: {
        model?: string;
        choices?: { finish_reason?: string; message?: { content?: unknown } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        body = (await response.json()) as typeof body;
      } catch {
        throw new ModelError(`${opts.provider} returned a body that is not JSON`, 'malformed');
      }
      const choice = body.choices?.[0];
      if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string') {
        throw new ModelError(`${opts.provider} answer was incomplete (${choice?.finish_reason ?? 'no choice'})`, 'incomplete');
      }
      const count = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null);
      const reportedIn = count(body.usage?.prompt_tokens);
      const reportedOut = count(body.usage?.completion_tokens);
      const inputTokens = reportedIn ?? 0;
      const outputTokens = reportedOut ?? 0;
      // Missing or malformed usage keeps the worst-case reservation instead of counting the call as free.
      if (reportedIn !== null && reportedOut !== null) opts.budget.used += inputTokens + outputTokens - worstCase;
      const price = opts.pricePerMillion?.[input.model];
      const costUsd = price ? (inputTokens * price[0] + outputTokens * price[1]) / 1_000_000 : 0;
      return {
        text: stripReasoning(choice.message.content),
        model: body.model ?? input.model,
        inputTokens,
        outputTokens,
        costUsd,
      };
    },
  };
}

/** Reasoning models may prepend <think>…</think>; only the answer is returned. */
export function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/** Parses one JSON object from model text: tolerates code fences, nothing else. */
export function parseJsonObject(text: string): unknown {
  const unfenced = stripReasoning(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) throw new ModelError('model did not return a JSON object', 'malformed');
  try {
    return JSON.parse(unfenced.slice(start, end + 1)) as unknown;
  } catch {
    throw new ModelError('model returned invalid JSON', 'malformed');
  }
}

/** Rough upper bound used only for the pre-call budget check (about 3 characters per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** A positive whole number from a setting, or its default; anything else stops startup (never a silent NaN). */
export function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw.replaceAll('_', ''));
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive whole number`);
  return n;
}

/** The Meterless Runtime contract (0.90.0): any pasted URL becomes <host>/v1, never /v1/v1. */
export function normalizeMeterlessUrl(raw: string): string {
  const withScheme = /^[a-z]+:\/\//i.test(raw.trim()) ? raw.trim() : `http://${raw.trim()}`;
  const url = new URL(withScheme);
  return `${url.protocol}//${url.host}/v1`;
}

/** Nightshift's token: METERLESS_TOKEN, or the runtime's proxy-token file. The placeholder rt-local is refused. */
export function meterlessToken(env: NodeJS.ProcessEnv): string {
  const fromFile = env.METERLESS_TOKEN_FILE ? fs.readFileSync(env.METERLESS_TOKEN_FILE, 'utf8') : '';
  const token = (env.METERLESS_TOKEN ?? fromFile).trim();
  if (token === 'rt-local') throw new Error('METERLESS_TOKEN is the placeholder rt-local; use the token Nightshift wrote to proxy-token');
  return token;
}

/**
 * Whether the Meterless Runtime answers, by its contract: GET /v1/models decides (401/403 means the
 * token is wrong, 200 with meterless ids or models means online, anything else offline).
 */
export async function checkMeterless(baseUrl: string, token: string, doFetch: typeof fetch = fetch): Promise<
  { status: 'online'; models: string[] } | { status: 'unauthorized' | 'offline'; models: [] }
> {
  try {
    const r = await doFetch(`${normalizeMeterlessUrl(baseUrl)}/models`, {
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${token}`, 'meterless-app': METERLESS_APP },
    });
    if (r.status === 401 || r.status === 403) return { status: 'unauthorized', models: [] };
    if (r.status !== 200) return { status: 'offline', models: [] };
    const body = (await r.json()) as { data?: { id?: unknown }[] };
    const models = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
    return models.length > 0 ? { status: 'online', models } : { status: 'offline', models: [] };
  } catch {
    return { status: 'offline', models: [] };
  }
}

/** This app's stable id on the Meterless Runtime: its requests are recorded apart from other apps'. */
export const METERLESS_APP = 'fortune-ai-hq';

export function modelsFromEnv(env: NodeJS.ProcessEnv, deps: { fetch?: typeof fetch } = {}) {
  const budget: TokenBudget = { dailyTokens: positiveInt(env, 'MODEL_DAILY_TOKENS', 2_000_000), used: 0, day: '' };
  // Ultra writing three plans with reasoning can take minutes; routing calls finish in about a second.
  const timeoutMs = positiveInt(env, 'MODEL_TIMEOUT_MS', 300_000);
  const provider = env.MODEL_PROVIDER ?? 'nvidia';
  if (provider !== 'nvidia' && provider !== 'meterless') throw new Error('MODEL_PROVIDER must be nvidia or meterless');
  // Every assistant's calls go through one client. Through Nightshift, the runtime holds the NVIDIA key,
  // and a cold model load can take minutes, so the timeout is never under the contract's 180 s.
  const nvidia = provider === 'meterless'
    ? createModelClient({
        provider: 'meterless',
        baseUrl: normalizeMeterlessUrl(env.METERLESS_BASE_URL ?? '127.0.0.1:8088'),
        apiKey: meterlessToken(env),
        headers: { 'meterless-app': METERLESS_APP, 'meterless-scope': 'user' },
        budget,
        timeoutMs: Math.max(timeoutMs, 180_000),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      })
    : createModelClient({
        provider: 'nvidia',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        apiKey: env.NEMOTRON_API_KEY ?? '',
        budget,
        timeoutMs,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
  // The safety screen's client. Through Nightshift it can call NVIDIA directly (GUARD_PROVIDER=nvidia): the runtime
  // serves only the models enabled in it, and on 2026-10-27 the content-safety model was not one ("model_not_found"),
  // which would fail every screen closed. By default the screen goes wherever every other call goes.
  const guardProvider = env.GUARD_PROVIDER ?? provider;
  if (guardProvider !== 'nvidia' && guardProvider !== 'meterless') throw new Error('GUARD_PROVIDER must be nvidia or meterless');
  const guardClient = guardProvider === provider
    ? nvidia
    : createModelClient({
        provider: 'nvidia',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        apiKey: env.NEMOTRON_API_KEY ?? '',
        budget,
        timeoutMs,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
  const xai = env.XAI_API_KEY
    ? createModelClient({
        provider: 'xai',
        baseUrl: 'https://api.x.ai/v1',
        apiKey: env.XAI_API_KEY,
        budget,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      })
    : null;
  return {
    nvidia,
    xai,
    budget,
    planModel: env.NEMOTRON_PLAN_MODEL ?? 'nvidia/nemotron-3-ultra-550b-a55b',
    routerModel: env.NEMOTRON_ROUTER_MODEL ?? 'nvidia/nemotron-3.5-lightning-30b-a3b',
    reviewModel: env.XAI_MODEL ?? '',
    // The safety screen (guard.ts): a small NVIDIA safety model; GUARD=off turns the screen off.
    // Nemotron 3.5 Content Safety answered in 0.3–4.9 s on 2026-10-26; the Llama-based safety guard
    // stopped answering that evening (it can be chosen with GUARD_MODEL).
    guardModel: env.GUARD_MODEL ?? 'nvidia/nemotron-3.5-content-safety',
    guardClient,
    guard: env.GUARD !== 'off',
  };
}

export { screenText } from './guard.ts';
export type { ScreenInput, ScreenResult } from './guard.ts';
