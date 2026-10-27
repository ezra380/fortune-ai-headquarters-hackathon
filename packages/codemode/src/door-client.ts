import { z } from 'zod';
import type { SessionReport } from '@fahq/contracts';
import type { FiledReport } from './brain-mcp.ts';

// The two calls an outside tool may make to the database with the PUBLIC anon key and its door token:
// door_profile(token) and door_file_report(token, report). Both are POSTs: the token travels in the body,
// never in a URL (the database refuses a GET, and URLs get logged). Every answer is checked with zod, and every
// failure becomes one plain sentence that never contains the token or the key.

/** A door token as the database accepts it (the same pattern as public.door_token). */
export const DOOR_TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;

export class DoorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DoorError';
  }
}

/** True for the keys that must never reach an outside tool's configuration: a service-role or secret key. */
export function isServiceKey(key: string): boolean {
  if (key.startsWith('sb_secret_')) return true;
  const payload = key.split('.')[1];
  if (!payload) return false;
  try {
    return (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { role?: unknown }).role === 'service_role';
  } catch {
    return false;
  }
}

export type DoorClientConfig = {
  /** The Supabase project URL, e.g. https://abc.supabase.co or http://127.0.0.1:54321. */
  url: string;
  /** The public anon key. A service key is refused. */
  anonKey: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type DoorClient = {
  /** The raw answer of door_profile: the caller validates it (packages/profiles). */
  profile(): Promise<unknown>;
  fileReport(report: SessionReport): Promise<FiledReport>;
};

const Filed = z.object({ id: z.uuid(), duplicate: z.boolean() });
const clip = (text: string, max = 300) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function createDoorClient(config: DoorClientConfig): DoorClient {
  let base: URL;
  try {
    base = new URL(config.url);
  } catch {
    throw new DoorError('SUPABASE_URL is not a web address.');
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new DoorError('SUPABASE_URL must start with https:// (or http:// for the local stack).');
  if (!config.anonKey.trim()) throw new DoorError('SUPABASE_ANON_KEY is empty.');
  if (isServiceKey(config.anonKey)) throw new DoorError('SUPABASE_ANON_KEY is a service key. A door uses the public anon key only.');
  if (!DOOR_TOKEN_SHAPE.test(config.token)) throw new DoorError('The door token is not in the shape the database accepts (32 to 128 letters, digits, - or _).');
  const send = config.fetch ?? fetch;

  async function call(fn: 'door_profile' | 'door_file_report', body: Record<string, unknown>): Promise<unknown> {
    let res: Response;
    try {
      res = await send(new URL(`/rest/v1/rpc/${fn}`, base), {
        method: 'POST',
        headers: { apikey: config.anonKey, authorization: `Bearer ${config.anonKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ p_token: config.token, ...body }),
        signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
        redirect: 'error', // never send the token anywhere the address did not name
      });
    } catch (error) {
      const why = error instanceof Error && error.name === 'TimeoutError' ? 'it did not answer in time' : 'the connection failed';
      throw new DoorError(`The door could not reach ${base.host}: ${why}.`);
    }
    const answer: unknown = await res.json().catch(() => null);
    if (res.ok) return answer;
    const { code, message } = (answer ?? {}) as { code?: unknown; message?: unknown };
    if (res.status === 403 || code === '28000') throw new DoorError('The door refused this token: it is not valid, or it was revoked.');
    throw new DoorError(typeof message === 'string' && message ? clip(message) : `The database answered ${res.status}.`);
  }

  return {
    profile: () => call('door_profile', {}),
    async fileReport(report) {
      const filed = Filed.safeParse(await call('door_file_report', { p_report: report }));
      if (!filed.success) throw new DoorError('The database filed the report but its answer was not in the expected shape.');
      return filed.data;
    },
  };
}
