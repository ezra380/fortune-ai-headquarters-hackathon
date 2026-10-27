// hq-board.test.mjs — the Fortune HQ board (netlify/functions/hq-board.js): the owner-only gate, the read-only
// transaction, the contract's shape and the blanking of codes. The Hub's own database is pg-mem (the real schema,
// real sign-in through auth-login and requireAuth); the HQ database is a fake pg pool that records every statement.
//
//   node test/hq-board.test.mjs     (or: npm test)
import { bootEnv, bootDb, loadHandlers, requestHelpers, makeAsserts } from './_gate-harness.mjs';

bootEnv({ HQ_BOARD_USERS: 'ezra@test' });
delete process.env.FORTUNE_HQ_DB_URL;
bootDb();
const h = await loadHandlers({ login: 'auth-login', adminUsers: 'admin-users', board: 'hq-board' });
const { boardScope, hqBoardForSession } = await import('../netlify/functions/hq-board.js');
const { setHqPool, readTab, TAB_IDS } = await import('../netlify/functions/_lib/hqBoardRead.js');
const { SQL } = await import('../netlify/functions/_lib/hqBoardSql.js');
const { cleanText, BLANK } = await import('../netlify/functions/_lib/hqBoardText.js');
const { QUIET_SENTENCE } = await import('../netlify/functions/_lib/quietError.js');
const { requireAuth } = await import('../netlify/functions/_lib/auth.js');
const { state, post, get, json } = requestHelpers();
const { ok, done } = makeAsserts();

const OWNER_ONLY = 'Fortune HQ is for the owner only.';
const NOT_CONNECTED = 'Fortune HQ data is not connected.';
const NOW = new Date('2026-10-27T16:00:00Z');

// ---- a fake HQ database: answers by statement, records everything it was asked ----
const NAME_OF = new Map(Object.entries(SQL).map(([k, v]) => [v, k]));
function fakeHq(rowsFor = {}, { failOn = null, refuseConnect = false } = {}) {
  const calls = [];
  const released = [];
  const client = {
    async query(text, params) {
      calls.push({ text, params, name: NAME_OF.get(text) ?? text });
      if (failOn && NAME_OF.get(text) === failOn) throw Object.assign(new Error('relation "secret_table" does not exist for user hq_admin'), { code: '42P01' });
      const rows = rowsFor[NAME_OF.get(text)];
      return { rows: typeof rows === 'function' ? rows(params) : rows ?? [] };
    },
    release(broken) { released.push(broken); },
  };
  const pool = { async connect() { if (refuseConnect) throw Object.assign(new Error('getaddrinfo ENOTFOUND db.secret-host'), { code: 'ENOTFOUND' }); return client; } };
  return { pool, calls, released };
}

