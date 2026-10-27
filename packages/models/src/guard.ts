import type { ModelPort } from '@fahq/contracts';

// The safety screen: one NVIDIA safety model reads a piece of text and says safe or unsafe.
// It answers a bare user message (no system message), 0.5 to 3.6 s, in one of two shapes:
//   {"User Safety": "unsafe", "Safety Categories": "Criminal Planning/Confessions, Fraud/Deception"}
//   User Safety: unsafe
// FAILS CLOSED: any error, timeout, budget refusal, unreadable reply, or a reply that contradicts
// itself counts as "not safe", with the plain reason "the safety check could not run". The model's
// own words are data: only the verdict and short category names are kept.

export type ScreenInput = {
  model: ModelPort;
  guardModel: string;
  text: string;
  /** How long to wait for the answer (default 8 s). */
  timeoutMs?: number;
  /** A millisecond clock for the timing field; injected so tests are exact. */
  now?: () => number;
};

export type ScreenResult = {
  safe: boolean;
  /** The safety categories the model named (short, at most 10). Empty when safe or when the check could not run. */
  categories: string[];
  model: string;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  /** Why the text was not passed, in a plain sentence; null when it was. */
  reason: string | null;
};

const MAX_TEXT_CHARS = 1600;
const MAX_REPLY_TOKENS = 100;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_CATEGORIES = 10;
const MAX_CATEGORY_CHARS = 60;
const CANNOT_RUN = 'the safety check could not run';

type Verdict = { safe: boolean; categories: string[] };

const cleanCategory = (s: string): string =>
  s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_CATEGORY_CHARS);

function categoriesFrom(value: unknown): string[] {
  const parts: unknown[] = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : [];
  return parts
    .filter((p): p is string => typeof p === 'string')
    .map(cleanCategory)
    .filter((p) => p !== '')
    .slice(0, MAX_CATEGORIES);
}

function verdictWord(value: unknown): boolean | null {
  const word = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return word === 'safe' ? true : word === 'unsafe' ? false : null;
}

/** Reads either reply shape. Returns null for anything it cannot read with certainty. */
export function parseGuardReply(raw: string): Verdict | null {
  const reply = raw.trim();
  let safe: boolean | null = null;
  let categories: string[] = [];

  if (reply.startsWith('{') || reply.startsWith('```')) {
    const start = reply.indexOf('{');
    const end = reply.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(reply.slice(start, end + 1));
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const find = (name: string): unknown => {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (key.trim().toLowerCase() === name) return value;
      }
      return undefined;
    };
    safe = verdictWord(find('user safety'));
    categories = categoriesFrom(find('safety categories'));
  } else {
    const verdict = /(?:^|\n)\s*user safety\s*[:=]\s*(safe|unsafe)\b/i.exec(reply);
    safe = verdict ? verdictWord(verdict[1]) : null;
    const cats = /(?:^|\n)\s*safety categories\s*[:=]\s*([^\n\r]*)/i.exec(reply);
    categories = cats ? categoriesFrom(cats[1]) : [];
  }

  if (safe === null) return null;
  // "safe" with harm categories attached contradicts itself: not trusted.
  if (safe && categories.length > 0) return null;
  return { safe, categories: safe ? [] : categories };
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Screens one piece of text (the first 1,600 characters). Never throws; unsafe unless the model said safe. */
export async function screenText(input: ScreenInput): Promise<ScreenResult> {
  const now = input.now ?? (() => performance.now());
  const started = now();
  const elapsed = () => Math.max(0, Math.round(now() - started));
  const failed = (inputTokens = 0, outputTokens = 0, model = input.guardModel): ScreenResult => ({
    safe: false,
    categories: [],
    model,
    ms: elapsed(),
    inputTokens,
    outputTokens,
    reason: CANNOT_RUN,
  });

  const text = input.text.slice(0, MAX_TEXT_CHARS);
  // Nothing to read means nothing to flag; the model is not asked about an empty message.
  if (text.trim() === '') {
    return { safe: true, categories: [], model: input.guardModel, ms: 0, inputTokens: 0, outputTokens: 0, reason: null };
  }

  const timeoutMs = input.timeoutMs !== undefined && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : DEFAULT_TIMEOUT_MS;
  let answer: Awaited<ReturnType<ModelPort['chat']>>;
  try {
    answer = await withTimeout(
      input.model.chat({
        purpose: 'guard.screen',
        model: input.guardModel,
        system: '',
        user: text,
        maxTokens: MAX_REPLY_TOKENS,
        temperature: 0,
        json: false,
        noSystem: true,
      }),
      timeoutMs,
    );
  } catch {
    return failed();
  }

  const verdict = parseGuardReply(typeof answer.text === 'string' ? answer.text : '');
  if (!verdict) return failed(answer.inputTokens, answer.outputTokens, answer.model);
  return {
    safe: verdict.safe,
    categories: verdict.categories,
    model: answer.model,
    ms: elapsed(),
    inputTokens: answer.inputTokens,
    outputTokens: answer.outputTokens,
    reason: verdict.safe
      ? null
      : verdict.categories.length > 0
        ? `the safety check flagged this text (${verdict.categories.join(', ')})`
        : 'the safety check flagged this text',
  };
}
