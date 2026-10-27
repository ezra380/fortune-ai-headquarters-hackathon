import { createHash } from 'node:crypto';
import { MANAGERS } from '@fahq/contracts';
import { TABS } from './departments.ts';
import type { BriefDivision } from './divisions.ts';
import { BRIEF_DIVISIONS } from './divisions.ts';

// The single page. Static HTML plus one small script that fetches /api/department/:id every 10
// seconds and draws it. The script builds the page with createElement and textContent only (never
// innerHTML), so no text from the database can ever become markup. The Content-Security-Policy
// allows exactly this one script and this one style block, by hash.

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const STYLE = `
:root{--ink:#1f1f1f;--ivory:#faf8f4;--muted:#6b6b6b;--line:#e7e2d9;--paper:#ffffff;
--green:#2f6b3f;--green-bg:#e6f0e5;--amber:#7a5200;--amber-bg:#faefd2;--red:#a12a2a;--red-bg:#f8e3e0;--tint:#f1ede4}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ivory);color:var(--ink);font:16px/1.5 Lato,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:960px;margin:0 auto;padding:28px 16px 56px}
h1,h2{font-family:"Playfair Display",Georgia,"Times New Roman",serif;font-weight:600;margin:0;letter-spacing:.005em}
h1{font-size:clamp(1.5rem,5.5vw,2.125rem);line-height:1.15}
h2{font-size:1.25rem;line-height:1.25}
h3{font:700 .9375rem/1.3 Lato,system-ui,sans-serif;margin:0}
.sub{margin:8px 0 0;color:var(--muted);font-size:.9375rem;max-width:60ch}
.tabs{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:24px 0 0}
.tab{font:inherit;font-size:.9375rem;font-weight:700;line-height:1.3;text-align:left;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--muted);cursor:pointer;min-height:44px}
.tab[aria-selected=true]{color:var(--ink);background:var(--paper);border-color:var(--ink)}
.tab:hover{color:var(--ink)}
.tab:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
@media(min-width:760px){
.tabs{display:flex;flex-wrap:wrap;gap:0 4px;border-bottom:1px solid var(--line)}
.tab{border:0;border-bottom:2px solid transparent;border-radius:0;padding:10px 14px 12px;margin-bottom:-1px}
.tab[aria-selected=true]{background:transparent;border-bottom-color:var(--ink)}
}
.who{margin:20px 0 0;color:var(--muted);font-size:.9375rem}
.who b{color:var(--ink)}
.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:16px 0 0}
.card{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.card .n{font-family:"Playfair Display",Georgia,serif;font-weight:600;font-size:1.75rem;line-height:1.1}
.card .l{margin-top:2px;color:var(--muted);font-size:.8125rem;line-height:1.3}
.notes{margin:16px 0 0;display:grid;gap:8px}
.note{border:1px solid #ecd9a6;background:var(--amber-bg);color:#4d3400;border-radius:12px;padding:10px 14px;font-size:.9rem;overflow-wrap:anywhere}
section{margin:36px 0 0}
section section{margin:22px 0 0}
.hint{margin:4px 0 12px;color:var(--muted);font-size:.9rem;max-width:62ch}
.list{margin:0;padding:0;list-style:none;background:var(--paper);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.row{padding:12px 14px;border-top:1px solid var(--line);display:grid;gap:4px;min-width:0}
.row:first-child{border-top:0}
.head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;min-width:0}
.title{font-weight:700;min-width:0;overflow-wrap:anywhere}
.meta{color:var(--muted);font-size:.8125rem;overflow-wrap:anywhere}
.text{font-size:.9375rem;white-space:pre-wrap;overflow-wrap:anywhere}
.bad{color:var(--red);font-size:.875rem;overflow-wrap:anywhere}
.plans{margin:2px 0 0;padding-left:1.25rem;font-size:.9375rem}
.plans li{overflow-wrap:anywhere}
.rec{display:grid;gap:4px;min-width:0;margin-top:6px;padding-top:10px;border-top:1px solid var(--line)}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{flex:none;display:inline-block;font-size:.75rem;font-weight:700;line-height:1;padding:5px 9px;border-radius:999px;background:var(--tint);color:var(--muted);white-space:nowrap}
.chip.ok{background:var(--green-bg);color:var(--green)}
.chip.warn{background:var(--amber-bg);color:var(--amber)}
.chip.fail{background:var(--red-bg);color:var(--red)}
.empty{padding:16px 14px;color:var(--muted);font-size:.9375rem}
.digest{margin:2px 0 0}
.subs{display:flex;flex-wrap:wrap;gap:8px;margin:20px 0 0}
.sub{font:inherit;font-size:.875rem;font-weight:700;line-height:1.3;padding:8px 14px;border:1px solid var(--line);border-radius:999px;background:transparent;color:var(--muted);cursor:pointer;min-height:40px}
.sub[aria-pressed=true]{color:var(--ink);background:var(--paper);border-color:var(--ink)}
.sub:hover{color:var(--ink)}
.sub:focus-visible,.link:focus-visible,summary:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.chips .sub{min-height:36px;padding:6px 12px}
.link{display:inline-block;color:var(--ink);font-size:.875rem;font-weight:700;text-decoration:underline;text-underline-offset:3px;margin:2px 12px 2px 0;overflow-wrap:anywhere}
h3.sec{margin:14px 0 4px}
.label{margin:10px 0 2px;color:var(--muted);font-size:.8125rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
details.worker summary{cursor:pointer;display:grid;gap:4px;list-style:none}
details.worker summary::-webkit-details-marker{display:none}
details.worker .wline{font-size:.9375rem;overflow-wrap:anywhere}
details.worker .wbody{margin:10px 0 0;padding-top:8px;border-top:1px solid var(--line)}
.nums{margin:2px 0 0;padding:0;list-style:none;display:grid;gap:2px}
.nums li{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 10px;font-size:.9375rem;min-width:0}
.nums .nl{overflow-wrap:anywhere}
.nums .nv{font-variant-numeric:tabular-nums}
.week{margin:2px 0 0;padding:0;list-style:none;display:grid;gap:6px}
.week li{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;min-width:0}
.week .wk{font-size:.9375rem;overflow-wrap:anywhere;min-width:0}
footer{margin:48px 0 0;padding-top:14px;border-top:1px solid var(--line);color:var(--muted);font-size:.8125rem}
footer.stale #updated{color:var(--red)}
.loading{margin:32px 0 0;color:var(--muted)}
@media(max-width:420px){.card{padding:10px}.card .n{font-size:1.5rem}}
@media(prefers-reduced-motion:no-preference){.tab{transition:color .15s,border-color .15s,background-color .15s}}
`;

