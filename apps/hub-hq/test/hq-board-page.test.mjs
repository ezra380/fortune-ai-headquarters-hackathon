// hq-board-page.test.mjs — FORTUNE HQ AS EZRA SEES IT (2026-10-27).
//
// Each desk of test/fixtures/hq-board.json (synthetic 200 bodies of hq-board?tab=<id>) is RENDERED with
// react-dom/server through Vite, exactly as the app compiles the component, and the checks read what is on
// screen: the profile, live tasks, workers, weekly report, outgoing and sent messages, memory, mailbox and
// each desk's own section. A desk with every field null must still render, with a one-line empty state in
// every section. Then the source: no fixture or dev switch in the page, and the nav entry drawn for the owner only.
//
//   node test/hq-board-page.test.mjs     (or: npm test — run-all.mjs discovers it)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { makeAsserts } from './_gate-harness.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vite = await createServer({ root, configFile: false, logLevel: 'silent', appType: 'custom', server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true } });
const { default: HqBoardView } = await vite.ssrLoadModule('/src/components/hq/HqBoardView.jsx');
const fmt = await vite.ssrLoadModule('/src/components/hq/hqFormat.js');
await vite.close();
const { ok, done } = makeAsserts();

const fixture = JSON.parse(readFileSync(join(root, 'test/fixtures/hq-board.json'), 'utf8'));
const NOW = Date.parse(fixture.responses.finance.generatedAt);
const draw = (tab) => renderToStaticMarkup(React.createElement(HqBoardView, { tab, now: NOW, onOpenTab: () => {} }));
const plain = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const count = (html, re) => (html.match(re) || []).length;

console.log('\n[1] the contract: six desks, in board order');
const ids = ['company', 'finance', 'online', 'salon', 'manager', 'legal'];
for (const id of ids) {
  const body = fixture.responses[id];
  ok(`${id}: a 200 body with generatedAt, six tabs and its own tab`, body && body.generatedAt && body.tabs.length === 6 && body.tab.id === id);
}
ok('tabs are in board order', fixture.responses.finance.tabs.map((t) => t.id).join() === ids.join());