const FINANCE_ROWS = {
  profile: [{ id: 'finance', display_name: 'Finance', sms_from: '+15550001111', version: 3, title: 'Finance manager', reads: ['finance_summary', 'BAD-tool;drop'], models: { answer: { model: 'claude-sonnet-x' }, code: { model: 'bad model name!' } }, lessons: [{ text: 'Cite every number; code 654321 never', source: 'owner', adoptedAt: '2026-10-26T10:00:00Z' }], updated_at: '2026-10-26T10:00:00Z' }],
  head: [{ name: 'Alan', role: 'finance_owner', phone: '+15550002222' }],
  live: [
    { id: 't1', kind: 'scheduled', status: 'running', job: 'division_worker', worker: 'finance.meta', created_at: '2026-10-27T15:00:00Z', updated_at: '2026-10-27T15:59:00Z' },
    { id: 't2', kind: 'scheduled', status: 'queued', job: 'weekly_report', worker: null, created_at: '2026-10-27T15:30:00Z', updated_at: '2026-10-27T15:30:00Z' },
    { id: 't3', kind: 'inbound_text', status: 'waiting', job: null, worker: null, created_at: '2026-10-27T15:40:00Z', updated_at: '2026-10-27T15:40:00Z' },
  ],
  workerLatest: [{ worker_id: 'finance.email', report_date: '2026-10-27', status: 'watch', written_by: 'model', headline: 'Reply 482913 to approve the email plan', findings: [{ text: 'Flows earned $15,251.71 from 1,889 sends', cites: ['email.revenue', 'x;drop'] }, 'junk'], created_at: '2026-10-27T13:00:00Z' }],
  workerWeek: [
    { worker_id: 'finance.email', report_date: '2026-10-27', status: 'watch', headline: 'newest' },
    { worker_id: 'finance.email', report_date: '2026-10-27', status: 'normal', headline: 'older same day' },
    { worker_id: 'finance.email', report_date: '2026-10-26', status: 'normal', headline: 'yesterday' },
  ],
  weekly: [{ week_of: '2026-10-26', status: 'act', ceo_line: 'Ads waste is up', summary: 'Weekly summary', goal: { title: 'Lift ROAS', metricId: 'meta.roas', from: 1.2, to: 2, by: '2026-11-02', why: 'Because' }, plans: [{ rank: 2, title: 'B', summary: 'b' }, { rank: 1, title: 'A', summary: 'a' }], actions: [], sections: [{ workerId: 'finance.meta', status: 'act', summary: 'Meta spend up' }], created_at: '2026-10-26T12:00:00Z' }],
  brief: [{ brief_date: '2026-10-27', status: 'watch', headline: 'Brief headline', actions: [{ rank: 1, title: 'Pause ad set', why: 'Low return', steps: 'Pause it' }], created_at: '2026-10-27T12:00:00Z' }],
  outgoing: [{ id: 'o1', channel: 'sms', status: 'pending', body: 'Your code is 123 456. Call +1 (917) 555-0142 or write alan@example.com', created_at: '2026-10-27T15:50:00Z', to_name: 'Alan' }],
  history: [{ id: 'o0', channel: 'email', status: 'sent', body: 'Weekly report sent, approve with 777888', at: '2026-10-26T13:00:00Z', to_name: 'Alan' }],
  mailbox: [{ from_a: 'finance', to_a: 'owner', kind: 'report', created_at: '2026-10-27T14:00:00Z', type: 'worker_words', said: null }],
  versions: [{ version: 3, made_by: 'manager', reason: 'Added a lesson', created_at: '2026-10-26T10:00:00Z' }],
  decisions: [{ created_at: '2026-10-25T10:00:00Z', verdict: 'approved', title: 'Pause ad set', rank: '1', by_name: 'Alan' }],
  reviewFindings: [{ created_at: '2026-10-24T10:00:00Z', text: 'George cited every number.' }],
  recommendationsFor: [{ kind: 'lesson', change: 'Check Walmart daily', status: 'adopted', applied_by: 'owner', at: '2026-10-24T11:00:00Z' }],
};

const login = await h.login(post({ email: 'ezra@test', password: 'admin-pw-123' }));
state.cookie = (login.headers['Set-Cookie'] || '').split(';')[0];
await h.adminUsers(post({ action: 'create', name: 'Emma', email: 'emma@test', role: 'va', temp_password: 'temp-emma-1' }));
await h.adminUsers(post({ action: 'create', name: 'Alan', email: 'alan@test', role: 'admin', temp_password: 'temp-alan-1' }));
const cookieOf = async (email, password) => ((await h.login(post({ email, password }))).headers['Set-Cookie'] || '').split(';')[0];
const va = await cookieOf('emma@test', 'temp-emma-1');
const otherAdmin = await cookieOf('alan@test', 'temp-alan-1');

console.log('\n[the gate: signed in, Fortune admin, on the allowlist]');
{
  const hq = fakeHq(FINANCE_ROWS);
  setHqPool(hq.pool);
  process.env.FORTUNE_HQ_DB_URL = 'postgres://fake';
  const none = await h.board({ httpMethod: 'GET', queryStringParameters: { tab: 'finance' }, headers: {} });
  ok('no sign-in -> 401, as every staff function', none.statusCode === 401);
  const vaRes = await h.board(get({ tab: 'finance' }, va));
  ok('a VA -> 403 with the owner-only sentence', vaRes.statusCode === 403 && json(vaRes).error === OWNER_ONLY, vaRes);
  const adminRes = await h.board(get({ tab: 'finance' }, otherAdmin));
  ok('another Fortune admin who is not on the allowlist -> 403', adminRes.statusCode === 403 && json(adminRes).error === OWNER_ONLY, adminRes);
  ok('a refused caller never reaches the HQ database', hq.calls.length === 0, hq.calls.length);
  const vaPost = await h.board({ ...post({}, va), queryStringParameters: { tab: 'finance' } });
  ok('a VA posting is refused by the gate first (403, not 405)', vaPost.statusCode === 403);
  const ownerPost = await h.board({ ...post({}), queryStringParameters: { tab: 'finance' } });
  ok('the owner posting -> 405 (the board only reads)', ownerPost.statusCode === 405);
}

