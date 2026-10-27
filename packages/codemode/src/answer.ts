import { isRowId, rowIdsIn, type ModelPort } from '@fahq/contracts';

// The reply step after a Code Mode script: a model turns the script's small facts into a few plain
// sentences, and a program then checks that every number in the reply came from those facts.

/** The rules for any reply that a person reads as a text message. */
export const ANSWER_RULES = [
  'Reply in at most 3 short sentences, written for a text message.',
  'Use only the facts given. Every number must come from the facts.',
  'Write every number in digits, never in words.',
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
  /** For a correction round: what was wrong with the last answer. */
  correction?: string;
}): Promise<{ text: string; inputTokens: number; outputTokens: number; model: string }> {
  const reply = await input.model.chat({
    purpose: input.purpose ?? 'answer',
    model: input.modelId,
    system: `${input.skill}\n\n## How to answer\n${ANSWER_RULES}`,
    user: JSON.stringify({ question: input.question, facts: input.facts, ...(input.correction ? { correction: input.correction } : {}) }),
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

const UNIT_SCALE: Record<string, number> = { k: 1e3, hundred: 1e2, thousand: 1e3, dozen: 12, million: 1e6, m: 1e6, bn: 1e9, billion: 1e9, trillion: 1e12 };
// A figure: an optional $, digits (with commas) or a bare decimal (".9"), then an optional unit. Spaces
// inside a figure are spaces and tabs only, so a figure never reaches across a line break.
const FIGURE = /(?<![\w.])(?:(\$)[ \t]?)?(?:(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?|\.(\d+))(?:[ \t]?(%|percent\b|per[ \t]?cent\b|x\b|×|k\b|hundred\b|thousand\b|million\b|billion\b|trillion\b|dozen\b|bn\b|m\b))?/gi;
// A calendar date (2026-09, 2026-09-15): not a claim. A number range such as 1000-20 is not a date.
const ISO_DATE = /\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?\b/g;

const NUMBER_WORDS = 'zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|(?:hundred|thousand|million|billion|trillion|dozen)s?|couple';
// One or more number words in a row: "seven", "twenty-one", "two thousand and fifty".
const WORD_NUMBER = new RegExp(`\\b(?:${NUMBER_WORDS})(?:[ \\t-]+(?:and[ \\t]+)?(?:${NUMBER_WORDS}))*\\b`, 'gi');
// "one" that is not a count: "no one", "the one with", "one of", "one-time".
const ONE_BEFORE = /\b(?:no|any|every|each|which|the|this|that|another|what)[ \t]+$/i;
const ONE_AFTER = /^(?:[ \t]+(?:of|another)\b|-[a-z])/i;

// What may stand just before a four-digit number for it to be a year and not an amount. A month or a
// quarter is enough; "in" only at the start of a sentence, and "since"/"during" only for a year the
// facts or the question already name (see isDateYear). "May" counts as a month only with a capital.
const MONTH_BEFORE = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?[ \t]+$/i;
const MAY_BEFORE = /\bMay[ \t]+$/;
const QUARTER_BEFORE = /\b(?:q[1-4]|fy)[ \t]+$/i;
const SINCE_BEFORE = /\b(?:since|during|until|through)[ \t]+$/i;
const SENTENCE_IN_BEFORE = /(?:^|[.!?;:,(\n][ \t]*)in[ \t]+$/i;
const YEAR_IN_TEXT = /\b(?:19|20)\d{2}\b/g;

/** What the figure reader and the word reader look at: compatibility forms folded, calendar dates blanked. */
const prepare = (input: string) => input.normalize('NFKC').replace(ISO_DATE, (d) => ' '.repeat(d.length));

/** Every figure in already prepared text. The text is data: nothing in it is ever run. */
function figuresIn(text: string): Figure[] {
  const found: Figure[] = [];
  for (const m of text.matchAll(FIGURE)) {
    const [raw, dollar, whole, fraction, leading, unitRaw] = m;
    const at = m.index ?? 0;
    const end = at + raw.length;
    const unit = (unitRaw ?? '').toLowerCase().replace(/\s/g, '');
    const afterPoint = fraction ?? leading; // "3.6" and ".9" both have digits after the point
    if (/[\p{L}\p{N}_]/u.test(text[end] ?? '')) continue; // "2nd", "4pm", "30min": not a claim
    if (!dollar && !unit && !afterPoint && isRowId(text, end)) continue; // "SUP-2201", "demo-rt-01234": a row's name, not an amount
    const lineStart = text.lastIndexOf('\n', at - 1) + 1;
    if (!dollar && !unit && !afterPoint && /^[\s\-*•]*$/.test(text.slice(lineStart, at)) && /^[.)](?:\s|$)/.test(text.slice(end, end + 2))) continue; // a list number: "1. "
    const percent = unit === '%' || unit.startsWith('per');
    found.push({
      raw: raw.trim(), base: Number(`${(whole ?? '0').replaceAll(',', '')}${afterPoint ? `.${afterPoint}` : ''}`),
      decimals: afterPoint?.length ?? 0, scale: UNIT_SCALE[unit] ?? 1, percent, at,
      plain: !unit && !dollar && !afterPoint && !(whole ?? '').includes(','),
    });
  }
  return found;
}

/** The number words in already prepared text ("seven", "twenty-one"), leaving out the scale word of a figure ("14.8 thousand"). */
function wordsIn(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(WORD_NUMBER)) {
    const at = m.index ?? 0;
    const before = text.slice(0, at);
    if (/\d[ \t]*$/.test(before)) continue; // the figure reader already took it with its number
    if (m[0].toLowerCase() === 'one' && (ONE_BEFORE.test(before) || ONE_AFTER.test(text.slice(at + m[0].length)))) continue;
    found.push(m[0]);
  }
  return found;
}

// ---- Numbers in facts --------------------------------------------------------------------------

const KEY = /^[A-Za-z_$][\w$]*$/;
type Located = { path: string; value: number };

/** Every number in `facts` with where it sits: JSON numbers, and the figures written inside strings. */
function numbersWithPaths(facts: unknown, path: string, out: Located[] = [], depth = 0): Located[] {
  if (depth > 20) return out;
  if (typeof facts === 'number') {
    if (Number.isFinite(facts)) out.push({ path, value: facts });
  } else if (typeof facts === 'string') {
    for (const f of figuresIn(prepare(facts))) out.push({ path, value: f.base * f.scale });
  } else if (Array.isArray(facts)) {
    facts.forEach((item, i) => numbersWithPaths(item, `${path}[${i}]`, out, depth + 1));
  } else if (facts && typeof facts === 'object') {
    for (const [key, item] of Object.entries(facts)) numbersWithPaths(item, KEY.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`, out, depth + 1);
  }
  return out;
}

const factNumbers = (facts: unknown) => numbersWithPaths(facts, '').map((n) => n.value);

/** Every string value anywhere in some text or data (not its keys). */
function stringsIn(data: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 20) return out;
  if (typeof data === 'string') out.push(data);
  else if (Array.isArray(data)) for (const item of data) stringsIn(item, out, depth + 1);
  else if (data && typeof data === 'object') for (const item of Object.values(data)) stringsIn(item, out, depth + 1);
  return out;
}

/** The years named anywhere in some text or data (as dates inside strings, such as "2026-09"). */
const yearsIn = (data: unknown) => new Set(stringsIn(data).flatMap((s) => [...s.matchAll(YEAR_IN_TEXT)].map((m) => Number(m[0]))));

/** The row ids the facts' strings hold, lowercased (an id is the same row in any case). */
const rowIdsGiven = (facts: unknown) => new Set(stringsIn(facts).flatMap((s) => rowIdsIn(prepare(s))).map((id) => id.toLowerCase()));

/** True when `f` is `fact` rounded to the figure's own precision (sign ignored). */
function matches(f: Figure, fact: number): boolean {
  const tolerance = 0.5 * 10 ** -f.decimals + 1e-9;
  const candidates = f.percent ? [fact, fact * 100] : [fact]; // 0.42 as a ratio is "42%"
  return candidates.some((c) => Math.abs(Math.abs(c) / f.scale - f.base) <= tolerance);
}

/** True when the reply states `value` (at the precision it is written, same rules as traceNumbers). */
export function mentions(text: string, value: number): boolean {
  return figuresIn(prepare(text)).some((f) => matches(f, value));
}

/** A four-digit number is a year, not an amount, only in a date context (see the patterns above). */
function isDateYear(before: string, year: number, named: ReadonlySet<number>): boolean {
  if (MONTH_BEFORE.test(before) || MAY_BEFORE.test(before) || QUARTER_BEFORE.test(before)) return true;
  return named.has(year) && (SINCE_BEFORE.test(before) || SENTENCE_IN_BEFORE.test(before));
}

/**
 * The objections to a reply: each number in `text` that is not one of the numbers in `facts`.
 * A number passes when it equals a fact rounded to the number's own decimals (4 for 3.6071, 3.6, 3.61),
 * a percentage passes against a ratio times 100, and "12.4k" passes against 12,400. A figure may start
 * with a decimal point (".9" is 0.9) and a lowercase "m" after a number is millions ("30m"); minutes
 * must be written "min" or "minutes".
 *
 * Not claims: list numbers ("1." at the start of a line, after any punctuation), digits inside words
 * ("2nd", "4pm", "30min"), the digits that close a row id ("SUP-2201", "demo-rt-01234"; isRowId in
 * @fahq/contracts, so "high-35%" and "ROAS-9.5x" are still read; the id itself must be in a string of the facts,
 * in any case, or it is objected to), calendar dates (2026-09, 2026-09-15),
 * and a four-digit year in a real date context: right after a month or a quarter ("September 2026",
 * "Q3 2026"), or after "since", "during" or a sentence-opening "In" when the facts (or `context`, such as the question) name that year.
 * Every other number from 1900 to 2100 is an amount like any other ("spend of 1950", "brought in 1999").
 *
 * Numbers written in words (zero to ninety, twenty-one, hundred, dozen, "a couple of", ...) cannot be
 * checked and are objected to, so the reply must use digits. Ordinals in words ("first") are not objected to.
 */
export function traceNumbers(text: string, facts: unknown, context?: unknown): string[] {
  const prepared = prepare(text);
  const allowed = factNumbers(facts);
  const named = yearsIn([facts, context]);
  const objections = new Set<string>();
  for (const word of wordsIn(prepared)) objections.add(`"${word}" is a number written in words; write it in digits so it can be checked`);
  for (const f of figuresIn(prepared)) {
    if (allowed.some((fact) => matches(f, fact))) continue;
    const yearLike = f.plain && Number.isInteger(f.base) && f.base >= 1900 && f.base <= 2100;
    if (yearLike && isDateYear(prepared.slice(0, f.at), f.base, named)) continue;
    objections.add(`"${f.raw}" is not in the facts`);
  }
  const ids = rowIdsGiven(facts);
  for (const id of rowIdsIn(prepared)) if (!ids.has(id.toLowerCase())) objections.add(`"${id}" is not in the facts`);
  return [...objections];
}

// ---- Tracing a script's result back to the tools ------------------------------------------------

/** True when a tool returned `n`, either exactly or rounded to 0, 1 or 2 decimals (sign ignored). */
function returnedBy(n: number, returned: readonly number[]): boolean {
  const a = Math.abs(n);
  const close = (x: number, y: number) => Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(y));
  return returned.some((t) => {
    const b = Math.abs(t);
    return close(a, b) || [0, 1, 2].some((d) => close(a, Math.round(b * 10 ** d) / 10 ** d));
  });
}

/**
 * The numbers in a Code Mode result that no tool returned, as plain sentences with where each one sits
 * ("result.revenue (99999) was not returned by any tool"). A number a tool returned passes as it is or
 * rounded to 0 to 2 decimals. The rest is either arithmetic the script did (a ratio, a sum) or a number
 * the script typed itself: this cannot tell which, so it shows the worker what to look at, next to the
 * script, and never proves a number wrong. `toolOutputs` is `CodeModeResult.toolOutputs`.
 */
export function untracedResultNumbers(result: unknown, toolOutputs: readonly { output: unknown }[]): string[] {
  const returned = toolOutputs.flatMap((o) => factNumbers(o.output));
  return numbersWithPaths(result, 'result')
    .filter((n) => !returnedBy(n.value, returned))
    .map((n) => `${n.path} (${n.value}) was not returned by any tool`);
}