console.log('\n[2] Finance (George): every section on screen');
const fin = draw(fixture.responses.finance.tab);
const finText = plain(fin);
ok('profile: name, head and both phones', finText.includes('George') && finText.includes('Reports to Alan') && finText.includes('(929) 555-0142') && finText.includes('(917) 555-0108'));
ok('profile: version, lessons in force and models', finText.includes('Version 7') && finText.includes('Lessons in force') && finText.includes('claude-haiku-5-5'));
ok('live: two running, two queued, with how long', count(fin, /hq-task is-running/g) === 2 && count(fin, /hq-task is-queued/g) === 2 && finText.includes('for 3 min'));
ok('workers: seven cards, one Act and one Watch', count(fin, /<article class="hq-worker/g) === 7 && count(fin, /hq-worker is-act/g) === 1 && count(fin, /hq-worker is-watch/g) === 1);
ok('workers: who wrote it (model or rule)', finText.includes('Written by the model') && finText.includes('Written by rule'));
ok('weekly: goal of the week, three paths, CEO line', finText.includes('Goal of the week') && count((/<ol class="hq-paths">[\s\S]*?<\/ol>/.exec(fin) || [''])[0], /<li>/g) === 3 && finText.includes('For the CEO'));
ok("today's brief is under the weekly report", finText.includes('Today’s brief') || finText.includes("Today's brief"));
ok('going out: text, printout and email, each with its recipient', finText.includes('3 waiting') && finText.includes('Printout') && finText.includes('to Brooklyn salon printer'));
ok('sent history: grouped by day, failures counted and marked', finText.includes('7 sent · 1 failed') && finText.includes('Today') && finText.includes('Yesterday') && count(fin, /class="is-failed"/g) === 1);
ok('memory: lessons, a decision, a review and a version', finText.includes('5 kept') && ['Lesson', 'Decision', 'Review', 'Version'].every((k) => finText.includes(k)));
ok('mailbox: asks between divisions, named', finText.includes('3 between desks') && finText.includes('Cindy') && finText.includes('Joey'));
ok('a six-digit code in a queued text never reaches the screen', !fin.includes('482913') && fin.includes('••••••'));

console.log('\n[3] Salon (Cindy): a worker with no data says so plainly');
const sal = plain(draw(fixture.responses.salon.tab));
ok('salon.clients reads "No data is connected to this worker yet."', sal.includes('No data is connected to this worker yet.') && sal.includes('No data'));
ok('empty lists on this desk have their one line', sal.includes('Nothing is waiting to go out.') && sal.includes('Nothing has gone out from this desk yet.') && sal.includes('Nothing is kept in memory for this desk yet.'));
ok('string actions render', sal.includes('Offer Wednesday afternoon'));

console.log('\n[4] the desks with their own sections');
const co = draw(fixture.responses.company.tab);
ok('company: CEO digest and the three divisions, one line each', plain(co).includes('CEO digest') && count(co, /class="hq-div-row"/g) === 3);
ok('company: no empty Workers section on the CEO desk', !co.includes('aria-label="Workers"'));
const mg = plain(draw(fixture.responses.manager.tab));
ok('manager: latest review, recommendations and usage', mg.includes('Latest review') && mg.includes('3 on file') && mg.includes('640,200'));
const lg = plain(draw(fixture.responses.legal.tab));
ok('legal: door reports with review state', lg.includes('Door reports') && lg.includes('Awaiting review') && lg.includes('Reviewed'));

console.log('\n[5] every field null or missing: still a calm page');
let bare = '';
let threw = null;
try { bare = plain(draw({ id: 'finance', label: 'George', profile: null, head: null, live: null, workers: null, weekly: null, brief: null, outgoing: null, history: null, memory: null, mailbox: null, company: null, manager: null, legal: null })); } catch (e) { threw = String(e); }
ok('a desk of nulls renders', threw === null, threw);
ok('each section says what is missing in one line', ['Nothing running right now', 'No weekly report has been written', 'Nothing is waiting to go out', 'Nothing has gone out', 'Nothing is kept in memory', 'No asks between divisions', 'No daily workers report'].every((s) => bare.includes(s)));
let none = '';
try { none = plain(draw(null)); } catch (e) { threw = String(e); }
ok('no tab at all renders', threw === null && none.includes('Live now'));
const odd = { workers: [{ workerId: 'finance.meta', status: 'act', findings: [{ text: 'x', cites: null }], history: [{ reportDate: 'not a date', status: 'weird' }] }], history: [{ channel: 'pigeon', at: 'never', status: null }], memory: [{ kind: 'mystery', text: null }] };
try { draw(odd); threw = null; } catch (e) { threw = String(e); }
ok('unexpected values (unknown channel, bad dates, null text) do not throw', threw === null, threw);

console.log('\n[6] formatters');
ok('phones read as (929) 555-0142', fmt.phoneOf('+19295550142') === '(929) 555-0142' && fmt.phoneOf('929-555-0142') === '(929) 555-0142' && fmt.phoneOf('ext 12') === 'ext 12');
ok('codes are blanked like the console does', fmt.clean('code 123456 and 12345678') === 'code •••••• and ••••••' && fmt.clean('12345') === '12345');
ok('company days are not shifted by the viewer\'s time zone', fmt.dayOf('2026-10-27') === 'Oct 27');

console.log('\n[7] the source: no fixture in the page, the door drawn for the owner only');
const page = readFileSync(join(root, 'src/pages/FortuneHQ.jsx'), 'utf8');
const app = readFileSync(join(root, 'src/App.jsx'), 'utf8');
const access = readFileSync(join(root, 'src/lib/hqAccess.js'), 'utf8');
const code = (s) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
ok('the page reads hq-board only, with no fixture and no dev switch', !/fixture|import\.meta\.env|localStorage/i.test(code(page)) && /api\.hqBoard\(/.test(page));
ok('the nav entry is behind the owner check', /\{hqOwner && \(\s*<NavDropdown id="hq"/.test(app) && /const hqOwner = useHqOwner\(auth\)/.test(app));
ok('the owner list is exactly one address', /HQ_OWNER_EMAILS = \['ezra@fortunewigs\.com'\]/.test(access));
ok('routes exist for admins only (the server is the wall)', /auth\.role === 'admin' && <Route path="\/hq\/:tab" element=\{<FortuneHQ \/>\} \/>/.test(app));

done('hq-board-page (react-dom/server render of the Fortune HQ desks against test/fixtures/hq-board.json)');
