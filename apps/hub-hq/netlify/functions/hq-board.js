// hq-board.js — GET /.netlify/functions/hq-board?tab=<company|finance|online|salon|manager|legal>
//
// The Fortune HQ board: the owner's read-only window into Fortune AI Headquarters (a separate Supabase project,
// FORTUNE_HQ_DB_URL): each assistant's profile, live work, workers and their reports, the briefs and texts about
// to go out, what went out, memory and mailbox. Contract and gate: docs/fortune-hq-board.md.
//
// THE GATE. The session comes from requireAuth (the same door every staff function uses; 401 without one). Then
// the board is Fortune-admin only, exactly as admin-users.js gates user management (role 'admin', tenant
// 'fortune', and under the Hub's shared sign-in only a Hub-issued session), AND the account must be on the
// allowlist HQ_BOARD_USERS (comma-separated emails or user ids; unset = owner@example.com only). The account
// row is read fresh (active, still admin, still Fortune), so a demoted or deactivated account is refused at once.
// A session with no account row (the legacy shared STAFF_PASSWORD) is never on the board.
//
// Later, a division head's login will see only their division: boardScope() is the one place that decides which
// tabs an account may open. Today it returns every tab for the allowlisted owner and nothing for anyone else.
import { requireAuth, unauthorized } from './_lib/auth.js';
import { getUserById } from './_lib/db.js';
import { sharedAuthConfigured } from './_lib/hubAuth.js';
import { HqUnavailable, TABS, TAB_IDS, readBoard } from './_lib/hqBoardRead.js';
import { quietError } from './_lib/quietError.js';

const OWNER_ONLY = 'Fortune HQ is for the owner only.';
const NOT_CONNECTED = 'Fortune HQ data is not connected.';
const DEFAULT_USERS = 'owner@example.com';

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

function allowlist() {
  const raw = process.env.HQ_BOARD_USERS ?? DEFAULT_USERS;
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/**
 * The tabs this session may open: all of them for an allowlisted Fortune admin, none for anyone else.
 * @param {{userId:string|null,role:string,tenant:string,sharedAuth?:boolean}} session
 * @param {(id:string)=>Promise<any>} getUser
 * @returns {Promise<readonly string[]>}
 */
export async function boardScope(session, getUser = getUserById) {
  if (session.role !== 'admin' || session.tenant !== 'fortune' || !session.userId) return [];
  if (sharedAuthConfigured() && session.sharedAuth !== true) return [];
  const user = await getUser(session.userId).catch(() => null);
  if (!user?.active || user.role !== 'admin' || user.tenant !== 'fortune') return [];
  const allowed = allowlist();
  const email = String(user.email ?? '').trim().toLowerCase();
  return allowed.has(email) || allowed.has(String(user.id).toLowerCase()) ? TAB_IDS : [];
}

export async function handler(event) {
  const session = await requireAuth(event);
  return hqBoardForSession(event, session);
}

/**
 * The HTTP entry always obtains a current session above; kept separate so the gate can be exercised with synthetic
 * verified identities. `deps.getUser` and `deps.now` are test seams.
 */
export async function hqBoardForSession(event, session, deps = {}) {
  if (!session) return unauthorized();
  const scope = await boardScope(session, deps.getUser);
  if (scope.length === 0) return json(403, { error: OWNER_ONLY });
  if (event.httpMethod !== 'GET') return json(405, { error: 'GET only' });
  const tab = event.queryStringParameters?.tab ?? scope[0];
  if (typeof tab !== 'string' || !scope.includes(tab)) return json(400, { error: 'Unknown tab.' });
  if (!process.env.FORTUNE_HQ_DB_URL) return json(503, { error: NOT_CONNECTED });
  const now = deps.now ? deps.now() : new Date();
  try {
    const tabData = await readBoard(tab, now);
    return json(200, { generatedAt: now.toISOString(), tabs: TABS.filter((t) => scope.includes(t.id)), tab: tabData });
  } catch (e) {
    if (e instanceof HqUnavailable) {
      quietError('hq-board', e);
      return json(503, { error: NOT_CONNECTED });
    }
    return json(500, { error: quietError('hq-board', e) });
  }
}
