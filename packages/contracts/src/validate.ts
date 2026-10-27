import { ProfitPlans as ProfitPlansSchema } from './schemas.ts';
import type { BusinessUnit, Metric, Plan, ProfitPlans } from './schemas.ts';

// "No invented numbers": every number a plan states must trace to a Zetaris metric.
//  - Evidence must equal the metric it cites (within 0.1%).
//  - A projection must equal its base metric × its factor (within 0.2%).
//  - Every free-text field is scanned (title, summary, actions, test, stop-loss, risks, projection
//    labels and assumptions, evidence notes, lever labels, memory notes). Each number found must match
//    a value of the same kind: a dollar amount a dollar value, a percentage a percentage, "2.4x" a
//    ratio, a bare number of 100 or more a dollar or count value, a bare decimal ("1.35") one of those or a
//    ratio. Allowed values are cited metrics,
//    projection inputs and results, and levers (a proposed price, discount, budget or count: a
//    choice, not a fact). Durations ("90 days"), years ("in 2026") and ids ("demo-rt-01234") are not claims.
//  - A small count (under 100) is a claim when the words after it name what a cited count metric counts
//    ("3 overdue invoices", "3 of the overdue invoices"): it must then be THAT count's value, one of its own
//    projections, or a count lever. The phrases come from the data's catalog (`nouns`); the most specific one
//    wins ("late repairs" over "repairs"), and a phrase two cited counts with different values share is refused
//    until the plan names which. Without the catalog's phrases small counts are not checked.
//  - A seasonal budget (an approved cap's projection, once the plan cites last year's index or the projection names
//    the season) must use the index's value as its factor.
//  - Numbers in words ("twelve thousand dollars") and digits the scanner cannot read are refused,
//    never skipped.
//  - A plan declares which businesses it touches and cites numbers from exactly those. One sentence
//    never mixes salon and online numbers, and salon and online are never summed, unless a labeled
//    `m:combined.*` metric is cited.

export type PlanCheck =
  | { ok: true; plans: ProfitPlans; citedMetricIds: string[] }
  | { ok: false; errors: string[] };

type Kind = 'usd' | 'percent' | 'ratio' | 'count';
/** An allowed value; `business` null means a lever (a proposed setting, not tied to either business). */
type Allowed = { value: number; kind: Kind; business: BusinessUnit | null };

// Outcome words: a lever named like this is a result dressed as a choice. A target ROAS or a minimum
// margin is a real setting (Nemotron proposed "Target Google ROAS" live), so those stay allowed.
const RESULT_WORDS = /\b(profit|revenue|sales|income|gain|uplift|expected|projected|forecast|estimated|total|combined|savings?)\b/i;
// Phrases that name both businesses. Not "combined" or "together" alone: live plans use them for
// levers ("the combined effect of ads and email"), which is not a salon + online figure.
const COMBINING_WORDS = /\b(both businesses|salon and online|online and salon|salon \+ online|online \+ salon|salon plus online|online plus salon|across both|whole company|company-wide)\b/i;

// A seasonal budget: an approved ad budget cap, and the index its factor must be.
const BUDGET_CAP = /^m:online\.budget\.[a-z]+\.cap$/;
const SEASON_INDEX = 'm:online.season.last_year_index';

/** For each count metric, the phrases that name what it counts (from the data's catalog): "late repairs", "repairs". */
export type CountNouns = ReadonlyMap<string, readonly string[]>;
/** A count metric a plan cites: its value, its own projection results and the phrases that name it, word by word. */
type CitedCount = { id: string; value: number; results: number[]; phrases: string[][] };

