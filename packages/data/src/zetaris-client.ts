import { randomUUID } from 'node:crypto';

// Zetaris SQL over its direct REST API (the documented route for both setup statements and
// queries): POST {ZETARIS_REST_URL}/sql-editor/sqls/run with {queryId, sql, source, limit}.
// Mirrors ~/getting-started/scripts/zetaris_sql.py and zetaris_api.py. One statement per call,
// no trailing semicolon; rows come back as arrays of strings. Credentials never reach logs.

export class ZetarisError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ZetarisError';
  }
}

export type ZetarisConfig = {
  restUrl: string;
  baseUrl: string;
  orgId: string;
  apiKey?: string;
  username?: string;
  password?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export function zetarisConfigFromEnv(env: NodeJS.ProcessEnv): ZetarisConfig {
  const orgId = env.ZETARIS_ORG_ID ?? '';
  if (!/^\d+$/.test(orgId)) throw new ZetarisError('ZETARIS_ORG_ID must be the numeric organization id');
  return {
    restUrl: (env.ZETARIS_REST_URL ?? 'http://localhost:8888/api/v1.0').replace(/\/$/, ''),
    baseUrl: (env.ZETARIS_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
    orgId,
    ...(env.ZETARIS_API_KEY ? { apiKey: env.ZETARIS_API_KEY } : {}),
    ...(env.ZETARIS_USERNAME ? { username: env.ZETARIS_USERNAME } : {}),
    ...(env.ZETARIS_PASSWORD ? { password: env.ZETARIS_PASSWORD } : {}),
  };
}

export function createZetarisClient(config: ZetarisConfig) {
  const doFetch = config.fetch ?? fetch;
  let token: string | undefined = config.apiKey;

  async function login(): Promise<string> {
    if (token) return token;
    if (!config.username || !config.password) throw new ZetarisError('Set ZETARIS_API_KEY or both ZETARIS_USERNAME and ZETARIS_PASSWORD');
    const r = await doFetch(`${config.baseUrl}/api/auth/login`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/json', 'X-Request-ID': randomUUID() },
      body: JSON.stringify({ username: config.username, password: config.password }),
    }).catch(() => {
      throw new ZetarisError(`Cannot reach Zetaris at ${config.baseUrl}`);
    });
    if (!r.ok) throw new ZetarisError(`Zetaris login failed: HTTP ${r.status}`, r.status);
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    const found = [body.idToken, body.token, body.accessToken].find((t) => typeof t === 'string' && t.length > 0) as string | undefined;
    const fallback = JSON.stringify(body).match(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/)?.[0];
    token = found ?? fallback;
    if (!token) throw new ZetarisError('Zetaris login did not return an access token');
    return token;
  }

  /** Runs one SQL statement; returns rows as arrays of strings (Zetaris REST's own format). */
  async function run(sql: string, limit = 1000): Promise<string[][]> {
    const statement = sql.trim().replace(/;\s*$/, '');
    if (statement.includes(';')) throw new ZetarisError('one statement per call');
    const bearer = await login();
    let r: Response;
    try {
      r = await doFetch(`${config.restUrl}/sql-editor/sqls/run`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(config.timeoutMs ?? 600_000),
        headers: {
          Authorization: `Bearer ${bearer}`,
          'X-Org-ID': config.orgId,
          'X-Request-ID': randomUUID(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ queryId: randomUUID(), sql: statement, source: 'SqlEditor', limit }),
      });
    } catch {
      throw new ZetarisError(`Cannot reach Zetaris at ${config.restUrl}`);
    }
    const text = await r.text();
    if (!r.ok) {
      // Zetaris puts the SQL error message in the body; it carries no credentials. Keep it short.
      throw new ZetarisError(`HTTP ${r.status}: ${text.replace(/\s+/g, ' ').slice(0, 400)}`, r.status);
    }
    let body: { data?: unknown };
    try {
      body = JSON.parse(text) as { data?: unknown };
    } catch {
      throw new ZetarisError('Zetaris returned a body that is not JSON');
    }
    if (!Array.isArray(body.data)) return [];
    return body.data.map((row) => (Array.isArray(row) ? row.map((v) => (v === null || v === undefined ? '' : String(v))) : [String(row)]));
  }

  return { run };
}

export type ZetarisClient = ReturnType<typeof createZetarisClient>;
