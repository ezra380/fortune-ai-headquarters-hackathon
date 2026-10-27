import { randomUUID } from 'node:crypto';
import { WorkReport, type AssistantId, type Receipt, type Suggestion, type WorkStep } from '@fahq/contracts';

// End-of-work reports and the checks the HQ Manager relies on. Everything here is plain code:
//  - buildWorkReport turns a finished task's receipts into a WorkReport. Its suggestions come from
//    RULES about what happened (a failed step, a correction round, a slow step), never from a model.
//  - summarizeUsage adds up report rows (tokens, model calls, seconds) per assistant.
//  - numberTrace is the check on the manager's review and on Code Mode answers: every number a model
//    writes must be a number it was given.

const SLOW_STEP_MS = 60_000;
/** A department's plan writer: finance.plans, salon.plans, online.plans. */
const PLAN_STEP = /^(finance|salon|online)\.plans$/;
const ORDER: readonly AssistantId[] = ['owner', 'finance', 'salon', 'online', 'manager'];

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

// ---- Receipt details that later steps read back ------------------------------------------------

/**
 * The detail a Code Mode step writes on its receipt: parsed back by buildWorkReport. `untraced` is how many
 * numbers of the script's result no tool returned (a script may legitimately add things up): it is reported,
 * never a reason to refuse the result.
 */
export function codeModeDetail(r: { attempts: number; toolCalls: number; resultChars: number; untraced?: number; error?: string | null }): string {
  const untraced = r.untraced === undefined ? '' : `, untraced ${r.untraced}`;
  return `code mode: attempts ${r.attempts}, toolCalls ${r.toolCalls}, resultChars ${r.resultChars}${untraced}${r.error ? `; error: ${clip(r.error, 200)}` : ''}`;
}

function parseCodeMode(detail: string): { attempts: number; toolCalls: number; resultChars: number; error: string | null } | null {
  if (!detail.startsWith('code mode:')) return null;
  const n = (name: string) => Number(new RegExp(`\\b${name} (\\d+)`).exec(detail)?.[1] ?? 0);
  return { attempts: n('attempts'), toolCalls: n('toolCalls'), resultChars: n('resultChars'), error: /; error: (.*)$/.exec(detail)?.[1] ?? null };
}

// ---- Work reports ------------------------------------------------------------------------------

export type ReportTask = { id: string; assistant_id: AssistantId; kind: string };

export function buildWorkReport(input: {
  task: ReportTask;
  outcome: 'done' | 'failed' | 'retrying';
  error: string | null;
  receipts: readonly Receipt[];
  startedAt: Date;
  endedAt: Date;
  /** Defaults to the run id on the receipts; a task that wrote none gets a fresh one. */
  runId?: string;
}): WorkReport {
  const { task, outcome, receipts } = input;
  const endedAt = input.endedAt < input.startedAt ? input.startedAt : input.endedAt;
  const steps: WorkStep[] = receipts.map((r) => ({
    step: r.step,
    outcome: r.outcome,
    model: r.model,
    ms: Math.max(0, Date.parse(r.endedAt) - Date.parse(r.startedAt)),
    inputTokens: r.inputTokens ?? null,
    outputTokens: r.outputTokens ?? null,
    detail: r.detail,
  }));

  const sum = (pick: (s: WorkStep) => number | null) => steps.reduce((total, s) => total + (pick(s) ?? 0), 0);
  const codeSteps = steps.map((s) => parseCodeMode(s.detail ?? '')).filter((c): c is NonNullable<typeof c> => c !== null);
  const usage = {
    modelCalls: steps.filter((s) => s.model !== null).length,
    inputTokens: sum((s) => s.inputTokens),
    outputTokens: sum((s) => s.outputTokens),
    ...(codeSteps.length > 0
      ? { codeMode: {
          scripts: codeSteps.length,
          toolCalls: codeSteps.reduce((t, c) => t + c.toolCalls, 0),
          resultChars: codeSteps.reduce((t, c) => t + c.resultChars, 0),
        } }
      : {}),
  };

  return WorkReport.parse({
    taskId: task.id,
    runId: input.runId ?? receipts[0]?.runId ?? randomUUID(),
    assistant: task.assistant_id,
    taskKind: task.kind,
    outcome,
    summary: summarize(task, outcome, input.error, steps, input.startedAt, endedAt),
    steps: steps.slice(0, 30),
    usage,
    suggestions: suggest(task, outcome, input.error, receipts),
    startedAt: input.startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
  });
}