// No template literals, backslashes or innerHTML in here: this is plain browser script.
const SCRIPT = `
(function () {
  'use strict';
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  var panel = document.getElementById('panel');
  var updated = document.getElementById('updated');
  var foot = document.getElementById('foot');
  var current = '';
  var lastKey = '';
  var inflight = 0;
  // A head's own page (/?division=finance) shows that division only, and asks the server for it alone.
  var HEAD = (function () {
    var m = /(?:^|[?&])division=(finance|online|salon)(?:&|$)/.exec(location.search || '');
    return m ? m[1] : '';
  })();
  var SUBS = [['overview', 'Company'], ['finance', 'Finance'], ['online', 'Online'], ['salon', 'Salon']];
  // Which part of the Divisions view is open: the company at a glance, or one division's tab.
  var sub = HEAD || 'overview';
  var lastBody = null;

  var NAMES = { owner: 'Owner HQ', finance: 'Finance', online: 'Online customer service', manager: 'HQ Manager', salon: 'Salon (Cindy)' };
  var TONE = {
    ok: 'ok', done: 'ok', sent: 'ok', signed: 'ok', answered: 'ok', closed: 'ok', adopted: 'ok',
    refused: 'warn', skipped: 'warn', waiting: 'warn', pending: 'warn', queued: 'warn', running: 'warn',
    open: 'warn', sending: 'warn', expired: 'warn', locked: 'warn', cancelled: 'warn', declined: 'warn',
    retrying: 'warn', proposed: 'warn', unknown: 'warn',
    normal: 'ok', watch: 'warn', act: 'fail', approved: 'ok',
    awaiting: 'warn', code_expired: 'warn', code_locked: 'warn', rule: 'warn',
    unanswered: 'warn', unavailable: 'fail', unreadable: 'warn',
    failed: 'fail'
  };
  var WORDS = {
    signed: 'approved', pending: 'waiting for a code', running: 'working', queued: 'waiting to start',
    sending: 'sending', ok: 'ok',
    normal: 'running normally', watch: 'needs a look', act: 'needs a decision',
    awaiting: 'waiting for a code', code_expired: 'code expired', code_locked: 'code locked', not_approved: 'not approved', no_code: 'no code sent',
    rule: 'written by rules', unanswered: 'waiting for an answer', unavailable: 'could not answer', unreadable: 'could not be read'
  };
  var KINDS = {
    inbound_text: 'A text came in', mailbox: 'A message from another assistant', scheduled: 'A scheduled job',
    request: 'Request', proposal: 'Proposal', decision: 'Decision', report: 'Report'
  };
  var ACTIONS = { forward_plan: 'Send a plan to the finance owner', decide_plan: 'Decide on a plan', adopt_change: 'Adopt a change', approve_action: 'Approve a brief action' };
  var DIVISION = { salon: 'Salon', finance: 'Finance', online: 'Online', hq: 'HQ' };
  var ABOUT = {
    salon: 'The salon assistant is a stand-in for Cindy, working on synthetic salon data. Cindy\\u2019s own app keeps her family and personal data; none of it is read here.'
  };
  var CHANNELS = { sms: 'Text message', print: 'Printout' };

  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function chip(status) {
    var s = String(status || '');
    return h('span', 'chip ' + (TONE[s] || ''), WORDS[s] || s || 'unknown');
  }
  function when(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function dur(ms) {
    if (ms === null || ms === undefined) return '';
    return ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s';
  }
  function plain(s) { return String(s || '').replace(/[._]/g, ' '); }
  function join(parts) { return parts.filter(function (p) { return p; }).join(' \\u00b7 '); }
  function num(n) { return n === null || n === undefined ? '\\u2013' : String(n); }
  function fmt(n) { return n === null || n === undefined ? '\\u2013' : Number(n).toLocaleString(); }
  function tokens(inTokens, outTokens) {
    var none = function (n) { return n === null || n === undefined; };
    if (none(inTokens) && none(outTokens)) return '';
    return fmt(inTokens) + ' in / ' + fmt(outTokens) + ' out tokens';
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function nameOf(id) { return Object.prototype.hasOwnProperty.call(NAMES, id) ? NAMES[id] : id; }

  function section(title, hint, items, build, empty, level) {
    var s = h('section');
    s.appendChild(h(level || 'h2', null, title));
    s.appendChild(h('p', 'hint', hint));
    if (!items || !items.length) {
      s.appendChild(h('div', 'list empty', empty));
      return s;
    }
    var ul = h('ul', 'list');
    items.forEach(function (item) {
      var li = h('li', 'row');
      build(li, item);
      ul.appendChild(li);
    });
    s.appendChild(ul);
    return s;
  }
  function head(li, title, status) {
    var top = h('div', 'head');
    top.appendChild(h('div', 'title', title));
    if (status) top.appendChild(chip(status));
    li.appendChild(top);
  }

  var REPORTS_HINT = 'Work reports: what each task did, how many model calls and tokens it used, and what it suggests.';

  function reportsSection(d) {
    var mine = d.id === 'manager';
    return section('Work reports', REPORTS_HINT + (mine ? ' The latest 30, across all assistants.' : ' The latest 15 for this assistant.'), d.reports, function (li, r) {
      head(li, nameOf(r.assistant) + ': ' + plain(r.taskKind), r.outcome);
      li.appendChild(h('div', 'text', r.summary));
      var bits = [r.taskId ? 'Task ' + r.taskId : '', plural(r.modelCalls, 'model call', 'model calls'), tokens(r.inputTokens, r.outputTokens), dur(r.durationMs)];
      if (r.codeMode) {
        bits.push('Code Mode: ' + plural(r.codeMode.scripts, 'script', 'scripts') + ', ' + plural(r.codeMode.toolCalls, 'lookup', 'lookups') + ', ' + fmt(r.codeMode.resultChars) + ' characters back');
      }
      bits.push(when(r.endedAt));
      li.appendChild(h('div', 'meta', join(bits)));
      if (r.suggestions && r.suggestions.length) {
        var ul = h('ul', 'plans');
        r.suggestions.forEach(function (s) {
          ul.appendChild(h('li', null, 'Suggests (' + plain(s.kind) + (s.about ? ', ' + nameOf(s.about) : '') + '): ' + s.text));
        });
        li.appendChild(ul);
      }
    }, 'Nothing yet. A report appears here when a task finishes, with what it did and what it used.');
  }

  function managerSections(f, m) {
    var unread = function (part) { return m.unread && m.unread.indexOf(part) >= 0; };

    var rowsForUsage = m.usage
      ? m.usage.rows.map(function (u) { return { label: nameOf(u.assistant), u: u }; }).concat([{ label: 'All assistants', u: m.usage.total }])
      : [];
    f.appendChild(section('Usage, last 24 hours', 'Finished tasks per assistant, with the model calls and tokens they used.', rowsForUsage, function (li, item) {
      var u = item.u;
      head(li, item.label);
      li.appendChild(h('div', 'text', join([
        plural(u.tasks, 'task', 'tasks'), u.done + ' done', u.failed + ' failed', u.retrying ? u.retrying + ' retrying' : '',
        plural(u.modelCalls, 'model call', 'model calls'), fmt(u.inputTokens) + ' tokens in', fmt(u.outputTokens) + ' tokens out'
      ])));
    }, 'The last 24 hours of work reports could not be read right now. See the notes above.'));

    f.appendChild(section('Latest review', 'The HQ Manager looks over recent work reports and recommends changes. A recommendation changes nothing until the owner adopts it with a code.', m.review ? [m.review] : [], function (li, rv) {
      head(li, 'Reviewed ' + when(rv.createdAt));
      li.appendChild(h('div', 'meta', join(['Covers ' + when(rv.coversFrom) + ' to ' + when(rv.coversTo), plural(rv.reportCount, 'report', 'reports'), rv.model])));
      li.appendChild(h('div', 'text', rv.summary || 'The summary could not be read.'));
      if (rv.findings.length) {
        var ul = h('ul', 'plans');
        rv.findings.forEach(function (x) { ul.appendChild(h('li', null, nameOf(x.assistant) + ': ' + x.text)); });
        li.appendChild(ul);
      }
      rv.recommendations.forEach(function (rec) {
        var box = h('div', 'rec');
        head(box, (rec.rank ? rec.rank + '. ' : '') + nameOf(rec.assistant) + ': ' + rec.change, rec.status);
        if (rec.why) box.appendChild(h('div', 'text', 'Why: ' + rec.why));
        box.appendChild(h('div', 'meta', rec.status === 'adopted' ? 'Adopted ' + when(rec.decidedAt) : rec.status === 'expired' ? 'Expired without being adopted' : 'Not adopted yet'));
        li.appendChild(box);
      });
    }, unread('review') ? 'The latest review could not be read right now. See the notes above.' : 'No review yet. The HQ Manager writes one after it has looked over recent work reports.'));

    f.appendChild(section('Standing lessons', 'Recommendations the owner adopted with a code, newest first.', m.lessons, function (li, l) {
      head(li, nameOf(l.assistant));
      li.appendChild(h('div', 'text', l.change));
      li.appendChild(h('div', 'meta', 'Adopted ' + when(l.adoptedAt)));
    }, unread('lessons') ? 'The standing lessons could not be read right now. See the notes above.' : 'None yet. A recommendation becomes a standing lesson only after the owner adopts it with a code.'));
  }

  function notesBlock(f, list) {
    if (!list || !list.length) return;
    var notes = h('div', 'notes');
    list.forEach(function (n) { notes.appendChild(h('div', 'note', n)); });
    f.appendChild(notes);
  }
  function has(list, part) { return !!list && list.indexOf(part) >= 0; }
  function basedOn(cites) { return cites && cites.length ? 'Based on ' + cites.join(', ') : ''; }

  // what: the document the code belongs to, "brief" or "report" (a weekly report's paths and actions are approved the same way).
  function actionNote(ap, what) {
    var noun = what || 'brief';
    var thing = noun === 'brief' ? 'action' : 'choice';
    if (ap.state === 'approved') return 'Approved ' + when(ap.at);
    if (ap.state === 'awaiting') return 'A code is waiting. It expires ' + when(ap.at);
    if (ap.state === 'code_expired') return 'The code expired ' + when(ap.at) + ' and this ' + thing + ' was not approved';
    if (ap.state === 'code_locked') return 'The code was locked after wrong tries';
    if (ap.state === 'not_approved') return 'The code was used for other ' + thing + 's ' + when(ap.at);
    if (ap.state === 'no_code') return 'No code was sent for this ' + noun;
    return 'Where this ' + thing + ' stands could not be read right now';
  }

  function briefRow(li, b) {
    head(li, 'Brief for ' + (b.date || 'an unknown day'), b.writtenBy === 'rule' ? 'rule' : '');
    li.appendChild(h('div', 'text', b.headline));
    li.appendChild(h('div', 'meta', 'Written ' + when(b.createdAt)));
    if (b.findings.length) {
      var ul = h('ul', 'plans');
      b.findings.forEach(function (x) {
        var item = h('li', null, x.text);
        if (x.cites.length) item.appendChild(h('div', 'meta', basedOn(x.cites)));
        ul.appendChild(item);
      });
      li.appendChild(ul);
    }
    b.actions.forEach(function (a) {
      var box = h('div', 'rec');
      head(box, a.rank + '. ' + a.title, a.approval.state);
      if (a.why) box.appendChild(h('div', 'text', 'Why: ' + a.why));
      if (a.steps) box.appendChild(h('div', 'text', 'Steps: ' + a.steps));
      box.appendChild(h('div', 'meta', join([actionNote(a.approval), basedOn(a.cites)])));
      li.appendChild(box);
    });
    if (!b.actions.length) li.appendChild(h('div', 'meta', 'This brief proposes no action, so there is nothing for the head to approve.'));
    li.appendChild(h('div', 'meta', 'Line to the CEO division: ' + b.ceoLine));
  }

  function requestSection(title, hint, list, empty) {
    return section(title, hint, list, function (li, q) {
      head(li, DIVISION[q.from] + ' asked ' + DIVISION[q.to], q.state);
      li.appendChild(h('div', 'text', q.question));
      if (q.reason) li.appendChild(h('div', 'bad', q.reason));
      li.appendChild(h('div', 'meta', join(['Asked ' + when(q.askedAt), q.answeredAt ? 'Answered ' + when(q.answeredAt) : ''])));
    }, empty, 'h3');
  }

  // ---- Wave 2: each division's manager, its workers' reports and its weekly report ----

  function managerLine(v) { return v.manager.name + ', ' + v.manager.title + ', reports to ' + v.manager.reportsTo; }
  function button(label, onClick) {
    var b = h('button', 'sub', label);
    b.setAttribute('type', 'button');
    b.addEventListener('click', onClick);
    return b;
  }
  function link(text, href) {
    var a = h('a', 'link', text);
    a.setAttribute('href', href);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener');
    return a;
  }
  // A report's PDF is made by the console when this is opened. On a head's page the link names the division, so the server
  // refuses any other division's report.
  function pdfHref(kind, id) { return '/report/' + kind + '/' + encodeURIComponent(id) + '.pdf' + (HEAD ? '?division=' + HEAD : ''); }
  function day(s) {
    if (!s) return '';
    var d = new Date(s + 'T12:00:00Z');
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  }
  function label(text) { return h('div', 'label', text); }
  function numbersList(list) {
    var ul = h('ul', 'nums');
    list.forEach(function (n) {
      var li = h('li', null);
      li.appendChild(h('span', 'nl', n.label));
      if (n.shown) li.appendChild(h('b', 'nv', n.shown));
      li.appendChild(h('span', 'meta', n.id));
      ul.appendChild(li);
    });
    return ul;
  }
  function plainList(items) {
    var ul = h('ul', 'plans');
    items.forEach(function (t) { ul.appendChild(h('li', null, t)); });
    return ul;
  }

  function standingLine(wk) {
    if (!wk.sent) return 'this report has not been sent to the head yet, so there is no code to approve against.';
    var yes = wk.options.filter(function (o) { return o.approval.state === 'approved'; }).map(function (o) { return o.kind + ' ' + o.rank; });
    if (yes.length) return (yes.length === 1 ? yes[0] : yes.slice(0, -1).join(', ') + ' and ' + yes[yes.length - 1]) + ' approved.';
    var ap = wk.options[0].approval;
    if (ap.state === 'awaiting') return 'a code is waiting for the head. It expires ' + when(ap.at) + '.';
    if (ap.state === 'code_expired') return 'the code expired ' + when(ap.at) + ' and nothing was approved.';
    if (ap.state === 'code_locked') return 'the code was locked after wrong tries.';
    if (ap.state === 'not_approved') return 'the code was used, but not for any of these.';
    if (ap.state === 'no_code') return 'no code has been sent for this report yet.';
    return 'it could not be read right now.';
  }

  function optionBox(o) {
    var box = h('div', 'rec');
    head(box, (o.kind === 'path' ? 'Path ' : 'Action ') + o.rank + '. ' + o.title, o.approval.state);
    box.appendChild(h('div', 'text', o.why));
    if (o.steps.length) {
      box.appendChild(label(o.kind === 'path' ? 'What to do' : 'How'));
      box.appendChild(plainList(o.steps));
    }
    if (o.numbers.length) {
      box.appendChild(label('The numbers behind it'));
      box.appendChild(numbersList(o.numbers));
    }
    o.projections.forEach(function (p) {
      box.appendChild(h('div', 'text', p.text));
      box.appendChild(h('div', 'meta', 'Assumption: ' + p.assumption));
    });
    if (o.test) box.appendChild(h('div', 'text', 'Test: ' + o.test));
    if (o.stopLoss) box.appendChild(h('div', 'text', 'Stop-loss: ' + o.stopLoss));
    if (o.risks.length) box.appendChild(h('div', 'meta', 'Risks: ' + o.risks.join('; ')));
    box.appendChild(h('div', 'meta', actionNote(o.approval, 'report')));
    return box;
  }

  function weeklyRow(li, v, wk) {
    var top = h('div', 'head');
    top.appendChild(h('div', 'title', 'Week of ' + day(wk.weekOf)));
    if (wk.writtenBy === 'rule') top.appendChild(chip('rule'));
    li.appendChild(top);
    li.appendChild(h('div', 'meta', join(['Written ' + when(wk.createdAt), 'Numbers from ' + wk.period])));
    if (wk.id) li.appendChild(link('Open the PDF packet', pdfHref('weekly', wk.id)));
    li.appendChild(h('div', 'text', wk.summary));
    if (wk.writtenBy === 'rule') {
      li.appendChild(h('div', 'meta', "A program wrote this report from the rules, because the model's words did not pass their number check" + (v.id === 'finance' ? ', so it has no goal and no paths.' : '.')));
    }
    if (wk.goal) {
      var g = h('div', 'rec');
      g.appendChild(h('h3', 'sec', 'Goal of the week'));
      g.appendChild(h('div', 'title', wk.goal.title));
      g.appendChild(h('div', 'text', wk.goal.metric + ': from ' + wk.goal.from + ' to ' + wk.goal.to + ' by ' + wk.goal.by));
      g.appendChild(h('div', 'text', wk.goal.why));
      li.appendChild(g);
    }
    if (wk.options.length) {
      li.appendChild(h('h3', 'sec', wk.goal ? 'Three paths to the goal' : 'Actions for ' + v.manager.reportsTo));
      wk.options.forEach(function (o) { li.appendChild(optionBox(o)); });
      li.appendChild(h('div', 'meta', 'Where it stands: ' + standingLine(wk)));
    }
    if (wk.asked.length) {
      li.appendChild(h('h3', 'sec', 'Asked of other divisions'));
      wk.asked.forEach(function (a) {
        var box = h('div', 'rec');
        box.appendChild(h('div', 'title', 'To ' + (DIVISION[a.division] || a.division) + ': ' + a.question));
        box.appendChild(h('div', 'text', a.ok ? a.answer : 'No answer. ' + a.answer));
        li.appendChild(box);
      });
    }
    li.appendChild(h('h3', 'sec', 'What each worker found'));
    wk.sections.forEach(function (x) {
      var box = h('div', 'rec');
      head(box, x.label, x.status);
      box.appendChild(h('div', 'text', x.summary));
      if (x.numbers.length) box.appendChild(numbersList(x.numbers));
      li.appendChild(box);
    });
    li.appendChild(h('div', 'meta', 'Line to the CEO division: ' + wk.ceoLine));
    li.appendChild(h('div', 'meta', 'Source: ' + wk.source));
  }

  function weeklySection(v) {
    var wk = v.reports.weekly;
    var s = h('section');
    var top = h('div', 'head');
    top.appendChild(h('h2', null, 'Weekly report'));
    if (wk) top.appendChild(chip(wk.status));
    s.appendChild(top);
    s.appendChild(h('p', 'hint', 'Written by ' + v.manager.name + ' for ' + v.manager.reportsTo + " from the workers' reports. " + v.manager.reportsTo
      + ' chooses by texting APPROVE and a number, with the one-time code; nothing is carried out by the program.'));
    if (!wk) {
      s.appendChild(h('div', 'list empty', has(v.reports.unread, 'weekly')
        ? 'The latest weekly report could not be read right now. See the notes above.'
        : 'No weekly report yet. It is written on Mondays at 7:30, or when the owner or the head texts REPORT.'));
      return s;
    }
    var ul = h('ul', 'list');
    var li = h('li', 'row');
    weeklyRow(li, v, wk);
    ul.appendChild(li);
    s.appendChild(ul);
    return s;
  }

  function workerLine(slot) {
    if (slot.state === 'ok') return slot.latest.headline;
    if (slot.state === 'none') return 'No report yet. This worker reports each morning at 7:00.';
    if (slot.state === 'unreadable') return 'Its latest report could not be read in full. See the notes above.';
    return 'Its reports could not be read right now. See the notes above.';
  }

  function workerCard(slot) {
    var r = slot.latest;
    var d = h('details', 'worker');
    // A worker that found something is open; one that found nothing is one line.
    if (r && r.status !== 'normal') d.setAttribute('open', '');
    var s = h('summary', null);
    var top = h('span', 'head');
    top.appendChild(h('span', 'title', slot.label));
    if (r) top.appendChild(chip(r.status));
    s.appendChild(top);
    s.appendChild(h('span', 'wline', workerLine(slot)));
    d.appendChild(s);
    var body = h('div', 'wbody');
    if (r) {
      body.appendChild(h('div', 'meta', join(['Report for ' + day(r.day), 'numbers from ' + r.period, slot.stale ? 'older than seven days' : '', 'written ' + when(r.createdAt),
        r.writtenBy === 'rule' ? 'written by rules' : ''])));
      if (r.findings.length) {
        body.appendChild(label('What it found'));
        var ul = h('ul', 'plans');
        r.findings.forEach(function (x) {
          var item = h('li', null, x.text);
          if (x.cites.length) item.appendChild(h('div', 'meta', basedOn(x.cites)));
          ul.appendChild(item);
        });
        body.appendChild(ul);
      }
      if (r.rules.length) {
        body.appendChild(label('Rules that fired'));
        body.appendChild(plainList(r.rules.map(function (x) { return (x.level === 'act' ? 'Needs action' : 'Worth a look') + ': ' + x.rule + ' (' + x.metricId + ')'; })));
      }
      body.appendChild(label('Key numbers'));
      body.appendChild(numbersList(r.numbers));
      if (r.moreNumbers) body.appendChild(h('div', 'meta', plural(r.moreNumbers, 'more number', 'more numbers') + ' in the data.'));
      r.rows.forEach(function (row) {
        body.appendChild(label('Row totals: ' + row.read));
        var rl = h('ul', 'nums');
        row.totals.forEach(function (t) {
          var item = h('li', null);
          item.appendChild(h('span', 'nl', t.label));
          item.appendChild(h('b', 'nv', t.shown));
          rl.appendChild(item);
        });
        body.appendChild(rl);
      });
      body.appendChild(h('div', 'meta', 'Source: ' + r.source));
      if (r.id) body.appendChild(link('Open this report as a PDF', pdfHref('worker', r.id)));
    }
    if (slot.week.length) {
      body.appendChild(label('Last seven days'));
      var days = h('ul', 'week');
      slot.week.forEach(function (x) {
        var item = h('li', null);
        item.appendChild(h('span', 'meta', day(x.day)));
        item.appendChild(chip(x.status));
        item.appendChild(h('span', 'wk', x.headline));
        days.appendChild(item);
      });
      body.appendChild(days);
    }
    d.appendChild(body);
    return d;
  }

  function workersSection(v) {
    return section('Daily workers', 'Each worker reads one part of the division’s numbers every morning at 7:00 and reports. Open one for its findings, its key numbers and the last seven days.',
      v.reports.workers, function (li, slot) { li.appendChild(workerCard(slot)); }, 'This division has no workers.');
  }

  function crewLine(v) {
    return plural(v.reports.workers.length, 'worker', 'workers') + " read their part of the division's numbers each morning at 7:00. " + v.manager.name + ' writes the weekly report for '
      + v.manager.reportsTo + ' on Mondays at 7:30 from what they found.';
  }

  // One division's tab: its manager, the weekly report, the workers, then the daily brief and the questions.
  function divisionTab(v, requestsUnread, notes) {
    var f = document.createDocumentFragment();
    f.appendChild(h('p', 'who', managerLine(v)));
    f.appendChild(h('p', 'hint', crewLine(v)));
    notesBlock(f, notes);
    f.appendChild(weeklySection(v));
    f.appendChild(workersSection(v));
    f.appendChild(divisionSection(v, requestsUnread, true));
    return f;
  }

  function divisionSection(v, requestsUnread, inTab) {
    var s = h('section');
    var top = h('div', 'head');
    top.appendChild(h('h2', null, inTab ? 'Daily brief' : v.name + ' division'));
    if (v.brief) top.appendChild(chip(v.brief.status));
    s.appendChild(top);
    s.appendChild(h('p', 'hint', 'Its assistant writes to ' + v.head + '. The head approves an action by texting back the one-time code.'));
    if (!inTab) {
      var wk = v.reports && v.reports.weekly;
      var standing = wk ? 'Weekly report for the week of ' + day(wk.weekOf) + ': ' + (WORDS[wk.status] || wk.status) + '.'
        : has(v.reports && v.reports.unread, 'weekly') ? 'The weekly report could not be read right now.' : 'No weekly report yet.';
      s.appendChild(h('p', 'hint', managerLine(v) + '. ' + standing));
      var go = h('div', 'chips');
      go.appendChild(button('Open the ' + v.name + ' tab', function () { openSub(v.id); }));
      go.appendChild(link('Open the head’s view', '/?division=' + v.id));
      s.appendChild(go);
    }
    if (v.brief) {
      var ul = h('ul', 'list');
      var li = h('li', 'row');
      briefRow(li, v.brief);
      ul.appendChild(li);
      s.appendChild(ul);
    } else {
      s.appendChild(h('div', 'list empty', has(v.unread, 'brief')
        ? 'The latest brief could not be read right now. See the notes above.'
        : 'No brief yet. It is written each morning, or when the owner or the head texts BRIEF.'));
    }
    var gone = requestsUnread ? 'The data requests could not be read right now. See the notes above.' : '';
    s.appendChild(requestSection('Questions it asked', 'What this division needed from another division, and what came back.', v.asked,
      gone || 'None. It has asked nothing of the other divisions.'));
    s.appendChild(requestSection('Questions it was asked', 'What other divisions needed from this one. It answers from its own data.', v.received,
      gone || 'None. No other division has asked it anything.'));
    return s;
  }

  function digestSection(d) {
    return section('CEO digest', 'The very short text Owner HQ sends the owner: one line per division. The heads get the detail in their own briefs.',
      d.digest ? [d.digest] : [], function (li, dg) {
        li.appendChild(h('div', 'text digest', dg.text));
        var chips = h('div', 'chips');
        dg.reports.forEach(function (r) {
          var label = r.state === 'in' ? (WORDS[r.status] || r.status) : r.state === 'missing' ? 'no report yet' : 'report could not be read';
          var tone = r.state === 'in' ? (TONE[r.status] || '') : 'warn';
          chips.appendChild(h('span', 'chip ' + tone, (DIVISION[r.division] || r.division) + ': ' + label));
        });
        li.appendChild(chips);
        li.appendChild(h('div', 'meta', 'Written ' + when(dg.createdAt)));
      }, has(d.unread, 'digest')
        ? 'The latest digest could not be read right now. See the notes above.'
        : 'No digest yet. Owner HQ writes one each morning once the divisions have reported.');
  }

  function subnav() {
    var nav = h('div', 'subs');
    nav.setAttribute('role', 'group');
    nav.setAttribute('aria-label', 'Company or one division');
    SUBS.forEach(function (x) {
      var b = button(x[1], function () { openSub(x[0]); });
      b.setAttribute('aria-pressed', sub === x[0] ? 'true' : 'false');
      nav.appendChild(b);
    });
    return nav;
  }

  function renderDivisions(d) {
    var f = document.createDocumentFragment();
    var block = null;
    d.divisions.forEach(function (v) { if (v.id === sub) block = v; });
    if (!HEAD) f.appendChild(subnav());
    if (block) {
      f.appendChild(divisionTab(block, has(d.unread, 'requests'), d.notes));
      return f;
    }
    if (HEAD) {
      f.appendChild(h('p', 'who', 'This division could not be read right now.'));
      notesBlock(f, d.notes);
      return f;
    }
    f.appendChild(h('p', 'who', 'The company at a glance: each division\\u2019s latest brief and where its actions stand, the questions the divisions asked each other, and the CEO digest. Read-only: approvals are made by text with a one-time code, never here.'));
    notesBlock(f, d.notes);
    f.appendChild(digestSection(d));
    d.divisions.forEach(function (v) { f.appendChild(divisionSection(v, has(d.unread, 'requests'), false)); });
    return f;
  }

  // What was drawn last is kept, so pressing a tab draws from it without asking the server again.
  function keyOf(body) { return sub + '|' + JSON.stringify(body, function (k, v) { return k === 'generatedAt' ? undefined : v; }); }
  function openSub(id) {
    sub = id;
    try { history.replaceState(null, '', id === 'overview' ? '#divisions' : '#divisions/' + id); } catch (e) { /* the address bar is optional */ }
    if (lastBody) {
      panel.replaceChildren(renderDivisions(lastBody));
      lastKey = keyOf(lastBody);
    }
  }

  function render(d) {
    var f = document.createDocumentFragment();

    var who = h('p', 'who');
    if (d.assistant) {
      who.appendChild(document.createTextNode('Assistant: '));
      who.appendChild(h('b', null, d.assistant.displayName || 'not named yet'));
      who.appendChild(document.createTextNode(d.assistant.number ? ' \\u00b7 texts from ' + d.assistant.number
        : d.id === 'manager' ? ' \\u00b7 has no number; it reaches the owner through Owner HQ' : ' \\u00b7 no texting number yet'));
    } else {
      who.appendChild(document.createTextNode('This assistant has no record yet.'));
    }
    f.appendChild(who);
    if (ABOUT[d.id]) f.appendChild(h('p', 'hint', ABOUT[d.id]));

    notesBlock(f, d.notes);

    var cards = h('div', 'cards');
    [['Open tasks', d.counts.openTasks], ['Proposals', d.counts.proposals], ['Approvals waiting', d.counts.pendingApprovals]].forEach(function (c) {
      var card = h('div', 'card');
      card.appendChild(h('div', 'n', num(c[1])));
      card.appendChild(h('div', 'l', c[0]));
      cards.appendChild(card);
    });
    f.appendChild(cards);

    if (d.manager) {
      managerSections(f, d.manager);
      f.appendChild(reportsSection(d));
    }

    f.appendChild(section('Tasks', 'Work this assistant has been given, newest first.', d.tasks, function (li, t) {
      head(li, KINDS[t.kind] || plain(t.kind), t.status);
      if (t.lastError) li.appendChild(h('div', 'bad', t.lastError));
      li.appendChild(h('div', 'meta', join(['Task ' + t.id, t.attempts + (t.attempts === 1 ? ' try' : ' tries'), when(t.createdAt)])));
    }, 'Nothing yet. A task appears here when someone texts this assistant or another assistant sends it a request.'));

    if (!d.manager) f.appendChild(reportsSection(d));

    f.appendChild(section('Activity', 'What the assistant did, step by step, how long each step took and the tokens it used.', d.receipts, function (li, r) {
      head(li, plain(r.step), r.outcome);
      if (r.detail) li.appendChild(h('div', 'text', r.detail));
      li.appendChild(h('div', 'meta', join([r.model, r.dataSource, dur(r.durationMs), tokens(r.inputTokens, r.outputTokens), r.live === false ? 'practice run' : '', when(r.startedAt)])));
    }, 'Nothing yet. Each step the assistant takes is listed here with the model and data it used.'));

    f.appendChild(section('Mailbox', 'Requests, proposals and decisions passed between assistants. Only the plan titles are shown.', d.mailbox, function (li, m) {
      head(li, (KINDS[m.kind] || plain(m.kind)) + ': ' + (NAMES[m.from] || m.from) + ' to ' + (NAMES[m.to] || m.to), m.status);
      if (m.planTitles && m.planTitles.length) {
        var ol = h('ol', 'plans');
        m.planTitles.forEach(function (t) { ol.appendChild(h('li', null, t)); });
        li.appendChild(ol);
      }
      li.appendChild(h('div', 'meta', when(m.createdAt)));
    }, 'Nothing yet. Messages between assistants appear here, such as a request for plans or a proposal sent back.'));

    f.appendChild(section('Approvals', 'A person approves with a one-time code. The codes themselves are never shown here.', d.approvals, function (li, a) {
      head(li, ACTIONS[a.action] || plain(a.action), a.status);
      li.appendChild(h('div', 'meta', a.decidedAt ? 'Decided ' + when(a.decidedAt) : a.expiresAt ? (a.status === 'expired' ? 'Expired ' : 'Expires ') + when(a.expiresAt) : ''));
    }, 'Nothing yet. When a proposal needs a person to decide, the request shows here until they answer or it expires.'));

    f.appendChild(section('Texts and printouts', 'Messages this assistant sent or queued. Six-digit codes are blanked.', d.outbox, function (li, o) {
      head(li, CHANNELS[o.channel] || plain(o.channel), o.status);
      li.appendChild(h('div', 'text', o.body));
      if (o.lastError) li.appendChild(h('div', 'bad', o.lastError));
      li.appendChild(h('div', 'meta', join(['Created ' + when(o.createdAt), o.sentAt ? 'Sent ' + when(o.sentAt) : ''])));
    }, 'Nothing yet. Texts and printouts to registered people appear here, with their delivery status.'));

    f.appendChild(section('Memory', 'Decisions people made that this assistant remembers. Unapproved ideas are not kept here.', d.memory, function (li, m) {
      li.appendChild(h('div', 'text', m.text));
      var tags = m.tags.filter(function (t) { return t.indexOf('proposal:') !== 0; });
      if (tags.length) {
        var row = h('div', 'chips');
        tags.forEach(function (t) { row.appendChild(h('span', 'chip', t)); });
        li.appendChild(row);
      }
    }, 'Nothing yet. A decision appears here after a person approves or declines a plan.'));

    f.appendChild(section('Shared record', 'The company record of who asked what, who proposed what and who decided. Latest 30 entries, newest first.', d.timeline, function (li, e) {
      head(li, plain(e.type));
      li.appendChild(h('div', 'meta', join([when(e.at), e.id])));
    }, 'Nothing yet. Requests, proposals and decisions are added to the shared record as they happen.'));

    return f;
  }

  function stamp(ok) {
    var t = new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    updated.textContent = ok ? 'Updated ' + t : 'Could not refresh at ' + t + '. Showing the last view that loaded.';
    foot.className = ok ? '' : 'stale';
  }

  function load(fresh) {
    var id = current;
    var mine = ++inflight;
    if (fresh) { lastKey = ''; panel.replaceChildren(h('p', 'loading', 'Loading\\u2026')); }
    var url = id === 'divisions' ? '/api/divisions' + (HEAD ? '?division=' + HEAD : '') : '/api/department/' + encodeURIComponent(id);
    fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, body: body }; });
      })
      .then(function (r) {
        if (id !== current || mine !== inflight) return;
        if (!r.ok) throw new Error(r.body && r.body.error ? r.body.error : 'The console could not load this view.');
        lastBody = id === 'divisions' ? r.body : null;
        var key = id === 'divisions' ? keyOf(r.body) : JSON.stringify(r.body, function (k, v) { return k === 'generatedAt' ? undefined : v; });
        if (key !== lastKey) { panel.replaceChildren(id === 'divisions' ? renderDivisions(r.body) : render(r.body)); lastKey = key; }
        stamp(true);
      })
      .catch(function (err) {
        if (id !== current || mine !== inflight) return;
        if (!lastKey) panel.replaceChildren(h('p', 'loading', (err && err.message) || 'The console could not load this view.'));
        stamp(false);
      });
  }

  function select(id, fresh) {
    current = id;
    tabs.forEach(function (t) {
      var on = t.getAttribute('data-id') === id;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', 'tab-' + id);
    try { history.replaceState(null, '', '#' + id + (id === 'divisions' && sub !== 'overview' ? '/' + sub : '')); } catch (e) { /* the address bar is optional */ }
    load(fresh);
  }

  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { select(t.getAttribute('data-id'), true); });
    t.addEventListener('keydown', function (ev) {
      var to = ev.key === 'ArrowRight' ? i + 1 : ev.key === 'ArrowLeft' ? i - 1 : -1;
      if (to < 0) return;
      var next = tabs[(to + tabs.length) % tabs.length];
      next.focus();
      select(next.getAttribute('data-id'), true);
      ev.preventDefault();
    });
  });

  if (HEAD) {
    // A head's page has no tabs: it asks for its own division and draws that.
    current = 'divisions';
    load(true);
  } else {
    // #divisions/finance opens the Finance tab of the Divisions view.
    var wanted = location.hash.replace('#', '').split('/');
    var first = tabs.filter(function (t) { return t.getAttribute('data-id') === wanted[0]; })[0] || tabs[0];
    if (first.getAttribute('data-id') === 'divisions' && ['finance', 'online', 'salon'].indexOf(wanted[1]) >= 0) sub = wanted[1];
    select(first.getAttribute('data-id'), true);
  }

  setInterval(function () { if (!document.hidden) load(false); }, 10000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(false); });
})();
`;