console.log('\n[the gate rules, on synthetic verified identities]');
{
  const ezra = { id: 'u-1', email: ' owner@example.com ', active: true, role: 'admin', tenant: 'fortune' };
  const session = { userId: 'u-1', role: 'admin', tenant: 'fortune', actor: 'Ezra' };
  delete process.env.HQ_BOARD_USERS;
  ok('unset allowlist = owner@example.com only (case and spaces ignored)', (await boardScope(session, async () => ezra)).length === TAB_IDS.length);
  ok('unset allowlist refuses any other admin', (await boardScope(session, async () => ({ ...ezra, email: 'head@example.com' }))).length === 0);
  process.env.HQ_BOARD_USERS = 'someone@test, U-1';
  ok('the allowlist may name a user id', (await boardScope(session, async () => ({ ...ezra, email: 'x@test' }))).length === TAB_IDS.length);
  process.env.HQ_BOARD_USERS = 'owner@example.com';
  ok('a deactivated account is refused', (await boardScope(session, async () => ({ ...ezra, active: false }))).length === 0);
  ok('an account demoted since sign-in is refused (the row is read fresh)', (await boardScope(session, async () => ({ ...ezra, role: 'va' }))).length === 0);
  ok('a tenant owner (role owner) is refused', (await boardScope({ ...session, role: 'owner' }, async () => ({ ...ezra, role: 'owner' }))).length === 0);
  ok('a Lakewood session is refused', (await boardScope({ ...session, tenant: 'lakewood' }, async () => ezra)).length === 0);
  ok('the shared-password session (no account row) is refused', (await boardScope({ ...session, userId: null }, async () => ezra)).length === 0);
  ok('a failing account read is a refusal, not a pass', (await boardScope(session, async () => { throw new Error('db down'); })).length === 0);
  process.env.HUB_SHARED_AUTH_MODE = 'candidate';
  ok('under the Hub sign-in, only a Hub-issued session passes', (await boardScope(session, async () => ezra)).length === 0
    && (await boardScope({ ...session, sharedAuth: true }, async () => ezra)).length === TAB_IDS.length);
  delete process.env.HUB_SHARED_AUTH_MODE;
  process.env.HQ_BOARD_USERS = 'ezra@test';
}

console.log('\n[the tab: a fixed list, checked before anything runs]');
{
  const hq = fakeHq(FINANCE_ROWS);
  setHqPool(hq.pool);
  for (const tab of ["finance'; drop table people; --", 'owner', 'FINANCE', '../manager', '', 'x'.repeat(5000), 'finance\u0000']) {
    const r = await h.board(get({ tab }));
    ok(`hostile or unknown tab ${JSON.stringify(tab.slice(0, 30))} -> 400`, r.statusCode === 400 && json(r).error === 'Unknown tab.', r.statusCode);
  }
  ok('no hostile tab reached the HQ database', hq.calls.length === 0, hq.calls.length);
}

console.log('\n[not connected: 503 with the fixed sentence, never the driver words]');
{
  delete process.env.FORTUNE_HQ_DB_URL;
  const missing = await h.board(get({ tab: 'finance' }));
  ok('no FORTUNE_HQ_DB_URL -> 503', missing.statusCode === 503 && json(missing).error === NOT_CONNECTED, missing);
  process.env.FORTUNE_HQ_DB_URL = 'postgres://fake';
  const down = fakeHq({}, { refuseConnect: true });
  setHqPool(down.pool);
  const real = console.error; const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  const unreachable = await h.board(get({ tab: 'finance' }));
  console.error = real;
  ok('an unreachable HQ database -> 503 with the fixed sentence', unreachable.statusCode === 503 && json(unreachable).error === NOT_CONNECTED, unreachable);
  ok('neither the answer nor the log carries the driver words', !/secret-host|getaddrinfo/.test(unreachable.body + logged.join('\n')), logged);
}

