import type { ModelPort, ReadTool } from '@fahq/contracts';

// MOCKS for unit tests only. No network, no provider, no cost. Nothing here is used outside test/.

export type ChatInput = Parameters<ModelPort['chat']>[0];

/** A model that answers from a fixed script of replies (a string is a reply, an Error is thrown) and records each call. */
export function mockModel(replies: readonly (string | Error)[], tokens: { input: number; output: number } = { input: 100, output: 20 }) {
  const calls: ChatInput[] = [];
  let next = 0;
  const model: ModelPort = {
    async chat(input) {
      calls.push(input);
      const reply = replies[next++];
      if (reply === undefined) throw new Error('the mock model has no more replies');
      if (reply instanceof Error) throw reply;
      return { text: reply, model: input.model, inputTokens: tokens.input, outputTokens: tokens.output, costUsd: 0 };
    },
  };
  return { model, calls };
}

export function fakeTool(name: string, run: (args: unknown) => Promise<unknown>, signature = '(args: { period: "2026-09" }) => Promise<unknown>'): ReadTool {
  return { name, description: `Fake ${name} for tests.`, signature, run };
}