const sha256 = (s: string): string => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;

/** The Content-Security-Policy that matches this page exactly: one script, one style block, same-origin data. */
export const PAGE_CSP = [
  "default-src 'none'",
  `script-src ${sha256(SCRIPT)}`,
  `style-src ${sha256(STYLE)} https://fonts.googleapis.com`,
  'font-src https://fonts.gstatic.com',
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const tabButtons = TABS.map(
  (d) =>
    `<button class="tab" role="tab" type="button" id="tab-${d.id}" data-id="${d.id}" aria-controls="panel" aria-selected="false" tabindex="-1">${escapeHtml(d.name)}</button>`,
).join('\n    ');

type PageParts = { title: string; heading: string; sub: string; nav: string; footer: string };

const documentOf = (p: PageParts): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${p.title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lato:wght@400;700&amp;family=Playfair+Display:wght@500;600&amp;display=swap">
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${p.heading}</h1>
    <p class="sub">${p.sub}</p>
  </header>
${p.nav}  <main id="panel" role="tabpanel">
    <noscript><p class="loading">This page needs JavaScript to show the assistants' live data.</p></noscript>
  </main>
  <footer id="foot">${p.footer}</footer>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;

/** The owner's page: the Divisions view and one tab per department. */
export const PAGE_HTML = documentOf({
  title: 'Fortune AI Headquarters · Admin',
  heading: 'Fortune AI Headquarters · Admin',
  sub: "A read-only view of the company's divisions and of every assistant. Nothing here can send, approve or change anything.",
  nav: `  <nav class="tabs" role="tablist" aria-label="Divisions and departments">
    ${tabButtons}
  </nav>
`,
  footer: '<span id="updated" role="status">Loading…</span> · refreshes every 10 seconds',
});

/**
 * A head's own page (/?division=finance): the same script and style under the same policy, with no tabs. The script reads the
 * division from the address and asks the server for that division only, so nothing of the others is ever fetched. In production the
 * heads' sites go into the Fortune Hub; this page is what they will show there.
 */
export function headPageHtml(division: BriefDivision): string {
  const name = escapeHtml(BRIEF_DIVISIONS.find((d) => d.id === division)?.name ?? division);
  const m = MANAGERS[division];
  return documentOf({
    title: `Fortune AI Headquarters · ${name} division`,
    heading: `${name} division`,
    sub: `${escapeHtml(m.manager)}, ${escapeHtml(m.title)}, reports to ${escapeHtml(m.head)}. A read-only view of this division only. Nothing here can send, approve or change anything.`,
    nav: '',
    footer: `<span id="updated" role="status">Loading…</span> · refreshes every 10 seconds<br>This is the head's view of the ${name} division only. In production, each head's site is part of the Fortune Hub.`,
  });
}