export function checkPlans(raw: unknown, metrics: readonly Metric[], nouns: CountNouns = new Map()): PlanCheck {
  const parsed = ProfitPlansSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || 'plans'}: ${i.message}`),
    };
  }
  const byId = new Map(metrics.map((m) => [m.id, m]));
  const errors: string[] = [];
  const cited = new Set<string>();
  const ranks = parsed.data.plans.map((p) => p.rank).sort((a, b) => a - b);
  if (ranks.join(',') !== '1,2,3') errors.push('plans must be ranked 1, 2 and 3, once each');
  const everyPool: Allowed[] = [];
  for (const plan of parsed.data.plans) everyPool.push(...checkPlan(plan, { byId, nouns }, errors, cited));
  for (const c of parsed.data.memoryConflicts) checkText(`memory note ${c.memoryId}`, c.note, everyPool, errors);
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, plans: parsed.data, citedMetricIds: [...cited] };
}

function checkPlan(
  plan: Plan,
  data: { byId: ReadonlyMap<string, Metric>; nouns: CountNouns },
  errors: string[],
  cited: Set<string>,
): Allowed[] {
  const { byId } = data;
  const where = `plan ${plan.rank}`;
  const pool = poolOf(plan, byId);
  const units = new Set<BusinessUnit>();
  const citedValues: { value: number; business: BusinessUnit }[] = [];
  // The plan's cited counts that the catalog names: a small number next to one of their phrases is a claim.
  const counts = new Map<string, CitedCount>();

  const useMetric = (m: Metric) => {
    cited.add(m.id);
    units.add(m.business);
    const phrases = m.unit === 'count' ? data.nouns.get(m.id) ?? [] : [];
    if (phrases.length > 0 && !counts.has(m.id)) {
      counts.set(m.id, { id: m.id, value: m.value, results: [], phrases: phrases.map((p) => p.toLowerCase().split(/\s+/).filter(Boolean)) });
    }
    const prefix = m.id.split(':')[1]?.split('.')[0];
    if (prefix !== m.business) errors.push(`${where}: metric ${m.id} is labeled ${m.business}, not ${prefix}`);
  };

  for (const e of plan.evidence) {
    const m = byId.get(e.metricId);
    if (!m) {
      errors.push(`${where}: evidence cites unknown metric ${e.metricId}`);
      continue;
    }
    useMetric(m);
    if (!close(e.value, m.value, 0.001)) {
      errors.push(`${where}: evidence ${m.id} says ${e.value} but the source says ${m.value}`);
    }
    citedValues.push({ value: m.value, business: m.business });
  }

  const citesIndex = plan.evidence.some((e) => e.metricId === SEASON_INDEX) || plan.projections.some((p) => p.baseMetricId === SEASON_INDEX);
  for (const p of plan.projections) {
    const m = byId.get(p.baseMetricId);
    if (!m) {
      errors.push(`${where}: projection "${p.label}" uses unknown metric ${p.baseMetricId}`);
      continue;
    }
    useMetric(m);
    counts.get(m.id)?.results.push(p.result);
    const expected = m.value * p.factor;
    if (!close(p.result, expected, 0.002)) {
      errors.push(`${where}: projection "${p.label}" says ${p.result} but ${m.id} × ${p.factor} = ${round2(expected)}`);
    }
    // A seasonal budget is the approved cap × last year's index for the month (PLAN_SYSTEM rule 2): once a plan
    // cites the index, or a cap projection names the season, the cap's factor must be the index's value.
    if (BUDGET_CAP.test(m.id) && (citesIndex || /\bseason/i.test(`${p.label} ${p.assumption}`))) {
      const index = byId.get(SEASON_INDEX);
      if (!citesIndex || !index) errors.push(`${where}: projection "${p.label}" is a seasonal budget, so cite ${SEASON_INDEX} and use its value as the factor`);
      else if (!close(p.factor, index.value, 0.001)) errors.push(`${where}: projection "${p.label}" multiplies ${m.id} by ${p.factor}, but a seasonal budget's factor is ${SEASON_INDEX} (${index.value})`);
    }
    if (m.business !== 'combined' && COMBINING_WORDS.test(`${p.label} ${p.assumption}`)) {
      errors.push(`${where}: projection "${p.label}" reads as a salon + online figure but its base is ${m.business} only`);
    }
    citedValues.push({ value: m.value, business: m.business });
  }

  // Levers are the plan's own proposed settings: allowed in the text, shown as choices, never as facts.
  for (const l of plan.levers) {
    if (RESULT_WORDS.test(l.label)) {
      errors.push(`${where}: lever "${l.label}" reads as a result; a lever is a setting you choose (a price, a discount, a budget, a number of slots, a threshold)`);
    }
    if (l.unit === 'usd' || l.unit === 'count') {
      for (const [i, a] of citedValues.entries()) {
        for (const b of citedValues.slice(i + 1)) {
          if (close(l.value, a.value + b.value, 0.002) || close(l.value, Math.abs(a.value - b.value), 0.002)) {
            errors.push(`${where}: lever "${l.label}" (${l.value}) is a sum or difference of cited numbers, not a choice`);
          }
        }
      }
    }
  }

  const declared = new Set(plan.businesses);
  for (const u of units) {
    if (!declared.has(u)) errors.push(`${where}: cites ${u} numbers but does not list "${u}" in businesses`);
  }
  for (const u of declared) {
    if (!units.has(u)) errors.push(`${where}: lists "${u}" but cites no ${u} numbers`);
  }

  const texts: [string, string][] = [
    ['title', plan.title], ['summary', plan.summary], ['test', plan.test], ['stop-loss', plan.stopLoss],
    ...plan.actions.map((a, i): [string, string] => [`action ${i + 1}`, a]),
    ...plan.risks.map((r, i): [string, string] => [`risk ${i + 1}`, r]),
    ...plan.projections.flatMap((p, i): [string, string][] => [[`projection ${i + 1} label`, p.label], [`projection ${i + 1} assumption`, p.assumption]]),
    ...plan.evidence.flatMap((e, i): [string, string][] => (e.note ? [[`evidence ${i + 1} note`, e.note]] : [])),
    ...plan.levers.map((l, i): [string, string] => [`lever ${i + 1} label`, l.label]),
  ];
  for (const [field, text] of texts) checkText(`${where} ${field}`, text, pool, errors, [...counts.values()]);
  return pool;
}

