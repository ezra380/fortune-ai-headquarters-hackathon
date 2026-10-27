// HqBoardView — one desk of the Fortune HQ board (Ezra, 2026-10-27), drawn from the `tab` object that
// netlify/functions/hq-board.js returns. Presentation only: no fetching, no clocks of its own (`now` comes in),
// so it renders the same on the server in test/hq-board-page.test.mjs as in the browser. Every field may be
// null or empty; each section then says so in one line rather than leaving a blank.
import React, { useState } from 'react';
import {
  assistantName, assistantTab, clean, timeOf, stampOf, dayOf, dayHeading, sinceOf, phoneOf,
  STATUS_LABEL, statusKey, channelKey, channelLabel, deliveryLabel, failed, memoryLabel, workerLabel, num, list,
} from './hqFormat.js';

/** @param {{ status?: string|null, label?: string }} props */
export function StatusBadge({ status, label }) {
  const key = statusKey(status);
  return <span className={`hq-status hq-status--${key}`}>{label || STATUS_LABEL[key] || 'No report'}</span>;
}

/** @param {{ title: string, meta?: string, children?: any }} props */
function CardHead({ title, meta, children }) {
  return (
    <header className="hq-card-head">
      <h3>{title}</h3>
      {meta ? <span className="hq-card-meta">{meta}</span> : null}
      {children}
    </header>
  );
}

/** @param {{ children?: any }} props */
const Empty = ({ children }) => <p className="hq-empty">{children}</p>;

function Cites({ cites }) {
  const ids = list(cites);
  if (!ids.length) return null;
  return <span className="hq-cites">{ids.map((c) => <code key={c}>{clean(c)}</code>)}</span>;
}

// ---- profile + live ------------------------------------------------------------------------------------

function ProfileCard({ profile, head, label }) {
  const p = profile || {};
  const name = p.name || label || 'Assistant';
  const models = Object.entries(p.models && typeof p.models === 'object' ? p.models : {});
  const reads = list(p.reads);
  return (
    <section className="card hq-profile" aria-label={`${name} profile`}>
      <div className="hq-profile-top">
        <span className="hq-monogram" aria-hidden="true">{String(name).trim()[0] || 'F'}</span>
        <div className="hq-profile-id">
          {p.title ? <p className="hq-kicker">{clean(p.title)}</p> : null}
          <h2 className="hq-name">{clean(name)}</h2>
          <p className="hq-reports">{p.reportsTo ? <>Reports to <b>{clean(p.reportsTo)}</b></> : 'Reports to the owner'}</p>
        </div>
      </div>
      <dl className="hq-facts">
        <div><dt>Sending number</dt><dd className="hq-num">{p.phone ? phoneOf(p.phone) : 'No number of its own'}</dd></div>
        <div>
          <dt>Head of division</dt>
          <dd>{head?.name ? <>{clean(head.name)}{head.role ? <span className="hq-soft"> · {clean(head.role)}</span> : null}
            {head.phone ? <span className="hq-num hq-block">{phoneOf(head.phone)}</span> : null}</> : 'Reports straight to the owner'}</dd>
        </div>
        <div><dt>Profile</dt><dd>{p.version ? `Version ${clean(p.version)}` : 'No version yet'}{p.updatedAt ? <span className="hq-soft hq-block">Updated {stampOf(p.updatedAt)}</span> : null}</dd></div>
        <div><dt>Lessons in force</dt><dd className="hq-big-num">{num(p.lessonsInForce ?? 0)}</dd></div>
      </dl>
      {models.length ? (
        <div className="hq-profile-row">
          <span className="hq-micro">Models</span>
          <ul className="hq-pills">{models.map(([job, model]) => (
            <li key={job}><span className="hq-pill-k">{clean(job)}</span><span className="hq-pill-v">{clean(model)}</span></li>
          ))}</ul>
        </div>
      ) : null}
      {reads.length ? (
        <div className="hq-profile-row">
          <span className="hq-micro">Reads</span>
          <span className="hq-cites hq-cites--loose">{reads.map((r) => <code key={r}>{clean(r)}</code>)}</span>
        </div>
      ) : null}
    </section>
  );
}

