import { createHash } from 'node:crypto';
import { DEPARTMENTS } from './departments.ts';

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
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{flex:none;display:inline-block;font-size:.75rem;font-weight:700;line-height:1;padding:5px 9px;border-radius:999px;background:var(--tint);color:var(--muted);white-space:nowrap}
.chip.ok{background:var(--green-bg);color:var(--green)}
.chip.warn{background:var(--amber-bg);color:var(--amber)}
.chip.fail{background:var(--red-bg);color:var(--red)}
.empty{padding:16px 14px;color:var(--muted);font-size:.9375rem}
.place{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:20px 18px;margin:24px 0 0}
.place p{margin:8px 0 0;max-width:60ch}
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

  var NAMES = { owner: 'Owner HQ', finance: 'Finance', online: 'Online customer service', salon: 'Salon (Cindy)' };
  var TONE = {
    ok: 'ok', done: 'ok', sent: 'ok', signed: 'ok', answered: 'ok', closed: 'ok',
    refused: 'warn', skipped: 'warn', waiting: 'warn', pending: 'warn', queued: 'warn', running: 'warn',
    open: 'warn', sending: 'warn', expired: 'warn', locked: 'warn', cancelled: 'warn', declined: 'warn',
    failed: 'fail'
  };
  var WORDS = {
    signed: 'approved', pending: 'waiting for a code', running: 'working', queued: 'waiting to start',
    sending: 'sending', ok: 'ok'
  };
  var KINDS = {
    inbound_text: 'A text came in', mailbox: 'A message from another assistant', scheduled: 'A scheduled job',
    request: 'Request', proposal: 'Proposal', decision: 'Decision', report: 'Report'
  };
  var ACTIONS = { forward_plan: 'Send a plan to the finance owner', decide_plan: 'Decide on a plan' };
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

  function section(title, hint, items, build, empty) {
    var s = h('section');
    s.appendChild(h('h2', null, title));
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

  function render(d) {
    var f = document.createDocumentFragment();

    if (d.placeholder) {
      var box = h('div', 'place');
      box.appendChild(h('h2', null, d.name));
      box.appendChild(h('p', null, d.message));
      f.appendChild(box);
      return f;
    }

    var who = h('p', 'who');
    if (d.assistant) {
      who.appendChild(document.createTextNode('Assistant: '));
      who.appendChild(h('b', null, d.assistant.displayName || 'not named yet'));
      who.appendChild(document.createTextNode(d.assistant.number ? ' \\u00b7 texts from ' + d.assistant.number : ' \\u00b7 no texting number yet'));
    } else {
      who.appendChild(document.createTextNode('This assistant has no record yet.'));
    }
    f.appendChild(who);

    if (d.notes && d.notes.length) {
      var notes = h('div', 'notes');
      d.notes.forEach(function (n) { notes.appendChild(h('div', 'note', n)); });
      f.appendChild(notes);
    }

    var cards = h('div', 'cards');
    [['Open tasks', d.counts.openTasks], ['Proposals', d.counts.proposals], ['Approvals waiting', d.counts.pendingApprovals]].forEach(function (c) {
      var card = h('div', 'card');
      card.appendChild(h('div', 'n', num(c[1])));
      card.appendChild(h('div', 'l', c[0]));
      cards.appendChild(card);
    });
    f.appendChild(cards);

    f.appendChild(section('Tasks', 'Work this assistant has been given, newest first.', d.tasks, function (li, t) {
      head(li, KINDS[t.kind] || plain(t.kind), t.status);
      if (t.lastError) li.appendChild(h('div', 'bad', t.lastError));
      li.appendChild(h('div', 'meta', join(['Task ' + t.id, t.attempts + (t.attempts === 1 ? ' try' : ' tries'), when(t.createdAt)])));
    }, 'Nothing yet. A task appears here when someone texts this assistant or another assistant sends it a request.'));

    f.appendChild(section('Activity', 'What the assistant did, step by step, and how long each step took.', d.receipts, function (li, r) {
      head(li, plain(r.step), r.outcome);
      if (r.detail) li.appendChild(h('div', 'text', r.detail));
      li.appendChild(h('div', 'meta', join([r.model, r.dataSource, dur(r.durationMs), r.live === false ? 'practice run' : '', when(r.startedAt)])));
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
    fetch('/api/department/' + encodeURIComponent(id), { cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, body: body }; });
      })
      .then(function (r) {
        if (id !== current || mine !== inflight) return;
        if (!r.ok) throw new Error(r.body && r.body.error ? r.body.error : 'The console could not load this department.');
        var key = JSON.stringify(r.body, function (k, v) { return k === 'generatedAt' ? undefined : v; });
        if (key !== lastKey) { panel.replaceChildren(render(r.body)); lastKey = key; }
        stamp(true);
      })
      .catch(function (err) {
        if (id !== current || mine !== inflight) return;
        if (!lastKey) panel.replaceChildren(h('p', 'loading', (err && err.message) || 'The console could not load this department.'));
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
    try { history.replaceState(null, '', '#' + id); } catch (e) { /* the address bar is optional */ }
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

  var wanted = location.hash.replace('#', '');
  var first = tabs.filter(function (t) { return t.getAttribute('data-id') === wanted; })[0] || tabs[0];
  select(first.getAttribute('data-id'), true);

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

const tabButtons = DEPARTMENTS.map(
  (d) =>
    `<button class="tab" role="tab" type="button" id="tab-${d.id}" data-id="${d.id}" aria-controls="panel" aria-selected="false" tabindex="-1">${escapeHtml(d.name)}</button>`,
).join('\n    ');

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>Fortune AI Headquarters · Admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lato:wght@400;700&amp;family=Playfair+Display:wght@500;600&amp;display=swap">
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Fortune AI Headquarters · Admin</h1>
    <p class="sub">A read-only view of every assistant. Nothing here can send, approve or change anything.</p>
  </header>
  <nav class="tabs" role="tablist" aria-label="Departments">
    ${tabButtons}
  </nav>
  <main id="panel" role="tabpanel">
    <noscript><p class="loading">This page needs JavaScript to show the assistants' live data.</p></noscript>
  </main>
  <footer id="foot"><span id="updated" role="status">Loading…</span> · refreshes every 10 seconds</footer>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;