console.log('\n[the owner reads a tab: one READ ONLY transaction, parameterized]');
let body;
{
  const hq = fakeHq(FINANCE_ROWS);
  setHqPool(hq.pool);
  const r = await hqBoardForSession(get({ tab: 'finance' }), await requireAuth(get({ tab: 'finance' })), { now: () => NOW });
  ok('the owner -> 200', r.statusCode === 200, r.statusCode);
  ok('the answer is never cached', r.headers['Cache-Control'] === 'no-store');
  body = json(r);
  const names = hq.calls.map((c) => c.name);
  ok('the transaction opens READ ONLY before any read', names[0] === 'begin read only', names.slice(0, 3));
  ok('with an 8-second statement timeout', names[1] === "set local statement_timeout = '8s'");
  ok('and commits at the end; the client goes back to the pool whole', names.at(-1) === 'commit' && hq.released.length === 1 && hq.released[0] === false);
  const reads = hq.calls.filter((c) => NAME_OF.has(c.text));
  ok('every read carries its values as parameters', reads.every((c) => Array.isArray(c.params)));
  ok('the tab id travels as $1 (finance)', reads.filter((c) => c.params.length).every((c) => c.params[0] === 'finance'), reads.map((c) => c.params));
  ok('the week cutoff is the New York date seven days before the injected clock', hq.calls.find((c) => c.name === 'workerWeek').params[1] === '2026-10-20');
  const all = Object.values(SQL).join('\n');
  ok('no statement reads a code hash, a door token, an inbound text, spend or a whole task payload',
    !/code_hash|token_hash|door_tokens|inbound_texts|model_spend|approvals|payload(?!->>)/.test(all));
  ok('no statement interpolates anything', !Object.values(SQL).some((s) => s.includes('${')));
}

console.log('\n[the contract shape]');
{
  ok('generatedAt is the injected clock', body.generatedAt === NOW.toISOString());
  ok('six tabs in order with labels', body.tabs.map((t) => t.id).join(',') === 'company,finance,online,salon,manager,legal' && body.tabs[0].label === 'Joey · CEO');
  const t = body.tab;
  ok('tab id and label', t.id === 'finance' && t.label === 'George');
  ok('profile: George, Finance manager, reports to Alan, the sending number, v3',
    t.profile.name === 'George' && t.profile.title === 'Finance manager' && t.profile.reportsTo === 'Alan' && t.profile.phone === '+15550001111' && t.profile.version === 3, t.profile);
  ok('profile: only well-formed model names and read tools', JSON.stringify(t.profile.models) === '{"answer":"claude-sonnet-x"}' && t.profile.reads.join() === 'finance_summary', t.profile);
  ok('profile: lessons in force counted', t.profile.lessonsInForce === 1);
  ok('head: Alan, Finance owner, his phone', t.head.name === 'Alan' && t.head.role === 'Finance owner' && t.head.phone === '+15550002222');
  ok('live: the running worker by its label', t.live.running.length === 1 && t.live.running[0].label === 'Meta ads' && t.live.running[0].since === '2026-10-27T15:59:00.000Z', t.live);
  ok('live: queued work, waiting work marked', t.live.queued.map((q) => q.label).join('|') === 'Weekly report|Answer (waiting for an approval)', t.live.queued);
  ok('workers: all seven finance workers, in order', t.workers.length === 7 && t.workers[0].workerId === 'finance.email' && t.workers[6].workerId === 'finance.salon_money');
  const email = t.workers[0];
  ok('workers: the newest report with its findings (bad cites dropped)', email.status === 'watch' && email.findings.length === 1 && email.findings[0].cites.join() === 'email.revenue', email);
  ok('workers: history is one row per day, newest first', email.history.map((x) => x.headline).join('|') === 'newest|yesterday', email.history);
  ok('workers: a worker with no report says so', t.workers[1].status === null && t.workers[1].note === 'No report yet.');
  ok('weekly: goal, paths in rank order, sections', t.weekly.goal.title === 'Lift ROAS' && t.weekly.paths.map((p) => p.title).join() === 'A,B' && t.weekly.sections[0].workerId === 'finance.meta', t.weekly);
  ok('brief: headline and actions', t.brief.headline === 'Brief headline' && t.brief.actions[0].title === 'Pause ad set');
  ok('outgoing: to a name, never a number', t.outgoing[0].to === 'Alan' && t.outgoing[0].queuedAt === '2026-10-27T15:50:00.000Z');
  ok('history: sent mail with when', t.history[0].channel === 'email' && t.history[0].at === '2026-10-26T13:00:00.000Z');
  ok('mailbox: direction, other assistant, a readable preview', t.mailbox[0].direction === 'out' && t.mailbox[0].other === 'owner' && t.mailbox[0].preview === 'Worker report', t.mailbox[0]);
  ok('memory: lesson, version, decision, review and note, newest first',
    t.memory.map((m) => m.kind).join(',') === 'lesson,version,decision,note,review' && t.memory[2].text === 'Approved "Pause ad set"' && t.memory[2].by === 'Alan', t.memory);
  ok('company / manager / legal parts are null on a division tab', t.company === null && t.manager === null && t.legal === null);
}

