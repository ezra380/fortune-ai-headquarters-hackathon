import { codeMcpServer } from '@cloudflare/codemode/mcp';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createBrainMcpServer, doorReads, registerSkillPrompt, registerWorkReportTool, type BrainMcpDeps, type DoorProfileArg } from './brain-mcp.ts';
import { QuickJsExecutor, type QuickJsExecutorOptions } from './quickjs-executor.ts';

export { createBrainMcpServer, doorReads, doorTools, registerWorkReportTool } from './brain-mcp.ts';
export type { BrainMcpDeps, DoorProfileArg, FileReport, FiledReport } from './brain-mcp.ts';
export { QuickJsExecutor } from './quickjs-executor.ts';
export type { ExecuteResult, ResolvedProvider } from './quickjs-executor.ts';
export { createCodeModeRunner, declarations } from './runner.ts';
export { toolLoopAnswer } from './tool-loop.ts';
export type { ToolLoopResult } from './tool-loop.ts';
export { mentions, traceNumbers, untracedResultNumbers, writeAnswer } from './answer.ts';

/**
 * The brain behind Cloudflare Code Mode: every brain tool becomes a typed method on `codemode`,
 * and the agent sends one `code` call that runs in the QuickJS sandbox instead of many tool calls.
 */
export async function createCodeModeBrainServer(
  deps: BrainMcpDeps,
  executorOptions: QuickJsExecutorOptions = {},
  profile: DoorProfileArg = 'owner',
): Promise<McpServer> {
  // A profile with nothing to read has no API to script: its door is just the skill prompt (and the report tool).
  if (doorReads(profile).length === 0) return createBrainMcpServer(deps, profile);
  const { fileReport, ...readDeps } = deps; // a script in the sandbox reaches the reads only, never the write
  const server = await codeMcpServer({
    server: createBrainMcpServer(readDeps, profile),
    executor: new QuickJsExecutor({ timeoutMs: 30_000, maxToolCalls: 40, ...executorOptions }),
  });
  // The wrapper only proxies the read tools; the skill prompt and the report tool are added beside the `code` tool.
  registerSkillPrompt(server, profile, { canReport: fileReport !== undefined });
  if (fileReport) registerWorkReportTool(server, fileReport);
  return server;
}