function checkText(where: string, text: string, pool: readonly Allowed[], errors: string[], counts: readonly CitedCount[] = []): void {
  const { found, unreadable, small } = scan(text);
  for (const u of unreadable) errors.push(`${where}: "${u}" is a number the checker cannot read; write it in digits`);
  const levers = pool.filter((a) => a.business === null && a.kind === 'count');
  for (const n of small) {
    const named = countsNamed(n.next, counts);
    if (!named || levers.some((a) => close(n.value, a.value, 0))) continue; // names no cited count, or is a choice
    const said = `"${[n.raw, ...n.next.slice(0, named.end + 1)].join(' ')}"`;
    const [first] = named.counts;
    if (new Set(named.counts.map((c) => c.value)).size > 1) {
      const which = named.counts.map((c) => `"${ownPhrase(c, named.counts)}"`).join(' or ');
      errors.push(`${where}: ${said} could be ${named.counts.map((c) => `${c.id} (${c.value})`).join(' or ')}; name which, as in ${which}`);
    } else if (first && !named.counts.some((c) => [c.value, ...c.results].some((v) => close(n.value, v, 0)))) {
      errors.push(`${where}: ${said} counts what ${first.id} counts, so it must be its value (${first.value}), one of its projections or a count lever`);
    }
  }
  for (const sentence of splitSentences(found)) {
    for (const n of sentence) {
      if (!pool.some((a) => accepts(n, a))) errors.push(`${where}: "${n.raw}" in the text is not one of its cited or projected numbers`);
    }
    if (mixesBusinesses(sentence, pool)) {
      errors.push(`${where}: one sentence mixes salon and online numbers (${sentence.map((n) => n.raw).join(', ')})`);
    }
  }
}

/** A count's first qualified phrase that none of the others shares, to suggest when a plan must say which it means. */
function ownPhrase(c: CitedCount, others: readonly CitedCount[]): string {
  const shared = new Set(others.filter((o) => o !== c).flatMap((o) => o.phrases.map((p) => p.join(' '))));
  return c.phrases.map((p) => p.join(' ')).find((p) => p.includes(' ') && !shared.has(p)) ?? c.id;
}

/**
 * Does one sentence hold a number only salon values could be next to a number only online values could be?
 * A number that matches nothing is somebody else's error; one that matches a lever or a combined metric is
 * neither business's, so it is left out.
 */
function mixesBusinesses(sentence: readonly FoundNumber[], pool: readonly Allowed[]): boolean {
  const owners: Set<BusinessUnit>[] = [];
  for (const n of sentence) {
    const matches = pool.filter((a) => accepts(n, a));
    if (matches.length === 0) continue;
    if (matches.some((a) => a.business === null || a.business === 'combined')) continue; // a lever or a combined metric
    owners.push(new Set(matches.map((a) => a.business as BusinessUnit)));
  }
  const definite = owners.filter((o) => o.size === 1).map((o) => [...o][0]);
  return definite.includes('salon') && definite.includes('online');
}

/**
 * The sentences of `text` (a reason, a note) that put a salon number next to an online number, judged against
 * what the given plans cite: each number belongs to the business of the metric it traces to, through the
 * plan's evidence and projections (their ratio and percent forms included). That is the same rule a plan's own
 * text passes, so a plan that cites both businesses is held to it too. A lever (a setting the plan proposes)
 * belongs to its plan's business when the plan touches only one, and to neither when it touches both.
 * Returns the numbers written in each offending sentence. A number the plans do not hold is not judged here.
 */
