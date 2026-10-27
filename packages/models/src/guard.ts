import type { ModelPort } from '@fahq/contracts';

// The safety screen: one NVIDIA safety model reads a piece of text and says safe or unsafe.
// It answers a bare user message (no system message), 0.5 to 3.6 s, in one of two shapes:
//   {"User Safety": "unsafe", "Safety Categories": "Criminal Planning/Confessions, Fraud/Deception"}
//   User Safety: unsafe
// FAILS CLOSED: any error, timeout, budget refusal, unreadable reply, or a reply that contradicts
// itself counts as "not safe", with the plain reason "the safety check could not run". A text too long
// to read in full is "not safe" too ("the text is too long to screen"); it is never cut short and passed.
// The model's own words are data: only the verdict and short category names are kept.

export type ScreenInput = {
  model: ModelPort;
  guardModel: string;
  text: string;
  /** How long to wait for each model call (default 8 s). The windows of a long text are asked at the same time. */
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

// One model call reads at most WINDOW_CHARS characters. A longer text is read in overlapping windows, at most
// MAX_WINDOWS of them (7,200 characters), and every window has to come back safe. Past that it is refused, never trimmed.
const WINDOW_CHARS = 1600;
const WINDOW_OVERLAP = 200;
const MAX_WINDOWS = 5;
const MAX_REPLY_TOKENS = 100;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_CATEGORIES = 10;
const MAX_CATEGORY_CHARS = 60;
const CANNOT_RUN = 'the safety check could not run';
const TOO_LONG = 'the text is too long to screen';

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

/**
 * The 1,600-character windows a text is read in, or null when it needs more than MAX_WINDOWS. They overlap by
 * WINDOW_OVERLAP characters, so a phrase shorter than that is whole inside at least one window and cannot be
 * hidden by sitting on an edge. Together they cover every character. A window of only whitespace is left out.
 */
function windowsOf(text: string): string[] | null {
  const step = WINDOW_CHARS - WINDOW_OVERLAP;
  const count = text.length <= WINDOW_CHARS ? 1 : 1 + Math.ceil((text.length - WINDOW_CHARS) / step);
  if (count > MAX_WINDOWS) return null;
  return Array.from({ length: count }, (_, i) => text.slice(i * step, i * step + WINDOW_CHARS)).filter((w) => w.trim() !== '');
}

type Asked = { verdict: Verdict | null; model: string; inputTokens: number; outputTokens: number };

/** One model call about one window. A null verdict means the check could not run. Never throws. */
async function askAbout(input: ScreenInput, text: string, timeoutMs: number): Promise<Asked> {
  try {
    const answer = await withTimeout(
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
    const verdict = parseGuardReply(typeof answer.text === 'string' ? answer.text : '');
    return { verdict, model: answer.model, inputTokens: answer.inputTokens, outputTokens: answer.outputTokens };
  } catch {
    return { verdict: null, model: input.guardModel, inputTokens: 0, outputTokens: 0 };
  }
}

/** Safe only if every window was read and safe. A flagged window names its categories even if another could not be read. */
function combine(asked: Asked[], guardModel: string, ms: number): ScreenResult {
  const flagged = asked.flatMap((a) => (a.verdict && !a.verdict.safe ? [a.verdict] : []));
  const unread = asked.some((a) => a.verdict === null);
  const categories = [...new Set(flagged.flatMap((v) => v.categories))].slice(0, MAX_CATEGORIES);
  const safe = asked.length > 0 && flagged.length === 0 && !unread;
  let reason: string | null = null;
  if (flagged.length > 0) {
    reason = categories.length > 0 ? `the safety check flagged this text (${categories.join(', ')})` : 'the safety check flagged this text';
  } else if (!safe) {
    reason = CANNOT_RUN;
  }
  return {
    safe,
    categories,
    model: asked[0]?.model ?? guardModel,
    ms,
    inputTokens: asked.reduce((sum, a) => sum + a.inputTokens, 0),
    outputTokens: asked.reduce((sum, a) => sum + a.outputTokens, 0),
    reason,
  };
}

/**
 * Screens a whole text, up to MAX_WINDOWS windows of 1,600 characters (7,200 characters). Longer text is refused,
 * not trimmed, so no part of what is passed is unseen. Never throws; unsafe unless the model said safe about every window.
 */
export async function screenText(input: ScreenInput): Promise<ScreenResult> {
  const unscreened = (safe: boolean, reason: string | null): ScreenResult => ({
    safe, categories: [], model: input.guardModel, ms: 0, inputTokens: 0, outputTokens: 0, reason,
  });
  // Nothing to read means nothing to flag; the model is not asked about an empty message.
  if (input.text.trim() === '') return unscreened(true, null);
  const windows = windowsOf(input.text);
  if (!windows) return unscreened(false, TOO_LONG);

  const now = input.now ?? (() => performance.now());
  const started = now();
  const timeoutMs = input.timeoutMs !== undefined && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : DEFAULT_TIMEOUT_MS;
  // All windows are asked at once, so a long text costs one wait, not several. Each call is bounded by timeoutMs.
  const asked = await Promise.all(windows.map((w) => askAbout(input, w, timeoutMs)));
  return combine(asked, input.guardModel, Math.max(0, Math.round(now() - started)));
}
