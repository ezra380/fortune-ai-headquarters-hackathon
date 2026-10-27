import { z } from 'zod';
import type { ModelPort, ReadTool } from '@fahq/contracts';
import { ModelError, parseJsonObject } from '@fahq/models';
import { ANSWER_RULES } from './answer.ts';

// The baseline Code Mode is measured against; the worker does not use it. Classic JSON tool calling:
// the model asks for one tool per turn, every tool result is appended to the transcript as its FULL
// JSON, and the whole transcript is sent again every round. That repeated transcript is what a
// multi-turn tool-calling conversation costs.

const TURN_TOKENS = 600;

const Turn = z.union([
  z.object({ call: z.object({ tool: z.string(), args: z.unknown().optional() }) }),
  z.object({ answer: z.string().min(1) }),
]);

export type ToolLoopResult = {
  ok: boolean;
  answer: string | null;
  /** Model calls made. */
  rounds: number;
  inputTokens: number;
  outputTokens: number;
  /** Characters of the transcript (question plus every call and result) sent in the last round. */
  transcriptChars: number;
  error: string | null;
};

function systemPrompt(skill: string, tools: readonly ReadTool[]): string {
  const listed = tools.map((t) => `- ${t.name}: ${t.description}\n  ${t.signature}`);
  return [
    skill,
    '',
    '## Your read-only tools',
    ...listed,
    '',
    '## How to answer',
    'Each turn, reply with ONLY one JSON object, either',
    '{"call":{"tool":"<name>","args":{...}}} to read something, or',
    '{"answer":"<text>"} when you can answer.',
    'Call one tool per turn, and only the tools above. Every number in your answer must come from a tool result.',
    ANSWER_RULES,
  ].join('\n');
}

function transcript(question: string, entries: readonly string[]): string {
  const calls = entries.length > 0 ? entries.join('\n') : 'No tool calls yet.';
  return `Question: ${question}\n\nTool calls so far:\n${calls}`;
}

export async function toolLoopAnswer(input: {
  model: ModelPort;
  modelId: string;
  skill: string;
  question: string;
  tools: readonly ReadTool[];
  maxRounds?: number;
}): Promise<ToolLoopResult> {
  const maxRounds = input.maxRounds ?? 6;
  const system = systemPrompt(input.skill, input.tools);
  const byName = new Map(input.tools.map((t) => [t.name, t]));
  const entries: string[] = [];
  let calls = 0;
  const tally = { rounds: 0, inputTokens: 0, outputTokens: 0, transcriptChars: 0 };
  const finish = (answer: string | null, error: string | null): ToolLoopResult => ({ ok: answer !== null, answer, error, ...tally });

  while (tally.rounds < maxRounds) {
    const user = transcript(input.question, entries);
    tally.rounds += 1;
    tally.transcriptChars = user.length;
    let reply: Awaited<ReturnType<ModelPort['chat']>>;
    try {
      reply = await input.model.chat({
        purpose: 'toolloop', model: input.modelId, system, user, maxTokens: TURN_TOKENS, temperature: 0, json: false, thinking: false,
      });
    } catch (caught) {
      return finish(null, caught instanceof ModelError ? caught.message : 'the model could not be reached');
    }
    tally.inputTokens += reply.inputTokens;
    tally.outputTokens += reply.outputTokens;

    let turn: z.infer<typeof Turn> | null = null;
    try {
      const parsed = Turn.safeParse(parseJsonObject(reply.text));
      turn = parsed.success ? parsed.data : null;
    } catch {
      turn = null;
    }
    if (!turn) {
      entries.push('Your last reply was not one JSON object with "call" or "answer". Reply with only that JSON object.');
    } else if ('answer' in turn) {
      return finish(turn.answer.trim(), null);
    } else {
      entries.push(await runCall(byName, turn.call, ++calls));
    }
  }
  return finish(null, `no answer after ${maxRounds} rounds`);
}

/** One transcript entry: the call and its full JSON result, or the plain reason it did not run. */
async function runCall(byName: ReadonlyMap<string, ReadTool>, call: { tool: string; args?: unknown }, n: number): Promise<string> {
  const head = `${n}. ${call.tool}(${JSON.stringify(call.args ?? {})})`;
  const tool = byName.get(call.tool);
  if (!tool) return `${head} is not one of your tools.`;
  try {
    return `${head} returned: ${JSON.stringify((await tool.run(call.args)) ?? null)}`;
  } catch (error) {
    return `${head} failed: ${error instanceof Error ? error.message.slice(0, 300) : 'unknown error'}`;
  }
}
