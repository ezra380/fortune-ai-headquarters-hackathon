// src/components/hq/hqFormat.js — how Fortune HQ prints times, phones, statuses and names.
// Every function takes whatever the server sent (null, '', a bad date) and returns something calm to show.

/** Who each assistant id is on the board (contract: assistant ids owner/finance/online/salon/manager/legal). */
export const ASSISTANT_NAMES = {
  owner: 'Joey', company: 'Joey', finance: 'George', online: 'Georgette', salon: 'Cindy', manager: 'HQ Manager', legal: 'Legal Team',
};
export const assistantName = (id) => ASSISTANT_NAMES[id] || (id ? String(id) : 'Unknown');
/** The tab an assistant id opens (owner is the company desk). */
export const assistantTab = (id) => (id === 'owner' ? 'company' : id);

/** Belt over the server's own redaction: a run of six or more digits (an approval code) never reaches the screen. */
export const clean = (text) => (text === null || text === undefined ? '' : String(text).replace(/\d{6,}/g, '••••••'));

const toDate = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

export const timeOf = (iso) => {
  const d = toDate(iso);
  return d ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
};
export const clockOf = (iso) => {
  const d = toDate(iso);
  return d ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '';
};
export const dateOf = (iso) => {
  const d = toDate(iso);
  return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
};
export const stampOf = (iso) => {
  const d = toDate(iso);
  return d ? `${dateOf(iso)}, ${timeOf(iso)}` : '';
};
/**
 * A company day (YYYY-MM-DD) read as a calendar date, never shifted by the viewer's time zone.
 * @param {string} ymd @param {Intl.DateTimeFormatOptions} [opts]
 */
export const dayOf = (ymd, opts = { month: 'short', day: 'numeric' }) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  if (!m) return ymd ? String(ymd) : '';
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });
};

/** "Today" / "Yesterday" / "Mon, Oct 26" for a day heading. */
export const dayHeading = (iso, now = Date.now()) => {
  const d = toDate(iso);
  if (!d) return 'Undated';
  const key = (x) => x.toLocaleDateString('en-CA');
  const today = new Date(now);
  const yesterday = new Date(now - 86400000);
  if (key(d) === key(today)) return 'Today';
  if (key(d) === key(yesterday)) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
};

/** How long a task has been in its state: "just now", "for 4 min", "for 1 h 12 min", "since Oct 26". */
export const sinceOf = (iso, now = Date.now()) => {
  const d = toDate(iso);
  if (!d) return '';
  const mins = Math.max(0, Math.floor((now - d.getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `for ${mins} min`;
  if (mins < 24 * 60) return `for ${Math.floor(mins / 60)} h ${mins % 60} min`;
  return `since ${dateOf(iso)}`;
};

/** A US number in E.164 or digits reads as (929) 555-0142; anything else is shown as given. */
export const phoneOf = (raw) => {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  const ten = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
  if (ten.length !== 10) return String(raw);
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
};

export const STATUS_LABEL = { normal: 'Normal', watch: 'Watch', act: 'Act' };
export const statusKey = (s) => (s === 'normal' || s === 'watch' || s === 'act' ? s : 'none');

export const CHANNEL_LABEL = { sms: 'Text', email: 'Email', print: 'Printout' };
export const channelKey = (c) => (c === 'sms' || c === 'email' || c === 'print' ? c : 'other');
export const channelLabel = (c) => CHANNEL_LABEL[c] || (c ? String(c) : 'Message');

/** Delivery words: sent / delivered / failed / queued ... read as a sentence-case label. */
export const deliveryLabel = (s) => {
  if (!s) return '';
  const t = String(s).replace(/_/g, ' ');
  return t[0].toUpperCase() + t.slice(1);
};
export const failed = (s) => /fail|error|undeliver|bounce|reject/i.test(String(s || ''));

export const MEMORY_LABEL = { lesson: 'Lesson', note: 'Note', decision: 'Decision', review: 'Review', version: 'Version' };
export const memoryLabel = (k) => MEMORY_LABEL[k] || (k ? String(k) : 'Note');

/** Worker id "finance.google_ads" reads "Google ads" when the server sent no label. */
export const workerLabel = (w) => {
  if (w?.label) return w.label;
  const id = String(w?.workerId || '');
  const tail = id.includes('.') ? id.slice(id.indexOf('.') + 1) : id;
  const words = tail.replace(/_/g, ' ');
  return words ? words[0].toUpperCase() + words.slice(1) : 'Worker';
};

export const num = (n) => (n === null || n === undefined || n === '' || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('en-US'));

export const list = (v) => (Array.isArray(v) ? v : []);
