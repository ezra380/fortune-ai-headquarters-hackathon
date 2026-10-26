import { codeMcpServer } from '@cloudflare/codemode/mcp';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createBrainMcpServer, type BrainMcpDeps } from './brain-mcp.ts';
import { QuickJsExecutor, type QuickJsExecutorOptions } from './quickjs-executor.ts';

export { createBrainMcpServer } from './brain-mcp.ts';
export type { BrainMcpDeps } from './brain-mcp.ts';
export { QuickJsExecutor } from './quickjs-executor.ts';
export type { ExecuteResult, ResolvedProvider } from './quickjs-executor.ts';

/**
 * The brain behind Cloudflare Code Mode: every brain tool becomes a typed method on `codemode`,
 * and the agent sends one `code` call that runs in the QuickJS sandbox instead of many tool calls.
 */
export async function createCodeModeBrainServer(
  deps: BrainMcpDeps,
  executorOptions: QuickJsExecutorOptions = {},
): Promise<McpServer> {
  return codeMcpServer({
    server: createBrainMcpServer(deps),
    executor: new QuickJsExecutor({ timeoutMs: 30_000, maxToolCalls: 40, ...executorOptions }),
  });
}