function LiveCard({ live, name, now }) {
  const running = list(live?.running);
  const queued = list(live?.queued);
  const rows = [...running.map((t) => ({ ...t, state: 'running' })), ...queued.map((t) => ({ ...t, state: 'queued' }))];
  return (
    <section className="card hq-live" aria-label="Live now">
      <CardHead title="Live now"><span className={`hq-pulse${running.length ? '' : ' is-quiet'}`} aria-hidden="true" /></CardHead>
      <div className="hq-live-counts">
        <div><b className="hq-num">{running.length}</b><span>Running</span></div>
        <div><b className="hq-num">{queued.length}</b><span>Queued</span></div>
      </div>
      {rows.length ? (
        <ul className="hq-tasks">
          {rows.map((t, i) => (
            <li key={t.id || `${t.state}-${i}`} className={`hq-task is-${t.state}`}>
              <span className="hq-task-state">{t.state === 'running' ? 'Running' : 'Queued'}</span>
              <span className="hq-task-label">{clean(t.label || t.kind || 'Task')}</span>
              <span className="hq-task-since">{sinceOf(t.since, now)}</span>
            </li>
          ))}
        </ul>
      ) : <Empty>Nothing running right now. {name} is between rounds.</Empty>}
    </section>
  );
}

// ---- workers -------------------------------------------------------------------------------------------

function WeekStrip({ history }) {
  const days = list(history).slice(0, 7).reverse();
  if (!days.length) return null;
  return (
    <span className="hq-week" aria-label="Last seven days">
      {days.map((d, i) => <span key={d.reportDate || i} className={`hq-week-day is-${statusKey(d.status)}`} title={`${dayOf(d.reportDate)} · ${STATUS_LABEL[statusKey(d.status)] || 'No report'}`} />)}
    </span>
  );
}

