import type { ModelPort } from '@fahq/contracts';

// The reply step after a Code Mode script: a model turns the script's small facts into a few plain
// sentences, and a program then checks that every number in the reply came from those facts.

/** The rules for any reply that a person reads as a text message. */
export const ANSWER_RULES = [
  'Reply in at most 3 short sentences, written for a text message.',
  'Use only the facts given. Every number must come from the facts.',
  'If the facts do not answer the question, say so plainly. Do not guess.',
].join('\n');

export async function writeAnswer(input: {
  model: ModelPort;
  modelId: string;
  skill: string;
  question: string;
  /** The script's result: plain JSON. */
  facts: unknown;
  maxTokens?: number;
  /** Receipt step name; defaults to 'answer'. */
  purpose?: string;
}): Promise<{ text: string; inputTokens: number; outputTokens: number; model: string }> {
  const reply = await input.model.chat({
    purpose: input.purpose ?? 'answer',
    model: input.modelId,
    system: `${input.skill}\n\n## How to answer\n${ANSWER_RULES}`,
    user: JSON.stringify({ question: input.question, facts: input.facts }),
    maxTokens: input.maxTokens ?? 400,
    temperature: 0.2,
    json: false,
    thinking: false,
  });
  const text = reply.text.trim();
  if (!text) throw new Error('the model wrote an empty answer');
  return { text, inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, model: reply.model };
}

// ---- Tracing numbers ---------------------------------------------------------------------------

type Figure = { raw: string; base: number; decimals: number; scale: number; percent: boolean; at: number; plain: boolean };

const UNIT_SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, million: 1e6, m: 1e6, bn: 1e9, billion: 1e9 };
const FIGURE = /(?<![\w.])(\$)?\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s?(%|percent\b|per\s?cent\b|x\b|×|k\b|thousand\b|million\b|billion\b|bn\b|m\b))?/gi;
const ISO_DATE = /\b\d{4}-\d{2}(?:-\d{2})?\b/g;
const WORD_NUMBER = /\b(?:a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|a few|several|a couple of|half a)[\s-]+(?:hundred|thousand|million|billion|percent|per cent|dollars?|grand)\b/gi;
const YEAR_CONTEXT = /(?:\b(?:in|of|since|during|for|fy|q[1-4]|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+)$/i;

/** Every figure in a piece of text. The text is data: nothing in it is ever run. */
function figuresIn(input: string): Figure[] {
  const text = input.normalize('NFKC').replace(ISO_DATE, (d) => ' '.repeat(d.length));
  const found: Figure[] = [];
  for (const m of text.matchAll(FIGURE)) {
    const [raw, dollar, whole, fraction, unitRaw] = m;
    const at = m.index ?? 0;
    const end = at + raw.length;
    const unit = (unitRaw ?? '').toLowerCase().replace(/\s/g, '');
    if (/[\p{L}\p{N}_]/u.test(text[end] ?? '')) continue; // "2nd", "4pm", "30min": not a claim
    if (unit === 'm' && unitRaw !== 'M' && !dollar) continue; // "30m" is minutes; "$3m" and "3M" are millions
    const lineStart = text.lastIndexOf('\n', at - 1) + 1;
    if (!dollar && !unit && !fraction && /^[\s\-*•]*$/.test(text.slice(lineStart, at)) && /^[.)](?:\s|$)/.test(text.slice(end, end + 2))) continue; // a list number: "1. "
    const percent = unit === '%' || unit.startsWith('per');
    found.push({
      raw: raw.trim(), base: Number(`${whole!.replaceAll(',', '')}${fraction ? `.${fraction}` : ''}`),
      decimals: fraction?.length ?? 0, scale: UNIT_SCALE[unit] ?? 1, percent, at,
      plain: !unit && !dollar && !fraction && !whole!.includes(','),
    });
  }
  return found;
}

/** Every number in the facts: JSON numbers, and the figures written inside strings. */
function factNumbers(facts: unknown, depth = 0, out: number[] = []): number[] {
  if (depth > 20) return out;
  if (typeof facts === 'number' && Number.isFinite(facts)) out.push(facts);
  else if (typeof facts === 'string') for (const f of figuresIn(facts)) out.push(f.base * f.scale);
  else if (Array.isArray(facts)) for (const item of facts) factNumbers(item, depth + 1, out);
  else if (facts && typeof facts === 'object') for (const item of Object.values(facts)) factNumbers(item, depth + 1, out);
  return out;
}

/** True when `fact` is the figure rounded to the figure's own precision (sign ignored). */
function matches(f: Figure, fact: number): boolean {
  const tolerance = 0.5 * 10 ** -f.decimals + 1e-9;
  const candidates = f.percent ? [fact, fact * 100] : [fact]; // 0.42 as a ratio is "42%"
  return candidates.some((c) => Math.abs(Math.abs(c) / f.scale - f.base) <= tolerance);
}

/** True when the reply states `value` (at the precision it is written, same rules as traceNumbers). */
export function mentions(text: string, value: number): boolean {
  return figuresIn(text).some((f) => matches(f, value));
}

/**
 * The objections to a reply: each number in `text` that is not one of the numbers in `facts`.
 * A number passes when it equals a fact rounded to the number's own decimals (4 for 3.6071, 3.6, 3.61),
 * a percentage passes against a ratio times 100, and "12.4k" passes against 12,400. Year and date
 * mentions, list numbers ("1." at the start of a line) and digits inside words are not claims.
 * Numbers written in words cannot be checked and are objected to.
 */
export function traceNumbers(text: string, facts: unknown): string[] {
  const allowed = factNumbers(facts);
  const objections = new Set<string>();
  for (const word of text.matchAll(WORD_NUMBER)) objections.add(`"${word[0]}" is a number written in words; write it in digits so it can be checked`);
  for (const f of figuresIn(text)) {
    if (allowed.some((fact) => matches(f, fact))) continue;
    const yearLike = f.plain && Number.isInteger(f.base) && f.base >= 1900 && f.base <= 2100;
    if (yearLike && YEAR_CONTEXT.test(text.slice(0, f.at))) continue;
    objections.add(`"${f.raw}" is not in the facts`);
  }
  return [...objections];
}
