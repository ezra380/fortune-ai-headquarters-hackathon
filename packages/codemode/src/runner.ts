import type { CodeModeResult, CodeModeRunner, ModelPort, ReadTool, ToolOutput } from '@fahq/contracts';
import { ModelError, stripReasoning } from '@fahq/models';
import { QuickJsExecutor, type ExecuteResult } from './quickjs-executor.ts';

// Cloudflare Code Mode inside the worker. A model writes ONE script against an assistant's typed
// read API; the QuickJS sandbox runs it with only those tools; only the script's small result goes on
// to the next model. The raw tool output (hundreds of metrics, whole timelines) never reaches a prompt.
// One retry with the sandbox's own error, then a plain failure. This function never throws.
//
// A script that read nothing has typed its own numbers, so a run in which no tool returned data is
// refused. The runner also keeps what each tool returned (`toolOutputs`) so the worker can check the
// result and the reply against it: it cannot tell arithmetic from a typed constant, but it can show
// which numbers no tool returned (`untracedResultNumbers`).

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
// `async (`, `async function name(` or `async x =>`: not the word "async" in a sentence.
const SCRIPT_START = /\basync\s*(?:\(|function\b[^(\n]*\(|[A-Za-z_$][\w$]*\s*=>)/;
const MAX_ATTEMPTS = 2;
const SCRIPT_TOKENS = 1200;

const oneLine = (text: string) => text.replace(/\s+/g, ' ').replaceAll('*/', '* /').trim();

/** The read API as TypeScript declarations: the only thing the model is told it can call. */
export function declarations(tools: readonly ReadTool[]): string {
  const members = tools.flatMap((t) => [`  /** ${oneLine(t.description)} */`, `  ${t.name}: ${t.signature.trim()};`]);
  return `declare const codemode: {\n${members.join('\n')}\n}`;
}

function systemPrompt(skill: string, tools: readonly ReadTool[]): string {
  const first = tools[0];
  const args = first && /\bperiod\b/.test(first.signature) ? '{ period: "2026-09" }' : '{}';
  return [
    skill,
    '',
    '## Your read-only API',
    '```ts',
    declarations(tools),
    '```',
    '',
    '## How to answer',
    `Write ONE JavaScript async arrow function that answers the question, for example: async () => { const r = await codemode.${first?.name ?? 'tool_name'}(${args}); ...; return { ... }; }`,
    '- Plain JavaScript only: no TypeScript annotations, no imports, no require, no fetch, no timers.',
    '- Use only the functions declared above. Do the filtering and the arithmetic in code.',
    '- Return ONE small plain object that holds only the values needed: at most 40 values, readable keys, numbers as numbers.',
    '- Output only the function. No explanation.',
  ].join('\n');
}

/** The function in a model reply: drops reasoning and fences, then takes the text from the first `async`. */
export function extractScript(reply: string): string | null {
  let text = stripReasoning(reply);
  const fenced = /```[a-zA-Z]*\n([\s\S]*?)```/.exec(text);
  text = fenced ? fenced[1]! : text.replace(/```[a-zA-Z]*/g, '');
  const start = text.search(SCRIPT_START);
  if (start < 0) return null;
  return text.slice(start).trim().replace(/[;\s]+$/, '') || null;
}

function toolProblem(tools: readonly ReadTool[]): string | null {
  const seen = new Set<string>();
  for (const t of tools) {
    if (!IDENTIFIER.test(t.name)) return `read tool "${t.name}" is not a valid function name`;
    if (seen.has(t.name)) return `read tool "${t.name}" is listed twice`;
    seen.add(t.name);
  }
  return null;
}

const isEmpty = (v: unknown) =>
  v === undefined || v === null || v === '' || (typeof v === 'object' && Object.keys(v).length === 0);

type Verdict = { ok: true; chars: number } | { ok: false; error: string; chars: number };

const NEEDS_TOOL_DATA = 'the script used no tool data: call at least one codemode function; every number must come from it';

/** `reads` is how many tool calls returned data to the script (a refused or failed call is not one). */
function judge(run: ExecuteResult, reads: number, maxChars: number): Verdict {
  if (run.error) return { ok: false, error: run.error, chars: 0 };
  if (isEmpty(run.result)) return { ok: false, error: 'the script returned nothing: return an object with the values needed', chars: 0 };
  const chars = JSON.stringify(run.result).length;
  if (reads === 0) return { ok: false, error: NEEDS_TOOL_DATA, chars };
  if (chars > maxChars) return { ok: false, error: `result too large: return fewer values (${chars} characters, the limit is ${maxChars})`, chars };
  return { ok: true, chars };
}

/**
 * The functions the sandbox gets: ONLY the tools passed in. Each one also records what it returned,
 * as the sandbox receives it (JSON), so a call that failed or could not be written as JSON leaves nothing.
 */
function sandboxFunctions(tools: readonly ReadTool[], seen: ToolOutput[]) {
  return Object.fromEntries(tools.map((t) => [t.name, async (args: unknown) => {
    const output = await t.run(args);
    seen.push({ tool: t.name, output: JSON.parse(JSON.stringify(output ?? null) ?? 'null') as unknown });
    return output;
  }]));
}

export function createCodeModeRunner(deps: {
  model: ModelPort;
  executor?: QuickJsExecutor;
  maxResultChars?: number;
}): CodeModeRunner {
  const executor = deps.executor ?? new QuickJsExecutor({ timeoutMs: 20_000, maxToolCalls: 30 });
  const maxChars = deps.maxResultChars ?? 4000;

  return async (input) => {
    const tally = { attempts: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, model: input.model };
    const finish = (ok: boolean, result: unknown, error: string | null, script: string | null, resultChars: number, outputs: ToolOutput[] = []): CodeModeResult =>
      ({ ok, result: ok ? result : null, error, script, resultChars, toolOutputs: ok ? outputs : [], ...tally });

    const problem = toolProblem(input.tools);
    if (problem) return finish(false, null, problem, null, 0);

    const system = systemPrompt(input.skill, input.tools);
    let retry: { previousScript: string; error: string } | null = null;
    let script: string | null = null;
    let error = '';
    let resultChars = 0;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      tally.attempts = attempt;
      let reply: Awaited<ReturnType<ModelPort['chat']>>;
      try {
        reply = await deps.model.chat({
          purpose: input.purpose, model: input.model, system, user: JSON.stringify({ question: input.question, ...retry }),
          maxTokens: SCRIPT_TOKENS, temperature: 0, json: false, thinking: false,
        });
      } catch (caught) {
        return finish(false, null, caught instanceof ModelError ? caught.message : 'the model could not be reached', script, resultChars);
      }
      tally.inputTokens += reply.inputTokens;
      tally.outputTokens += reply.outputTokens;
      tally.model = reply.model;

      script = extractScript(reply.text);
      if (!script) {
        error = 'the reply had no JavaScript function: write one async arrow function';
        retry = { previousScript: reply.text.slice(0, 2000), error };
        continue;
      }
      // Only the tools passed in exist inside the sandbox; anything else fails there as an unknown tool.
      const seen: ToolOutput[] = [];
      const run: ExecuteResult = await executor.execute(script, sandboxFunctions(input.tools, seen)).catch(
        (): ExecuteResult => ({ result: undefined, error: 'the sandbox could not run the script', toolCalls: 0 }),
      );
      tally.toolCalls += run.toolCalls;
      const verdict = judge(run, seen.length, maxChars);
      resultChars = verdict.chars;
      // A copy: a call the script never awaited can still finish after the run, and must not change the result.
      if (verdict.ok) return finish(true, run.result, null, script, verdict.chars, [...seen]);
      error = verdict.error;
      retry = { previousScript: script, error };
    }
    return finish(false, null, `the script did not give a usable answer: ${error}`, script, resultChars);
  };
}
