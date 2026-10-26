// Everything that leaves this server passes through cleanText(). It is the last line of defence:
// the data sources already ask only for safe columns, and shape.ts copies only known fields, but
// a value that slipped through (a code in an old outbox body, a phone number in an error, a key
// pasted into a detail line) must still never reach the owner's screen, a log, or the network.

// US-style phone numbers in any common spelling: +15551234567, (555) 123-4567, 555.123.4567, 1 555 123 4567.
const PHONE = /(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g;

// Anything that looks like a credential. These are replaced, not partly shown.
const SECRETS: RegExp[] = [
  /eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}/g, // JSON web tokens (Supabase keys are these)
  /sb_(?:secret|publishable)[A-Za-z0-9_-]*/gi, // new-style Supabase keys
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /service_role/gi,
  /code_hash/gi,
  /\b(?:AC|SK)[0-9a-f]{32}\b/gi, // Twilio account and API key ids
  /\b[0-9a-f]{40,}\b/gi, // hashes and long hex tokens
];

export function maskDigitsToLast4(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 4 ? `…${digits.slice(-4)}` : '…';
}

/** A texting number shown as "…4514" and nothing more. */
export function maskNumber(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return maskDigitsToLast4(raw);
}

export const maskPhones = (text: string): string => text.replace(PHONE, (m) => maskDigitsToLast4(m));

/** Replaces any run of six or more digits (an approval code, whether or not it has a word around it). */
export const redactCodes = (text: string): string => text.replace(/\d{6,}/g, '••••••');

export function cleanText(text: string): string {
  let out = text;
  for (const secret of SECRETS) out = out.replace(secret, '[hidden]');
  return redactCodes(maskPhones(out));
}

/** Cut to at most `max` characters. Always clean first, so a code is never cut in half and left readable. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