export function mixedSentences(text: string, plans: readonly Plan[], metrics: readonly Metric[]): string[][] {
  const byId = new Map(metrics.map((m) => [m.id, m]));
  const pool = plans.flatMap((plan) => poolOf(plan, byId).map((a): Allowed =>
    (a.business === null && plan.businesses.length === 1 ? { ...a, business: plan.businesses[0]! } : a)));
  return splitSentences(scan(text).found).filter((sentence) => mixesBusinesses(sentence, pool)).map((sentence) => sentence.map((n) => n.raw));
}

/**
 * Every value a plan may quote in its text, each tied to a business: its cited metrics, its projections
 * (base, result, and the factor as a ratio and as percentages) and its levers (tied to none). A metric the
 * list does not hold is left out; the plan's own check reports it.
 */
function poolOf(plan: Plan, byId: ReadonlyMap<string, Metric>): Allowed[] {
  const pool: Allowed[] = [];
  const allow = (value: number, unit: Metric['unit'], business: BusinessUnit | null) => {
    if (unit === 'ratio') pool.push({ value, kind: 'ratio', business }, { value: value * 100, kind: 'percent', business });
    else pool.push({ value, kind: unit === 'percent' ? 'percent' : unit === 'usd' ? 'usd' : 'count', business });
  };
  for (const e of plan.evidence) {
    const m = byId.get(e.metricId);
    if (m) allow(m.value, m.unit, m.business);
  }
  for (const p of plan.projections) {
    const m = byId.get(p.baseMetricId);
    if (!m) continue;
    allow(m.value, m.unit, m.business);
    allow(p.result, m.unit, m.business);
    for (const pct of [p.factor * 100, (p.factor - 1) * 100, (1 - p.factor) * 100]) pool.push({ value: pct, kind: 'percent', business: m.business });
    pool.push({ value: p.factor, kind: 'ratio', business: m.business });
  }
  for (const l of plan.levers) {
    const kind: Kind = l.unit === 'percent' ? 'percent' : l.unit === 'usd' ? 'usd' : l.unit === 'ratio' ? 'ratio' : 'count';
    pool.push({ value: l.value, kind, business: null });
  }
  return pool;
}

function accepts(n: FoundNumber, a: Allowed): boolean {
  // A negative value may be quoted as a size ("a loss of $3,000" for -3,000); a positive one never as negative.
  const same = (x: number, y: number, rel: number) => close(x, y, rel) || (y < 0 && close(Math.abs(x), Math.abs(y), rel));
  switch (n.kind) {
    case 'usd': return a.kind === 'usd' && same(n.value, a.value, 0.01);
    case 'percent': return a.kind === 'percent' && (Math.abs(n.value - a.value) <= 0.5 || same(n.value, a.value, 0.02));
    case 'ratio': return a.kind === 'ratio' && same(n.value, a.value, 0.01);
    // A bare decimal may also be a ratio written without its "x" (an index of 1.35).
    case 'plain': return (a.kind === 'usd' || a.kind === 'count' || (a.kind === 'ratio' && !Number.isInteger(n.value))) && same(n.value, a.value, 0.01);
  }
}

// ---- Finding numbers in text -------------------------------------------------------------------

export type FoundNumber = { raw: string; value: number; percent: boolean; kind: 'usd' | 'percent' | 'ratio' | 'plain'; at: number; sentence: number };

const MONTHS = 'jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december';
const YEAR_BEFORE = new RegExp(`(?:\\b(?:in|since|by|until|before|after|during|of|from|through|to|year|fy|q[1-4]|${MONTHS})\\s*)$`, 'i');
const TIME_AFTER = /^[\s-]*(?:days?|weeks?|months?|hours?|hrs?|minutes?|mins?|years?|yrs?|nights?|weekends?|am|pm)\b/i;
const WORD_NUMBERS = /\b(?:(?:a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|a few|several|a couple of|half a)[\s-]+(?:hundred|thousand|million|billion|percent|per cent|dollars?|grand))\b/gi;

const NUMBER = /(\$\s?)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:e(\d{1,2}))?(?:\s?(%|percent\b|per\s?cent\b|pct\b|percentage points?\b|k\b|thousand\b|grand\b|M\b|mn\b|million\b|B\b|bn\b|billion\b|x\b|×))?(?:\s?(dollars?\b|usd\b|bucks\b))?/gi;

