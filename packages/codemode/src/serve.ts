// stdio entry for the brain MCP server. Claude Code, Cursor, Codex CLI and Gemini CLI start it as:
//   FAHQ_DOOR_TOKEN=... npx tsx packages/codemode/src/serve.ts --profile finance   (Code Mode: one `code` tool)
//   ... serve.ts --profile finance --plain                                         (the individual read tools)
//   ... serve.ts --profile finance --token-file .local/door-tokens/finance.token   (the token from a file)
//   npx tsx packages/codemode/src/serve.ts --local [--profile owner]               (offline: the file profiles)
// With a door token (npx tsx scripts/issue-door-token.ts <assistant>), the profile is read from the database
// through door_profile with the PUBLIC anon key (SUPABASE_URL, SUPABASE_ANON_KEY): the door offers only what
// that stored profile may read, serves its skill as the `skill` prompt, and has one write, `file_work_report`,
// which sends the end-of-work report to the HQ Manager. A token is bound to one assistant, so --profile is
// optional and must match it. --local reads the file profiles instead and cannot file a report.
// stdout carries the MCP protocol only; diagnostics go to stderr.
import fs from 'node:fs';
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { DataPort } from '@fahq/contracts';
import { openBrain } from '@fahq/brain';
import { createBrainMcpServer, createCodeModeBrainServer, type BrainMcpDeps } from './index.ts';
import { DoorError } from './door-client.ts';
import { openDoor, parseDoorArgs } from './door.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const envFile = path.join(root, '.env.local');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

let request, door;
try {
  request = parseDoorArgs(process.argv.slice(2));
  door = await openDoor(request, process.env);
} catch (error) {
  if (!(error instanceof DoorError)) throw error;
  console.error(`fortune-brain: ${error.message}`);
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
  fileReport: door.fileReport,
  now: () => new Date(),
};

const server = request.plain ? createBrainMcpServer(deps, door.profile) : await createCodeModeBrainServer(deps, {}, door.profile);
await server.connect(new StdioServerTransport());
console.error(`fortune-brain MCP ready (${request.plain ? 'plain tools' : 'Code Mode'}, ${door.summary})`);
