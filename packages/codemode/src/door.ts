import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { AssistantId, type SessionReport } from '@fahq/contracts';
import { loadProfiles, profileFromDoor, type AssistantProfile } from '@fahq/profiles';
import type { FileReport } from './brain-mcp.ts';
import { createDoorClient, DoorError } from './door-client.ts';

// Opening a door: which profile it serves and where a report goes. Two ways in:
//   --profile <id> with FAHQ_DOOR_TOKEN (or --token-file <path>): the profile is read from the database through
//     door_profile, and file_work_report files to the HQ Manager through door_file_report.
//   --local: the file profiles under packages/profiles/skills, no database, no report. For offline use.
// Everything that can be wrong here is a DoorError, one plain sentence; the entry point prints it and stops.

export type DoorRequest = { plain: boolean; local: boolean; profile: AssistantId | undefined; tokenFile: string | undefined };

export function parseDoorArgs(argv: readonly string[]): DoorRequest {
  let values;
  try {
    values = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: { plain: { type: 'boolean' }, local: { type: 'boolean' }, profile: { type: 'string' }, 'token-file': { type: 'string' } },
    }).values;
  } catch (error) {
    throw new DoorError(`${error instanceof Error ? error.message.split('.')[0] : 'The arguments are not valid'}. Use --profile <id>, --token-file <path>, --local, --plain.`);
  }
  const profile = values.profile === undefined ? undefined : AssistantId.safeParse(values.profile);
  if (profile && !profile.success) throw new DoorError(`--profile must be one of ${AssistantId.options.join(', ')}.`);
  if (values.local && values['token-file']) throw new DoorError('--local serves the file profiles with no database; it cannot be combined with --token-file.');
  return { plain: values.plain === true, local: values.local === true, profile: profile?.data, tokenFile: values['token-file'] };
}

export type OpenedDoor = {
  profile: AssistantProfile;
  /** Files a report with the HQ Manager; undefined for a local door. */
  fileReport: FileReport | undefined;
  /** One line for stderr: what was opened. */
  summary: string;
};

export type OpenDoorIo = {
  fetch?: typeof fetch;
  readFile?: (path: string) => string;
  /** Tells one process's reports from another's, so only a retry in the same session counts as the same report. */
  sessionId?: string;
};

/** The key a report is stored under: this session plus a hash of what it says, so a retry is stored once. */
export function reportKey(sessionId: string, report: Omit<SessionReport, 'key'>): string {
  const content = JSON.stringify([report.tool, report.summary, report.steps ?? [], report.suggestions ?? [], report.lessons ?? []]);
  return `${sessionId}:${createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 32)}`;
}

export async function openDoor(request: DoorRequest, env: NodeJS.ProcessEnv, io: OpenDoorIo = {}): Promise<OpenedDoor> {
  if (request.local) {
    const id = request.profile ?? 'owner';
    return { profile: loadProfiles({})[id], fileReport: undefined, summary: `profile ${id} from the files (offline, no work report)` };
  }

  const token = readToken(request.tokenFile, env, io.readFile ?? ((file) => fs.readFileSync(file, 'utf8')));
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) throw new DoorError('A door needs SUPABASE_URL and SUPABASE_ANON_KEY (the public anon key, never the service key).');
  const client = createDoorClient({ url: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY, token, fetch: io.fetch });
  let profile: AssistantProfile;
  try {
    profile = profileFromDoor(await client.profile());
  } catch (error) {
    throw error instanceof DoorError ? error : new DoorError(error instanceof Error ? error.message : 'The profile could not be read.');
  }
  if (request.profile && request.profile !== profile.id) {
    throw new DoorError(`This token belongs to the ${profile.id} assistant, not ${request.profile}. Use the token issued for ${request.profile}.`);
  }
  const sessionId = io.sessionId ?? randomBytes(6).toString('hex');
  return {
    profile,
    fileReport: (report) => client.fileReport({ ...report, key: reportKey(sessionId, report) }),
    summary: `profile ${profile.id} version ${profile.version} from the database`,
  };
}

function readToken(tokenFile: string | undefined, env: NodeJS.ProcessEnv, readFile: (path: string) => string): string {
  let token: string | undefined;
  if (tokenFile) {
    try {
      token = readFile(tokenFile).trim();
    } catch {
      throw new DoorError(`The token file ${tokenFile} could not be read.`);
    }
  } else {
    token = env.FAHQ_DOOR_TOKEN?.trim();
  }
  if (!token) {
    throw new DoorError(
      `No door token. Set FAHQ_DOOR_TOKEN, or pass --token-file <path> (npx tsx scripts/issue-door-token.ts <assistant> makes one). ${tokenFile ? 'The file was empty. ' : ''}--local serves the file profiles offline and cannot file reports.`,
    );
  }
  return token;
}