function WorkerCard({ w }) {
  const [open, setOpen] = useState(false);
  const key = statusKey(w.status);
  const findings = list(w.findings);
  const history = list(w.history);
  const label = workerLabel(w);
  const noData = !w.status;
  return (
    <article className={`hq-worker is-${key}${open ? ' is-open' : ''}`}>
      <button type="button" className="hq-worker-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)} disabled={noData && !w.note && !history.length}>
        <span className="hq-worker-top">
          <span className="hq-worker-label">{label}</span>
          <StatusBadge status={w.status} label={noData ? 'No data' : undefined} />
        </span>
        <span className="hq-worker-headline">{noData ? clean(w.note || 'No data is connected to this worker yet.') : clean(w.headline || 'Report written without a headline.')}</span>
        <span className="hq-worker-meta">
          {noData ? <span>Waiting on its data source</span> : <span>{w.writtenBy === 'rule' ? 'Written by rule' : 'Written by the model'}{w.reportDate ? ` · ${dayOf(w.reportDate)}` : ''}</span>}
          <WeekStrip history={history} />
        </span>
      </button>
      {open ? (
        <div className="hq-worker-detail">
          {findings.length ? (
            <>
              <span className="hq-micro">Findings</span>
              <ol className="hq-findings">
                {findings.map((f, i) => <li key={i}><span>{clean(f?.text ?? f)}</span><Cites cites={f?.cites} /></li>)}
              </ol>
            </>
          ) : <Empty>No findings on this report.</Empty>}
          {history.length ? (
            <>
              <span className="hq-micro">Last 7 days</span>
              <ul className="hq-days">
                {history.slice(0, 7).map((d, i) => (
                  <li key={d.reportDate || i}>
                    <span className="hq-days-date">{dayOf(d.reportDate, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
                    <StatusBadge status={d.status} />
                    <span className="hq-days-head">{clean(d.headline)}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {w.createdAt ? <p className="hq-foot">Filed {stampOf(w.createdAt)}</p> : null}
        </div>
      ) : null}
    </article>
  );
}

function Workers({ workers, name }) {
  const ws = list(workers);
  const act = ws.filter((w) => w.status === 'act').length;
  const watch = ws.filter((w) => w.status === 'watch').length;
  return (
    <section className="hq-section" aria-label="Workers">
      <div className="hq-section-head">
        <h2>Workers</h2>
        <span className="hq-section-sub">
          {ws.length ? `${ws.length} on the desk${act ? ` · ${act} to act on` : ''}${watch ? ` · ${watch} to watch` : ''}` : ''}
        </span>
      </div>
      {ws.length
        ? <div className="hq-workers">{ws.map((w, i) => <WorkerCard key={w.workerId || i} w={w} />)}</div>
        : <div className="card"><Empty>No daily workers report to {name}; the division managers report up to this desk.</Empty></div>}
    </section>
  );
}

// ---- weekly report -------------------------------------------------------------------------------------

function ActionItem({ a, i }) {
  if (typeof a === 'string') return <li><span className="hq-rank">{String(i + 1).padStart(2, '0')}</span><div><p>{clean(a)}</p></div></li>;
  return (
    <li>
      <span className="hq-rank">{String(a?.rank ?? i + 1).padStart(2, '0')}</span>
      <div>
        <p className="hq-action-title">{clean(a?.title || a?.text || 'Action')}</p>
        {a?.why ? <p className="hq-soft">{clean(a.why)}</p> : null}
        {a?.steps ? <p className="hq-steps">{clean(a.steps)}</p> : null}
        <Cites cites={a?.cites} />
      </div>
    </li>
  );
}

function Goal({ goal }) {
  if (!goal) return null;
  return (
    <div className="hq-goal">
      <span className="hq-micro">Goal of the week</span>
      <p className="hq-goal-title">{clean(goal.title)}</p>
      {goal.from !== undefined && goal.to !== undefined ? (
        <p className="hq-goal-move"><span className="hq-num">{num(goal.from)}</span><span className="hq-arrow" aria-hidden="true">to</span><span className="hq-num">{num(goal.to)}</span>{goal.by ? <span className="hq-soft"> by {dayOf(goal.by)}</span> : null}</p>
      ) : null}
      {goal.why ? <p className="hq-soft">{clean(goal.why)}</p> : null}
      <Cites cites={goal.metricId ? [goal.metricId] : []} />
    </div>
  );
}

function WeeklyCard({ weekly, workers, brief }) {
  const w = weekly;
  const labels = Object.fromEntries(list(workers).map((x) => [x.workerId, workerLabel(x)]));
  if (!w) {
    return (
      <section className="card hq-weekly" aria-label="Weekly report">
        <CardHead title="Weekly report" />
        <Empty>No weekly report has been written for this desk yet.</Empty>
        {brief ? <BriefBlock brief={brief} /> : null}
      </section>
    );
  }
  const paths = list(w.paths);
  const actions = list(w.actions);
  const sections = list(w.sections);
  return (
    <section className="card hq-weekly" aria-label="Weekly report">
      <CardHead title="Weekly report" meta={w.weekOf ? `Week of ${dayOf(w.weekOf, { month: 'long', day: 'numeric' })}` : ''}>
        <StatusBadge status={w.status} />
      </CardHead>
      {w.summary ? <p className="hq-lede">{clean(w.summary)}</p> : null}
      <Goal goal={w.goal} />
      {paths.length ? (
        <>
          <span className="hq-micro">Three paths</span>
          <ol className="hq-paths">
            {paths.map((p, i) => (
              <li key={i}>
                <span className="hq-rank">{String(p?.rank ?? i + 1).padStart(2, '0')}</span>
                <p className="hq-action-title">{clean(p?.title)}</p>
                <p className="hq-soft">{clean(p?.summary)}</p>
              </li>
            ))}
          </ol>
        </>
      ) : null}
      {actions.length ? (
        <>
          <span className="hq-micro">Actions for approval</span>
          <ol className="hq-actions">{actions.map((a, i) => <ActionItem key={i} a={a} i={i} />)}</ol>
        </>
      ) : null}
      {sections.length ? (
        <>
          <span className="hq-micro">By worker</span>
          <ul className="hq-sections">
            {sections.map((s, i) => (
              <li key={s.workerId || i}>
                <span className="hq-sections-name">{labels[s.workerId] || workerLabel(s)}</span>
                <StatusBadge status={s.status} />
                <span className="hq-sections-text">{clean(s.summary)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {w.ceoLine ? (
        <blockquote className="hq-ceo-line"><span className="hq-micro">For the CEO</span><p>{clean(w.ceoLine)}</p></blockquote>
      ) : null}
      {brief ? <BriefBlock brief={brief} /> : null}
      {w.createdAt ? <p className="hq-foot">Written {stampOf(w.createdAt)}</p> : null}
    </section>
  );
}

function BriefBlock({ brief }) {
  const actions = list(brief.actions);
  return (
    <div className="hq-brief">
      <div className="hq-brief-head">
        <span className="hq-micro">Today&rsquo;s brief{brief.date ? ` · ${dayOf(brief.date)}` : ''}</span>
        <StatusBadge status={brief.status} />
      </div>
      {brief.headline ? <p className="hq-action-title">{clean(brief.headline)}</p> : null}
      {actions.length ? <ol className="hq-actions hq-actions--tight">{actions.map((a, i) => <ActionItem key={i} a={a} i={i} />)}</ol> : null}
    </div>
  );
}

// ---- outgoing + history --------------------------------------------------------------------------------

/** The message as it reads to the person who gets it: a text bubble, a lettered email, a printed slip. */
function Preview({ channel, text }) {
  const c = channelKey(channel);
  const body = clean(text) || 'No preview kept.';
  if (c === 'email') {
    return <div className="hq-preview hq-preview--email"><span className="hq-preview-mast">Fortune Wigs</span><p>{body}</p></div>;
  }
  if (c === 'print') {
    return <div className="hq-preview hq-preview--print"><span className="hq-preview-mast">Fortune Wigs · Printout</span><p>{body}</p></div>;
  }
  return <div className="hq-preview hq-preview--sms"><p>{body}</p></div>;
}

function OutgoingCard({ outgoing }) {
  const rows = list(outgoing);
  return (
    <section className="card hq-outgoing" aria-label="Going out">
      <CardHead title="Going out" meta={rows.length ? `${rows.length} waiting` : ''} />
      {rows.length ? (
        <ul className="hq-out-list">
          {rows.map((m, i) => (
            <li key={m.id || i}>
              <div className="hq-msg-top">
                <span className={`hq-channel is-${channelKey(m.channel)}`}>{channelLabel(m.channel)}</span>
                <span className="hq-msg-to">to {clean(m.to) || 'unknown'}</span>
                <span className="hq-msg-when">{m.queuedAt ? `queued ${timeOf(m.queuedAt)}` : ''}</span>
              </div>
              <Preview channel={m.channel} text={m.preview} />
              {m.status ? <span className="hq-msg-status">{deliveryLabel(m.status)}</span> : null}
            </li>
          ))}
        </ul>
      ) : <Empty>Nothing is waiting to go out.</Empty>}
    </section>
  );
}

function HistoryCard({ history, now }) {
  const [all, setAll] = useState(false);
  const rows = list(history);
  const shown = all ? rows : rows.slice(0, 12);
  const groups = [];
  for (const m of shown) {
    const h = dayHeading(m.at, now);
    if (!groups.length || groups[groups.length - 1].h !== h) groups.push({ h, items: [] });
    groups[groups.length - 1].items.push(m);
  }
  const failures = rows.filter((m) => failed(m.status)).length;
  return (
    <section className="card hq-history" aria-label="Sent history">
      <CardHead title="Sent history" meta={rows.length ? `${rows.length} sent${failures ? ` · ${failures} failed` : ''}` : ''} />
      {rows.length ? (
        <>
          {groups.map((g) => (
            <div key={g.h} className="hq-day-group">
              <h4 className="hq-day-head">{g.h}</h4>
              <ol className="hq-timeline">
                {g.items.map((m, i) => (
                  <li key={m.id || `${g.h}-${i}`} className={failed(m.status) ? 'is-failed' : ''}>
                    <span className="hq-tl-time hq-num">{timeOf(m.at)}</span>
                    <span className="hq-tl-dot" aria-hidden="true" />
                    <div className="hq-tl-body">
                      <div className="hq-msg-top">
                        <span className={`hq-channel is-${channelKey(m.channel)}`}>{channelLabel(m.channel)}</span>
                        <span className="hq-msg-to">to {clean(m.to) || 'unknown'}</span>
                        <span className={`hq-msg-status${failed(m.status) ? ' is-failed' : ''}`}>{deliveryLabel(m.status) || 'Sent'}</span>
                      </div>
                      <Preview channel={m.channel} text={m.preview} />
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ))}
          {rows.length > 12 ? (
            <button type="button" className="btn-quiet hq-more" onClick={() => setAll((a) => !a)}>
              {all ? 'Show the latest 12' : `Show all ${rows.length}`}
            </button>
          ) : null}
        </>
      ) : <Empty>Nothing has gone out from this desk yet.</Empty>}
    </section>
  );
}

// ---- memory + mailbox ----------------------------------------------------------------------------------

const MEMORY_ORDER = ['lesson', 'decision', 'review', 'version', 'note'];

function MemoryCard({ memory }) {
  const rows = list(memory);
  const kinds = MEMORY_ORDER.filter((k) => rows.some((m) => m.kind === k));
  const [kind, setKind] = useState('all');
  const shown = kind === 'all' ? rows : rows.filter((m) => m.kind === kind);
  return (
    <section className="card hq-memory" aria-label="Memory">
      <CardHead title="Memory" meta={rows.length ? `${rows.length} kept` : ''} />
      {kinds.length > 1 ? (
        <div className="segmented hq-seg" role="group" aria-label="Show memory of kind">
          <button type="button" className={kind === 'all' ? 'on' : ''} aria-pressed={kind === 'all'} onClick={() => setKind('all')}>All</button>
          {kinds.map((k) => (
            <button key={k} type="button" className={kind === k ? 'on' : ''} aria-pressed={kind === k} onClick={() => setKind(k)}>{memoryLabel(k)}s</button>
          ))}
        </div>
      ) : null}
      {shown.length ? (
        <ul className="hq-mem-list">
          {shown.map((m, i) => (
            <li key={i} className={`is-${m.kind || 'note'}`}>
              <span className="hq-mem-kind">{memoryLabel(m.kind)}</span>
              <p>{clean(m.text)}</p>
              <span className="hq-mem-by">{m.by ? `${clean(m.by)} · ` : ''}{stampOf(m.at)}</span>
            </li>
          ))}
        </ul>
      ) : <Empty>Nothing is kept in memory for this desk yet.</Empty>}
    </section>
  );
}

function MailboxCard({ mailbox, onOpenTab }) {
  const rows = list(mailbox);
  return (
    <section className="card hq-mailbox" aria-label="Mailbox">
      <CardHead title="Mailbox" meta={rows.length ? `${rows.length} between desks` : ''} />
      {rows.length ? (
        <ul className="hq-mail-list">
          {rows.map((m, i) => (
            <li key={i}>
              <div className="hq-msg-top">
                <span className="hq-mail-dir">{m.direction === 'in' ? 'From' : 'To'}</span>
                {onOpenTab && m.other ? (
                  <button type="button" className="btn-quiet hq-mail-who" onClick={() => onOpenTab(assistantTab(m.other))}>{assistantName(m.other)}</button>
                ) : <span className="hq-mail-who">{assistantName(m.other)}</span>}
                {m.kind ? <span className="hq-kind">{clean(m.kind)}</span> : null}
                <span className="hq-msg-when">{stampOf(m.at)}</span>
              </div>
              <p className="hq-mail-text">{clean(m.preview)}</p>
            </li>
          ))}
        </ul>
      ) : <Empty>No asks between divisions yet.</Empty>}
    </section>
  );
}

// ---- desk-only sections --------------------------------------------------------------------------------

function CompanySection({ company, onOpenTab }) {
  if (!company) return null;
  const divisions = list(company.divisions);
  return (
    <div className="hq-split hq-split--company">
      <section className="card hq-digest" aria-label="CEO digest">
        <CardHead title="CEO digest" meta={company.digest?.at ? `Joey · ${stampOf(company.digest.at)}` : 'Joey'} />
        {company.digest?.text
          ? <blockquote className="hq-digest-text">{clean(company.digest.text)}</blockquote>
          : <Empty>Joey has not sent a digest yet today.</Empty>}
      </section>
      <section className="card hq-divisions" aria-label="Divisions">
        <CardHead title="Divisions" meta="One line each" />
        {divisions.length ? (
          <ul className="hq-div-list">
            {divisions.map((d, i) => (
              <li key={d.id || i}>
                <button type="button" className="hq-div-row" onClick={() => onOpenTab && d.id && onOpenTab(d.id)}>
                  <span className="hq-div-name">{clean(d.manager || assistantName(d.id))}<span className="hq-soft">{d.head ? ` for ${clean(d.head)}` : ''}</span></span>
                  <StatusBadge status={d.status} />
                  <span className="hq-div-line">{clean(d.ceoLine) || 'No line for the CEO yet.'}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : <Empty>No division has reported up yet.</Empty>}
      </section>
    </div>
  );
}

function ManagerSection({ manager, onOpenTab }) {
  if (!manager) return null;
  const recs = list(manager.recommendations);
  const usage = list(manager.usage);
  const r = manager.latestReview;
  return (
    <div className="hq-split hq-split--manager">
      <div className="hq-col">
        <section className="card hq-review" aria-label="Latest review">
          <CardHead title="Latest review" meta={r?.at ? stampOf(r.at) : ''}>{r?.scope ? <span className="hq-kind">{clean(r.scope)}</span> : null}</CardHead>
          {r?.summary ? <p className="hq-lede">{clean(r.summary)}</p> : <Empty>The HQ Manager has not reviewed the desks yet.</Empty>}
        </section>
        <section className="card" aria-label="Recommendations">
          <CardHead title="Recommendations" meta={recs.length ? `${recs.length} on file` : ''} />
          {recs.length ? (
            <ul className="hq-recs">
              {recs.map((x, i) => (
                <li key={i}>
                  <div className="hq-msg-top">
                    {onOpenTab && x.assistant
                      ? <button type="button" className="btn-quiet hq-mail-who" onClick={() => onOpenTab(assistantTab(x.assistant))}>{assistantName(x.assistant)}</button>
                      : <span className="hq-mail-who">{assistantName(x.assistant)}</span>}
                    {x.kind ? <span className="hq-kind">{clean(x.kind)}</span> : null}
                    <span className={`hq-rec-status is-${String(x.status || 'open').toLowerCase()}`}>{deliveryLabel(x.status) || 'Open'}</span>
                  </div>
                  <p>{clean(x.text)}</p>
                  <span className="hq-mem-by">{x.appliedBy ? `Applied by ${clean(x.appliedBy)} · ` : ''}{stampOf(x.at)}</span>
                </li>
              ))}
            </ul>
          ) : <Empty>No recommendations yet.</Empty>}
        </section>
      </div>
      <section className="card hq-usage" aria-label="Usage">
        <CardHead title="Usage" meta="By assistant" />
        {usage.length ? (
          <div className="hq-table-wrap">
            <table className="simple hq-table">
              <thead><tr><th>Assistant</th><th>Tasks</th><th>Failed</th><th>Model calls</th><th>Tokens</th></tr></thead>
              <tbody>
                {usage.map((u, i) => (
                  <tr key={u.assistant || i}>
                    <td>{assistantName(u.assistant)}</td>
                    <td className="hq-num">{num(u.tasks)}</td>
                    <td className={`hq-num${Number(u.failed) > 0 ? ' is-strong' : ''}`}>{num(u.failed)}</td>
                    <td className="hq-num">{num(u.modelCalls)}</td>
                    <td className="hq-num">{num(u.tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>No usage recorded yet.</Empty>}
      </section>
    </div>
  );
}

function LegalSection({ legal }) {
  if (!legal) return null;
  const rows = list(legal.doorReports);
  const open = rows.filter((d) => !d.reviewed).length;
  return (
    <section className="card hq-doors" aria-label="Door reports">
      <CardHead title="Door reports" meta={rows.length ? `${rows.length} filed${open ? ` · ${open} awaiting review` : ''}` : ''} />
      {rows.length ? (
        <ul className="hq-door-list">
          {rows.map((d, i) => (
            <li key={i}>
              <code className="hq-door-tool">{clean(d.tool) || 'door'}</code>
              <p>{clean(d.summary)}</p>
              <span className={`hq-rec-status ${d.reviewed ? 'is-applied' : 'is-open'}`}>{d.reviewed ? 'Reviewed' : 'Awaiting review'}</span>
              <span className="hq-mem-by">{stampOf(d.at)}</span>
            </li>
          ))}
        </ul>
      ) : <Empty>No door reports have been filed.</Empty>}
    </section>
  );
}

// ---- the desk ------------------------------------------------------------------------------------------

/**
 * @param {{ tab: any, now?: number, onOpenTab?: (id: string) => void }} props
 */
export default function HqBoardView({ tab, now = Date.now(), onOpenTab }) {
  const t = tab || {};
  const name = t.profile?.name || t.label || 'This desk';
  return (
    <div className="hq-board">
      <div className="hq-split hq-split--top">
        <ProfileCard profile={t.profile} head={t.head} label={t.label} />
        <LiveCard live={t.live} name={name} now={now} />
      </div>
      <CompanySection company={t.company} onOpenTab={onOpenTab} />
      <ManagerSection manager={t.manager} onOpenTab={onOpenTab} />
      <LegalSection legal={t.legal} />
      {/* The CEO, Manager and Legal desks have no daily workers of their own; an empty section would only say so. */}
      {list(t.workers).length || !(t.company || t.manager || t.legal) ? <Workers workers={t.workers} name={name} /> : null}
      <div className="hq-split hq-split--main">
        <div className="hq-col">
          <WeeklyCard weekly={t.weekly} workers={t.workers} brief={t.brief} />
          <HistoryCard history={t.history} now={now} />
        </div>
        <aside className="hq-col" aria-label="Messages and memory">
          <OutgoingCard outgoing={t.outgoing} />
          <MemoryCard memory={t.memory} />
          <MailboxCard mailbox={t.mailbox} onOpenTab={onOpenTab} />
        </aside>
      </div>
    </div>
  );
}
