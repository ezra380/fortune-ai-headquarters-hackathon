import { codeMcpServer } from '@cloudflare/codemode/mcp';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AssistantId } from '@fahq/contracts';
import { createBrainMcpServer, doorReads, registerSkillPrompt, type BrainMcpDeps } from './brain-mcp.ts';
import { QuickJsExecutor, type QuickJsExecutorOptions } from './quickjs-executor.ts';

export { createBrainMcpServer } from './brain-mcp.ts';
export type { BrainMcpDeps } from './brain-mcp.ts';
export { QuickJsExecutor } from './quickjs-executor.ts';
export type { ExecuteResult, ResolvedProvider } from './quickjs-executor.ts';
export { createCodeModeRunner, declarations } from './runner.ts';
export { toolLoopAnswer } from './tool-loop.ts';
export type { ToolLoopResult } from './tool-loop.ts';
export { traceNumbers, writeAnswer } from './answer.ts';

/**
 * The brain behind Cloudflare Code Mode: every brain tool becomes a typed method on `codemode`,
 * and the agent sends one `code` call that runs in the QuickJS sandbox instead of many tool calls.
 */
export async function createCodeModeBrainServer(
  deps: BrainMcpDeps,
  executorOptions: QuickJsExecutorOptions = {},
  profileId: AssistantId = 'owner',
): Promise<McpServer> {
  // A profile with nothing to read has no API to script: its door is just the skill prompt.
  if (doorReads(profileId).length === 0) return createBrainMcpServer(deps, profileId);
  const server = await codeMcpServer({
    server: createBrainMcpServer(deps, profileId),
    executor: new QuickJsExecutor({ timeoutMs: 30_000, maxToolCalls: 40, ...executorOptions }),
  });
  registerSkillPrompt(server, profileId); // the wrapper only proxies tools; the skill prompt is added here
  return server;
}