console.log('\n[codes are blanked everywhere]');
{
  const text = JSON.stringify(body);
  ok('no six-digit code survives anywhere in the answer', !/482913|654321|777888|123 456/.test(text));
  ok('the worker headline is blanked in place', body.tab.workers[0].headline === `Reply ${BLANK} to approve the email plan`, body.tab.workers[0].headline);
  ok('an outgoing text: code blanked, phone to last four, email hidden',
    body.tab.outgoing[0].preview === `Your code is ${BLANK}. Call …0142 or write [email]`, body.tab.outgoing[0].preview);
  ok('a lesson: code blanked', body.tab.memory[0].text === `Cite every number; code ${BLANK} never`, body.tab.memory[0].text);
  ok('cleanText: plain six digits', cleanText('code 123456') === `code ${BLANK}`);
  ok('cleanText: split codes', cleanText('482-913 and 482 913') === `${BLANK} and ${BLANK}`, cleanText('482-913 and 482 913'));
  ok('cleanText: money and short numbers stay', cleanText('$15,251.71 from 1,889 sends, 17% on time') === '$15,251.71 from 1,889 sends, 17% on time');
  ok('cleanText: long digit runs are blanked', cleanText('order 12345678901234') === `order ${BLANK}`);
  ok('cleanText: keys and tokens are hidden', cleanText('key eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc and sb_secret_abc123 and service_role') === 'key [hidden] and [hidden] and [hidden]');
  const cut = cleanText(`${'x'.repeat(276)} 987654`, 280);
  ok('cleanText: a code is never cut in half by the length cap', cut.length === 280 && !/\d/.test(cut), cut);
  ok('cleanText: not a string -> null', cleanText(null) === null && cleanText({ a: 1 }) === null && cleanText('   ') === null);
}

console.log('\n[a part that fails is a note, not a broken board]');
{
  const hq = fakeHq(FINANCE_ROWS, { failOn: 'weekly' });
  setHqPool(hq.pool);
  const real = console.error; const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  const r = await h.board(get({ tab: 'finance' }));
  console.error = real;
  const t = json(r).tab;
  ok('still 200', r.statusCode === 200, r.statusCode);
  ok('the failed part falls back and is named in notes', t.weekly === null && t.notes.join() === 'The weekly report could not be read right now.', t.notes);
  ok('the rest of the tab is still read', t.brief?.headline === 'Brief headline' && t.workers.length === 7);
  ok('the failed part rolled back to its savepoint alone', hq.calls.some((c) => c.text === 'rollback to savepoint hq_part'));
  ok('no driver words in the answer or the log', !/secret_table|hq_admin/.test(r.body + logged.join('\n')), logged);
}

