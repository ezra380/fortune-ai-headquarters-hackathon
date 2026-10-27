// stdio entry for the brain MCP server. Claude Code, Cursor, Codex CLI and Gemini CLI start it as:
//   npx tsx packages/codemode/src/serve.ts          (Code Mode: one `code` tool)
//   npx tsx packages/codemode/src/serve.ts --plain  (the individual read tools)
// Add --profile <owner|finance|online|salon|manager> (default owner): the door then offers only what
// that assistant may read, and serves its skill as the `skill` prompt.
// stdout carries the MCP protocol only; diagnostics go to stderr.
import fs from 'node:fs';
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AssistantId, type DataPort } from '@fahq/contracts';
import { openBrain } from '@fahq/brain';
import { createBrainMcpServer, createCodeModeBrainServer, type BrainMcpDeps } from './index.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const envFile = path.join(root, '.env.local');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const plain = process.argv.includes('--plain');
const profile = AssistantId.safeParse(option('--profile') ?? 'owner');
if (!profile.success) {
  console.error(`fortune-brain: --profile must be one of ${AssistantId.options.join(', ')}`);
  process.exit(2);
}

async function connectData(): Promise<DataPort | null> {
  try {
    // Lane B's package; resolved at run time so the door still starts (and says so) before it lands.
    const dataPackage = '@fahq/data';
    const mod = (await import(dataPackage)) as { createZetarisDataPort?: (env: NodeJS.ProcessEnv) => DataPort };
    if (typeof mod.createZetarisDataPort !== 'function') throw new Error('createZetarisDataPort is not exported yet');
    return mod.createZetarisDataPort(process.env);
  } catch (error) {
    console.error(`fortune-brain: business data not connected (${error instanceof Error ? error.message : 'unknown'})`);
    return null;
  }
}

const deps: BrainMcpDeps = {
  data: await connectData(),
  openBrain: () =>
    openBrain({
      meterlessDir: path.resolve(root, process.env.METERLESS_DIR ?? '.local/meterless'),
      dataDir: path.join(root, '.local/brain'),
      actor: 'brain-mcp-reader',
    }),
  now: () => new Date(),
};

const server = plain ? createBrainMcpServer(deps, profile.data) : await createCodeModeBrainServer(deps, {}, profile.data);
await server.connect(new StdioServerTransport());
console.error(`fortune-brain MCP ready (${plain ? 'plain tools' : 'Code Mode'}, profile ${profile.data})`);

/** `--profile finance` or `--profile=finance`. */
function option(name: string): string | undefined {
  const args = process.argv.slice(2);
  const at = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (at < 0) return undefined;
  return args[at]!.includes('=') ? args[at]!.slice(name.length + 1) : (args[at + 1] ?? '');
}
