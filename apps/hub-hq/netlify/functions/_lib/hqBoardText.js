// _lib/hqBoardText.js — every piece of text the Fortune HQ board shows passes through cleanText() here.
//
// The HQ queries already name only safe columns (never a one-time code, a door token, an approval code hash or a
// key), but an outbox text still carries the six-digit approval code it was sent with, and a model's words may
// quote a number. So the last line of defence is the same one the HQ console uses (apps/console/src/scrub.ts):
// emails become [email], anything credential-shaped becomes [hidden], a phone number in running text shows its
// last four digits, and any run of six or more digits (or a code written 482-913 / 482 913) is blanked.
// The profile's and the head's own phone fields are not running text; the board shows them to the owner as stored.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SECRETS = [
  // eslint-disable-next-line security/detect-unsafe-regex -- linear: each repeat starts with a literal '.', and input is capped at MAX_INPUT
  /eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}/g, // JSON web tokens (Supabase keys are these)
  /sb_(?:secret|publishable)[A-Za-z0-9_-]*/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /service_role/gi,
  /code_hash/gi,
  /\b(?:AC|SK)[0-9a-f]{32}\b/gi, // Twilio account and API key ids
  /\b[0-9a-f]{40,}\b/gi, // hashes and long hex tokens
];
// eslint-disable-next-line security/detect-unsafe-regex -- bounded repeats only (fixed digit counts), input capped at MAX_INPUT
const PHONE = /(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g;
const LONG_DIGITS = /\d{6,}/g;
// A code split in two groups of three ("482-913", "482 913"); not part of an amount or a longer number.
const SPLIT_CODE = /(?<![\d.,$])\d{3}[ -]\d{3}(?!\d)(?!\.\d)/g;
export const BLANK = '••••••';
// The longest text ever cleaned (the HQ columns are capped well below this); keeps every pattern's work bounded.
const MAX_INPUT = 5000;

const lastFour = (match) => {
  const digits = match.replace(/\D/g, '');
  return digits.length >= 4 ? `…${digits.slice(-4)}` : '…';
};

/** @param {string} text @returns {string} */
function scrub(text) {
  let out = text.replace(EMAIL, '[email]');
  for (const secret of SECRETS) out = out.replace(secret, '[hidden]');
  return out.replace(PHONE, lastFour).replace(LONG_DIGITS, BLANK).replace(SPLIT_CODE, BLANK);
}

/**
 * Clean, then cut to at most `max` characters (cleaned first, so a code is never cut in half and left readable).
 * Anything that is not a non-empty string becomes null.
 * @param {unknown} value @param {number} [max] @returns {string|null}
 */
export function cleanText(value, max = 280) {
  if (typeof value !== 'string') return null;
  const out = scrub(value.slice(0, MAX_INPUT)).replace(/\s+/g, ' ').trim();
  if (!out) return null;
  return out.length <= max ? out : `${out.slice(0, max - 1).trimEnd()}…`;
}

/** @param {unknown} v @returns {string|null} an ISO timestamp, or null */
export function iso(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** @param {unknown} v @returns {number} */
export const count = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** @param {unknown} v @returns {any[]} */
export const list = (v) => (Array.isArray(v) ? v : []);

/** @param {unknown} v @returns {v is Record<string, any>} */
export const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
