// Fortune HQ — the owner's board of every division (Ezra, 2026-10-27): Joey (CEO), George (Finance),
// Georgette (Online), Cindy (Salon), the HQ Manager and the Legal Team, each a desk with its profile, live
// tasks, workers, weekly report, outgoing and sent messages, memory and mailbox.
//
// Data: netlify/functions/hq-board.js (the Fortune AI Headquarters database, read-only), one desk per call.
// The server is the gate: anyone but the owner gets 403 and its sentence is shown here as given.
// Refresh: every 20 seconds while the tab is visible. The last answer stays on screen while the next one
// loads, and a failed refresh keeps it too (with a quiet note), so the board never flickers or blanks.
//
// `scope` (a desk id) is the one parameter a division head's own login will pass later: the board then shows
// that desk alone. hq-board.js must enforce the same scope before any such login exists.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { usePolling } from '../lib/usePolling.js';
import { HQ_TABS, HQ_TAB_IDS } from '../lib/hqAccess.js';
import HqBoardView from '../components/hq/HqBoardView.jsx';
import { clockOf } from '../components/hq/hqFormat.js';
import '../fortune-hq.css';

const REFRESH_MS = 20000;
const UNREACHABLE = 'Fortune HQ could not be reached. It will try again on its own.';

/** The server's own sentence for a refusal (403 / 503), never a stack or a status code alone. */
const refusal = (e) => {
  const err = /** @type {any} */ (e);
  return (err && err.data && typeof err.data.error === 'string' && err.data.error) || UNREACHABLE;
};

function Skeleton() {
  return (
    <div className="hq-board" aria-busy="true" aria-label="Loading the desk">
      <div className="hq-split hq-split--top">
        <div className="card hq-skel hq-skel--tall" />
        <div className="card hq-skel hq-skel--tall" />
      </div>
      <div className="hq-workers">
        {[0, 1, 2].map((i) => <div key={i} className="card hq-skel" />)}
      </div>
    </div>
  );
}

/** @param {{ scope?: string|null }} props */
export default function FortuneHQ({ scope = null }) {
  const { tab: param } = useParams();
  const navigate = useNavigate();
  const allowed = scope ? [scope] : HQ_TAB_IDS;
  const tabId = allowed.includes(param) ? param : allowed[0];

  const [boards, setBoards] = useState(/** @type {Record<string, any>} */ ({}));
  const [errors, setErrors] = useState(/** @type {Record<string, string|null>} */ ({}));
  const [stale, setStale] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const have = useRef(/** @type {Record<string, boolean>} */ ({}));

  const load = useCallback(async () => {
    const id = tabId;
    try {
      const data = await api.hqBoard(id);
      have.current[id] = true;
      setBoards((b) => ({ ...b, [id]: { ...data, receivedAt: Date.now() } }));
      setErrors((x) => ({ ...x, [id]: null }));
      setStale(false);
    } catch (e) {
      // A desk already on screen keeps its last answer; only a first load shows the refusal.
      if (have.current[id]) setStale(true);
      else setErrors((x) => ({ ...x, [id]: refusal(e) }));
    } finally {
      setNow(Date.now());
    }
  }, [tabId]);

  usePolling(load, REFRESH_MS, [tabId]);
  useEffect(() => { document.title = 'Fortune HQ · Fortune Hub'; return () => { document.title = 'Fortune Hub'; }; }, []);

  if (param && !allowed.includes(param)) return <Navigate to={`/hq/${allowed[0]}`} replace />;

  const current = boards[tabId];
  const tabs = (Array.isArray(current?.tabs) && current.tabs.length ? current.tabs : HQ_TABS)
    .filter((t) => t && allowed.includes(t.id));
  const desk = current?.tab || null;
  const error = errors[tabId];
  const updated = current ? clockOf(current.generatedAt) || clockOf(new Date(current.receivedAt).toISOString()) : '';
  const deskName = tabs.find((t) => t.id === tabId)?.subtitle;
  const open = (id) => { if (allowed.includes(id)) navigate(`/hq/${id}`); };

  return (
    <div className="page hq">
      <header className="hq-head">
        <div>
          <p className="hq-eyebrow">Fortune Wigs · Headquarters</p>
          <h1>{scope && deskName ? `${deskName} HQ` : 'Fortune HQ'}</h1>
          <p className="hq-sub">{scope ? 'Your division, live.' : 'Every division, live.'}</p>
        </div>
        <div className="hq-stamp" role="status" aria-live="polite">
          <span className={`hq-pulse${stale || !current ? ' is-quiet' : ''}`} aria-hidden="true" />
          {current
            ? <span>{stale ? 'Last refresh missed, retrying' : 'Live'} · Updated <span className="hq-num">{updated}</span></span>
            : <span>{error ? 'Not connected' : 'Connecting'}</span>}
        </div>
      </header>

      {tabs.length > 1 ? (
        <nav className="hq-tabs" role="tablist" aria-label="Divisions">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" id={`hq-tab-${t.id}`} aria-selected={t.id === tabId}
              aria-controls="hq-panel" className="hq-tab" onClick={() => open(t.id)}>
              <span className="hq-tab-label">{t.label}</span>
              <span className="hq-tab-sub">{t.subtitle}</span>
            </button>
          ))}
        </nav>
      ) : null}

      <div id="hq-panel" role="tabpanel" aria-labelledby={`hq-tab-${tabId}`}>
        {desk ? <HqBoardView tab={desk} now={now} onOpenTab={open} />
          : error ? (
            <div className="card hq-notice" role="alert">
              <h3>Fortune HQ</h3>
              <p>{error}</p>
              <button type="button" className="btn" onClick={() => { setErrors((x) => ({ ...x, [tabId]: null })); load(); }}>Try again</button>
            </div>
          ) : current ? (
            <div className="card hq-notice"><h3>Fortune HQ</h3><p>This desk has nothing to show yet.</p></div>
          ) : <Skeleton />}
      </div>
    </div>
  );
}
