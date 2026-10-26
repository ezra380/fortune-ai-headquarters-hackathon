// stdio entry for the brain MCP server. Claude Code, Cursor, Codex CLI and Gemini CLI start it as:
//   npx tsx packages/codemode/src/serve.ts          (Code Mode: one `code` tool)
//   npx tsx packages/codemode/src/serve.ts --plain  (the individual read tools)
// stdout carries the MCP protocol only; diagnostics go to stderr.
import fs from 'node:fs';
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { DataPort } from '@fahq/contracts';
import { openBrain } from '@fahq/brain';
import { createBrainMcpServer, createCodeModeBrainServer, type BrainMcpDeps } from './index.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const envFile = path.join(root, '.env.local');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

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

const plain = process.argv.includes('--plain');
const server = plain ? createBrainMcpServer(deps) : await createCodeModeBrainServer(deps);
await server.connect(new StdioServerTransport());
console.error(`fortune-brain MCP ready (${plain ? 'plain tools' : 'Code Mode'})`);