/** One deterministic sentence: "mailbox task done in 112 s; finance.plans ok (attempt 1 of 2)". */
function summarize(task: ReportTask, outcome: 'done' | 'failed' | 'retrying', error: string | null, steps: WorkStep[], startedAt: Date, endedAt: Date): string {
  const seconds = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);
  const word = outcome === 'retrying' ? 'will retry' : outcome;
  const parts = steps.map((s) => {
    const planAttempt = PLAN_STEP.test(s.step) || s.step === 'manager.review' ? /\battempts (\d+)\b/.exec(s.detail ?? '')?.[1] : undefined;
    return `${s.step} ${s.outcome}${planAttempt ? ` (attempt ${planAttempt} of 2)` : ''}`;
  });
  const shown = parts.length > 6 ? [...parts.slice(0, 6), `and ${parts.length - 6} more`] : parts;
  const tail = shown.length > 0 ? shown.join(', ') : 'no steps recorded';
  const why = outcome !== 'done' && error ? `; ${clip(error, 120)}` : '';
  return clip(`${task.kind} task ${word} in ${seconds} s; ${tail}${why}`, 300);
}

/** Observations from rules, in receipt order. Identical ones are dropped; at most 10. */
function suggest(task: ReportTask, outcome: 'done' | 'failed' | 'retrying', error: string | null, receipts: readonly Receipt[]): Suggestion[] {
  const out: Suggestion[] = [];
  const add = (kind: Suggestion['kind'], about: AssistantId, text: string) => out.push({ kind, about, text: clip(text, 300) });
  let stepFailed = false;

  for (const r of receipts) {
    const about = r.assistantId ?? task.assistant_id;
    const detail = r.detail ?? '';
    const ms = Math.max(0, Date.parse(r.endedAt) - Date.parse(r.startedAt));
    const budget = /\bbudget\b/i.test(detail);
    const code = parseCodeMode(detail);

    if (r.outcome === 'failed') {
      stepFailed = true;
      if (budget) add('cost', about, `${r.step} was stopped by the model budget: ${detail}`);
      else add('reliability', about, `${r.step} failed: ${detail || 'no detail was recorded'}`);
    } else if (r.outcome === 'refused') {
      if (budget) add('cost', about, `${r.step} was refused by the model budget: ${detail}`);
      else if (r.step === 'front-door') add('prompt', about, `The front door's answer did not validate, so the text stayed with ${about}: ${detail || 'no detail was recorded'}`);
      else if (r.step === 'front-door.screen') stepFailed = true; // turning an unsafe text away is the screen working: no suggestion, and the step already explains why the task failed
      else if (r.model !== null) add('prompt', about, `${r.step} was refused: ${detail || 'no detail was recorded'}`);
    }

    // The steps that get one correction round with the checker's exact objections.
    const planner = PLAN_STEP.exec(r.step)?.[1] as AssistantId | undefined;
    if ((planner || r.step === 'manager.review' || r.step === 'owner.synthesis') && r.outcome === 'ok') {
      const attempts = Number(/\battempts (\d+)\b/.exec(detail)?.[1] ?? 1);
      if (attempts >= 2) {
        const first = /first objection: (.*)$/.exec(detail)?.[1] ?? 'not recorded';
        if (planner) add('prompt', planner, `The plan writer needed a correction round. First objection: ${first}`);
        else if (r.step === 'owner.synthesis') add('prompt', 'owner', `The plan picker needed a correction round. First objection: ${first}`);
        else add('prompt', 'manager', `The review writer needed a correction round. First objection: ${first}`);
      }
    }
    if (code && code.attempts >= 2 && r.outcome === 'ok') {
      add('prompt', about, `${r.step}: the script needed ${code.attempts} attempts. Sandbox error: ${code.error ?? 'not recorded'}`);
    }
    if (ms > SLOW_STEP_MS) add('speed', about, `${r.step} took ${Math.round(ms / 1000)} s`);
  }

  // A task can fail outside any step (an unreadable payload, an exception): say so once.
  if (!stepFailed && outcome !== 'done' && error) {
    add('reliability', task.assistant_id, `The task ${outcome === 'failed' ? 'failed' : 'will be retried'}: ${error}`);
  }

  const seen = new Set<string>();
  return out.filter((s) => {
    const key = `${s.kind}|${s.about}|${s.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);
}

// ---- Usage -------------------------------------------------------------------------------------

export type UsageRow = {
  assistant_id: AssistantId;
  outcome: 'done' | 'failed' | 'retrying';
  model_calls: number;
  input_tokens: number;
  output_tokens: number;
  started_at: string;
  ended_at: string;
};
export type UsageLine = {
  tasks: number; done: number; failed: number; retrying: number;
  modelCalls: number; inputTokens: number; outputTokens: number; avgSeconds: number;
};

/** Adds up work reports per assistant (in the fixed assistant order; assistants with no work are left out). */
export function summarizeUsage(rows: readonly UsageRow[], since: Date): { since: string; byAssistant: (UsageLine & { assistant: AssistantId })[]; totals: UsageLine } {
  const line = (subset: readonly UsageRow[]): UsageLine => {
    const seconds = subset.reduce((t, r) => t + Math.max(0, Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000, 0);
    return {
      tasks: subset.length,
      done: subset.filter((r) => r.outcome === 'done').length,
      failed: subset.filter((r) => r.outcome === 'failed').length,
      retrying: subset.filter((r) => r.outcome === 'retrying').length,
      modelCalls: subset.reduce((t, r) => t + r.model_calls, 0),
      inputTokens: subset.reduce((t, r) => t + r.input_tokens, 0),
      outputTokens: subset.reduce((t, r) => t + r.output_tokens, 0),
      avgSeconds: subset.length === 0 ? 0 : Math.round((seconds / subset.length) * 10) / 10,
    };
  };
  return {
    since: since.toISOString(),
    byAssistant: ORDER.filter((a) => rows.some((r) => r.assistant_id === a)).map((assistant) => ({ assistant, ...line(rows.filter((r) => r.assistant_id === assistant)) })),
    totals: line(rows),
  };
}

// ---- The number trace --------------------------------------------------------------------------

// Every number a model writes must be a number it was given. This catches a model that makes figures up;
// it cannot tell whether a real figure was put in the right sentence. Each rule below has a test in
// units.test.ts ("numberTrace"), and docs/manager.md ("The number trace") says the same in plain words.
//
//  - What counts as written: digits (thousands commas, a decimal part, a % k M ms s x suffix); a minus sign
//    in front; and the words zero, one, two and three. Every one counts: 1, 2 and 3 get no pass for being
//    small, ranks or ordinals (7th), and both sides of 7/40 or 7:40 are checked.
//  - Letters glued to digits are a unit and hide nothing (48h, 95sec, 4000tokens, 7kg). Only the suffixes
//    above change the value (1.5k is 1500).
//  - Larger number words (four ... billion, dozen) are refused: write digits, and only if the number is in the data.
//  - What does not count: dates, periods and metric ids (removed first), and digits that belong to a name:
//    right after letters (gpt4, v2), after a hyphen that follows a letter (nemotron-3-ultra), after a dot
//    that follows a letter or digit (v1.2), after an underscore.
//  - What matches: a given number rounded to 0, 1 or 2 decimals equals the written one (112.4 may be written
//    112); a percentage may also match the given number times 100 (0.0512 as 5.12%). A number written with
//    a minus sign must match a negative number in the data. One written without may describe a drop
//    ("fell by 1500" for -1500). In the data only digits count, never number words inside its strings.
//  - Not traced, so not covered: other words for numbers (once, twice, both, half, "no failures").

const BIG_WORDS = /\b(?:four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|dozen)\b/gi;
const SMALL_WORDS = /\b(?:zero|one|two|three)\b/gi;
const SMALL_VALUE = { zero: 0, one: 1, two: 2, three: 3 } as const;
const NUMBER = /(?<![\p{L}\p{N}_]|[\p{L}\p{N}_]\.|\p{L}-)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(%|[kK](?![\p{L}\d])|M(?![\p{L}\d])|(?:ms|s|x|×)(?![\p{L}\d]))?(?!\d)/gu;
// A minus sign (or typographic minus or en dash) right in front of a number, not joined to the end of a word or number
// (so "10-20" and "10–20" are ranges), with an optional currency sign between ("-$1500").
const SIGN_BEFORE = /(?<![\p{L}\p{N}_])[-−–][$£€]?$/u;

function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[​-‍⁠﻿­]/g, '')
    .replace(/\b\d{4}-\d{2}(?:-\d{2})?(?:T[\d:.]+Z?)?\b/g, ' ') // ISO dates, times and periods (2026-09, 2026-10-26T12:00:00Z)
    .replace(/\bm:[a-z0-9_.]+/g, ' '); // metric ids
}

export type TracedNumber = { raw: string; value: number; percent: boolean };

/** The numbers written as digits in already-normalized text. A leading minus sign makes the value negative. */
function digitsIn(text: string): TracedNumber[] {
  const found: TracedNumber[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const [raw, whole, fraction, suffix] = m;
    if (whole === undefined) continue;
    let value = Number(whole.replaceAll(',', '') + (fraction ? `.${fraction}` : ''));
    if (suffix === 'k' || suffix === 'K') value *= 1e3;
    if (suffix === 'M') value *= 1e6;
    if (!Number.isFinite(value)) continue;
    const sign = SIGN_BEFORE.exec(text.slice(0, m.index ?? 0))?.[0].charAt(0) ?? '';
    found.push({ raw: `${sign}${raw}`, value: sign ? -value : value, percent: suffix === '%' });
  }
  return found;
}

/** Every number a text claims: digits first, then zero/one/two/three as words. Larger number words come back in `words`. */
export function numbersWritten(input: string): { found: TracedNumber[]; words: string[] } {
  const text = normalize(input);
  const spoken = [...text.matchAll(SMALL_WORDS)].map((w) => ({ raw: w[0], value: SMALL_VALUE[w[0].toLowerCase() as keyof typeof SMALL_VALUE], percent: false }));
  return { found: [...digitsIn(text), ...spoken], words: [...text.matchAll(BIG_WORDS)].map((w) => w[0]) };
}

/** Every number in a JSON value: numbers, and the digits written inside its strings. Signed. */
export function numbersGiven(source: unknown): number[] {
  const out = new Set<number>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 12) return;
    if (typeof v === 'number' && Number.isFinite(v)) out.add(v);
    else if (typeof v === 'string') for (const n of digitsIn(normalize(v))) out.add(n.value);
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(source, 0);
  return [...out];
}

const roundTo = (x: number, k: number) => Math.round(x * 10 ** k) / 10 ** k;
const same = (given: number, written: number) => [0, 1, 2].some((k) => Math.abs(roundTo(given, k) - written) < 1e-9);

/** A written number with a minus sign must match a negative given number; one without may match either sign. */
function inData(given: readonly number[], n: TracedNumber): boolean {
  return given.some((g) => {
    const compared = n.value < 0 ? g : Math.abs(g);
    return same(compared, n.value) || (n.percent && same(compared * 100, n.value));
  });
}

/** Objections (plain sentences) for every number or number-word in `texts` that `source` does not contain. */
export function numberTrace(texts: readonly (readonly [label: string, text: string])[], source: unknown): string[] {
  const given = numbersGiven(source);
  const objections: string[] = [];
  for (const [label, text] of texts) {
    const { found, words } = numbersWritten(text);
    for (const w of words) objections.push(`${label}: write "${w}" in digits so it can be checked, and only if the number is in the data`);
    for (const n of found) {
      if (!inData(given, n)) objections.push(`${label}: "${n.raw}" is not a number in the data`);
    }
  }
  return objections;
}