const MAGNITUDE: Record<string, number> = { k: 1e3, thousand: 1e3, grand: 1e3, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };

function normalize(text: string): string {
  return text
    .normalize('NFKC') // full-width digits and signs become ASCII
    .replace(/[​-‍⁠﻿­]/g, '') // zero-width characters and soft hyphens
    .replace(/(\d)[    ](?=\d{3}(?!\d))/g, '$1,') // 45 000 with a no-break space
    .replace(/(^|[^\d,.])(\d{1,3}) (?=\d{3}(?![\d,.]))/g, '$1$2,') // 45 000 with a plain space
    .replace(/\$\s?-\s?(?=\d)/g, '-$') // $-3,000 reads as -$3,000
    .replace(/[‒-―−]/g, '-') // dashes and the minus sign
    .replace(/\b\d{4}-\d{2}(?:-\d{2})?\b/g, ' '); // ISO dates and periods (2026-09)
}

/** Numbers that read as claims: money, percentages, ratios, and bare numbers of 100 or more. */
export function numbersIn(text: string): FoundNumber[] {
  return scan(text).found;
}

/** A plain number under 100 (not a duration or a year) and the words after it that can name what it counts. */
type SmallCount = { raw: string; value: number; next: string[] };

// What a small number counts is named by the words right after it: up to four, past a lead-in ("3 of the overdue
// invoices"), up to a clause break, another number or a joining word ("call 2 owners about the repairs" counts owners).
const LEAD_IN = new Set(['of', 'the', 'these', 'those', 'our', 'your', 'its', 'their', 'all', 'still', 'other']);
const JOINING = new Set([
  'of', 'about', 'for', 'with', 'and', 'or', 'but', 'to', 'from', 'by', 'in', 'on', 'at', 'per', 'a', 'an', 'each', 'who', 'whose',
  'that', 'which', 'so', 'then', 'than', 'into', 'over', 'under', 'while', 'when', 'if', 'before', 'after',
]);
function nextWords(after: string): string[] {
  const clause = after.split(/[.,;:!?()[\]\n\d]/)[0] ?? '';
  const words = (clause.match(/\p{L}[\p{L}'-]*/gu) ?? []).map((w) => w.toLowerCase());
  let start = 0;
  while (start < words.length && LEAD_IN.has(words[start]!)) start++;
  const end = words.findIndex((w, i) => i >= start && JOINING.has(w));
  return words.slice(start, end === -1 ? undefined : end).slice(0, 4);
}

/**
 * The cited counts the words after a small number name: those whose most specific phrase fits (its words in
 * order among them), and where the last matched word sits. Null when no cited count's phrase fits.
 */
function countsNamed(words: readonly string[], counts: readonly CitedCount[]): { counts: CitedCount[]; end: number } | null {
  const fit = (phrase: readonly string[]) => {
    let i = 0;
    let end = -1;
    for (const [at, w] of words.entries()) {
      if (i < phrase.length && w === phrase[i]) {
        i++;
        end = at;
      }
    }
    return i === phrase.length ? { size: i, end } : null;
  };
  const best = counts.map((c) => {
    const [top] = c.phrases.map(fit).filter((f) => f !== null).sort((a, b) => b.size - a.size);
    return { c, size: top?.size ?? 0, end: top?.end ?? -1 };
  });
  const size = Math.max(0, ...best.map((b) => b.size));
  if (size === 0) return null;
  const top = best.filter((b) => b.size === size);
  return { counts: top.map((b) => b.c), end: Math.max(...top.map((b) => b.end)) };
}

function scan(input: string): { found: FoundNumber[]; unreadable: string[]; small: SmallCount[] } {
  const text = normalize(input);
  const unreadable = [...text.matchAll(WORD_NUMBERS)].map((m) => m[0]);
  for (const m of text.matchAll(/\p{Nd}+/gu)) if (/[^0-9]/.test(m[0])) unreadable.push(m[0]);

  type Raw = { raw: string; at: number; end: number; dollar: boolean; base: number; unit: string; currencyWord: boolean; plainInt: boolean };
  const raws: Raw[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const at = m.index ?? 0;
    const prev = text[at - 1] ?? '';
    if (/[\p{L}_.:\d]/u.test(prev)) continue; // part of a word, an id or a version ("Q4", "m:online", "v1.2")
    const [raw, dollar, whole, fraction, exponent, unitRaw, currencyWord] = m;
    if (whole === undefined) continue;
    if (!dollar && !unitRaw && !currencyWord && !fraction && !exponent && isRowId(text, at + whole.length)) continue;
    let base = Number(whole.replaceAll(',', '') + (fraction ?? ''));
    if (exponent) base *= 10 ** Number(exponent);
    if (!Number.isFinite(base)) continue;
    let unit = (unitRaw ?? '').toLowerCase().replace(/\s/g, '');
    if (unit === 'm' && unitRaw !== 'M' && !dollar) unit = ''; // "30m" may be minutes; "$3m" and "3M" are millions
    raws.push({ raw: raw.trimEnd(), at, end: at + raw.trimEnd().length, dollar: Boolean(dollar), base, unit, currencyWord: Boolean(currencyWord), plainInt: !fraction && !exponent && !whole.includes(',') });
  }

  // Ranges ("10-20%", "$20-30k", "between 10 and 20 percent"): both ends are claims and share units.
  for (let i = 0; i + 1 < raws.length; i++) {
    const a = raws[i]!;
    const b = raws[i + 1]!;
    if (!/^\s*(?:-|to|and)\s*\$?\s*$/i.test(text.slice(a.end, b.at))) continue;
    if (!a.unit && b.unit) a.unit = b.unit;
    if (!a.dollar && !a.currencyWord && (b.dollar || b.currencyWord)) a.dollar = true;
    if (!b.dollar && a.dollar && b.unit !== '%' && !b.unit.startsWith('per')) b.dollar = true;
  }

  const found: FoundNumber[] = [];
  const small: SmallCount[] = [];
  for (const r of raws) {
    const isPercent = r.unit === '%' || r.unit.startsWith('percent') || r.unit.startsWith('per') || r.unit === 'pct';
    const isRatio = r.unit === 'x' || r.unit === '×';
    const money = r.dollar || r.currencyWord;
    let value = r.base * (MAGNITUDE[r.unit] ?? 1);
    // A minus sign counts only at the start of a figure ("-$300", "( -5%"), never between two numbers.
    const before = text.slice(0, r.at).replace(/\$\s?$/, '');
    if (/(?:^|[\s(])-\s?$/.test(before)) value = -value;
    const after = text.slice(r.end);
    const plain = !money && !isPercent && !isRatio && !(r.unit in MAGNITUDE);
    if (plain && TIME_AFTER.test(after)) continue; // a duration
    if (plain && r.plainInt && r.base >= 1900 && r.base <= 2100 && YEAR_BEFORE.test(text.slice(0, r.at))) continue; // a year
    // Small whole numbers ("3 plans"): a claim only next to a cited count's phrase. A bare decimal ("1.35") is a claim.
    if (plain && r.plainInt && Math.abs(value) < 100) {
      small.push({ raw: r.raw, value, next: nextWords(after) });
      continue;
    }
    const kind = money ? 'usd' : isPercent ? 'percent' : isRatio ? 'ratio' : 'plain';
    found.push({ raw: r.raw, value, percent: kind === 'percent', kind, at: r.at, sentence: sentenceIndex(text, r.at) });
  }
  return { found, unreadable, small };
}

// Row ids are names, not amounts (design 4e): a synthetic row's id ("demo-rt-01234", "demo-s-3") and a supplier
// number ("SUP-2201"). Only bare digits that end such an id exactly are skipped, so "a sub-$5,000 test", "mid-30%",
// "ROAS-9.5x" and "the top-100 buyers" are still read (review 2026-10-27).
const ROW_ID = /(?:^|[^\p{L}\p{N}_-])(?:demo(?:-[a-z]+)+-[a-z]*|sup-)\d+$/iu;
const ID_END = /^(?:$|[\s,;:)!?]|\.(?:\s|$))/;

/** Do the digits ending at `end` close a row id, with nothing glued after them? */
function isRowId(text: string, end: number): boolean {
  return ROW_ID.test(text.slice(0, end)) && ID_END.test(text.slice(end));
}

function sentenceIndex(text: string, at: number): number {
  return (text.slice(0, at).match(/[.!?;\n](?:\s|$)/g) ?? []).length;
}

function splitSentences(found: readonly FoundNumber[]): FoundNumber[][] {
  const groups = new Map<number, FoundNumber[]>();
  for (const n of found) groups.set(n.sentence, [...(groups.get(n.sentence) ?? []), n]);
  return [...groups.values()];
}

function close(a: number, b: number, relative: number): boolean {
  return Math.abs(a - b) <= Math.max(0.01, relative * Math.abs(b));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