console.log('\n[a broken transaction: 500 with the quiet sentence]');
{
  const hq = fakeHq({});
  hq.pool.connect = async () => ({
    async query(text) { if (text === 'begin read only') throw Object.assign(new Error('password authentication failed for user "postgres.secretref"'), { code: '28P01' }); return { rows: [] }; },
    release(broken) { hq.released.push(broken); },
  });
  setHqPool(hq.pool);
  const real = console.error; const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  const r = await h.board(get({ tab: 'finance' }));
  console.error = real;
  ok('500 with the fixed sentence', r.statusCode === 500 && json(r).error === QUIET_SENTENCE, r);
  ok('the broken client is discarded, not reused', hq.released.at(-1) === true);
  ok('no driver words in the answer or the log', !/secretref|password authentication/.test(r.body + logged.join('\n')), logged);
}

console.log('\n[the other tabs]');
{
  const rows = {
    profile: [{ id: 'owner', sms_from: '+15550003333', version: 1, title: 'CEO assistant', reads: [], models: {}, lessons: [] }],
    head: [{ name: 'Ezra', role: 'owner', phone: '+15550004444' }],
    digest: [{ created_at: '2026-10-27T12:00:00Z', text: 'All three divisions reported. Approve with 135790.' }],
    weeklyByDivision: [{ division: 'finance', status: 'act', ceo_line: 'Finance line' }],
    briefByDivision: [{ division: 'finance', status: 'watch', ceo_line: 'Brief line' }, { division: 'salon', status: 'normal', ceo_line: 'Salon line' }],
    heads: [{ assistant_id: 'finance', name: 'Alan' }, { assistant_id: 'online', name: 'Emma' }, { assistant_id: 'salon', name: 'Esther' }],
    latestReview: [{ created_at: '2026-10-27T09:00:00Z', summary: 'All good', scope: 'all' }],
    recommendationsAll: [{ assistant: 'finance', kind: 'lesson', change: 'Check Walmart', status: 'proposed', applied_by: null, at: '2026-10-27T09:00:00Z' }],
    usage: [{ assistant: 'finance', tasks: 9, failed: 1, model_calls: '14', tokens: '52000' }],
    doorReports: [{ tool: 'claude_code', summary: 'Reviewed the Shopify terms', created_at: '2026-10-27T08:00:00Z', reviewed: false }],
  };
  const run = async (text, params) => {
    const rowsOf = rows[NAME_OF.get(text)];
    return typeof rowsOf === 'function' ? rowsOf(params) : rowsOf ?? [];
  };
  const company = await readTab(run, 'company', NOW);
  ok('company: Joey, reports to Ezra, no workers, no weekly', company.profile.name === 'Joey' && company.profile.reportsTo === 'Ezra' && company.workers.length === 0 && company.weekly === null);
  ok('company: the digest, code blanked', company.company.digest.text === `All three divisions reported. Approve with ${BLANK}.`, company.company.digest);
  ok('company: three divisions, status from the brief, line from the weekly report',
    company.company.divisions.map((d) => `${d.id}:${d.manager}:${d.head}:${d.status}:${d.ceoLine}`).join('|')
      === 'finance:George:Alan:watch:Finance line|online:Georgette:Emma:null:null|salon:Cindy:Esther:normal:Salon line', company.company.divisions);
  const manager = await readTab(run, 'manager', NOW);
  ok('manager: latest review, recommendations, usage as numbers',
    manager.manager.latestReview.scope === 'all' && manager.manager.recommendations[0].text === 'Check Walmart' && manager.manager.usage[0].tokens === 52000 && manager.manager.usage[0].modelCalls === 14, manager.manager);
  ok('manager: no workers, no weekly, no company', manager.workers.length === 0 && manager.weekly === null && manager.company === null);
  const legal = await readTab(run, 'legal', NOW);
  ok('legal: door reports', legal.legal.doorReports[0].tool === 'claude_code' && legal.legal.doorReports[0].reviewed === false);
  const salon = await readTab(async () => [], 'salon', NOW);
  ok('salon: salon.clients says plainly it has no data connected', salon.workers.find((w) => w.workerId === 'salon.clients').note === 'No client data is connected yet.');
  ok('an empty HQ is an empty board, not an error', salon.workers.length === 3 && salon.weekly === null && salon.brief === null && salon.notes.length === 0);
}

done('hq-board');
