// Pure helpers for the inbound SMS webhook. No Deno or Node APIs beyond Web Crypto, so the same
// file runs in the Edge Function and in Vitest.

export const ACK_TEXT = "Got it. I'm working on it and will text you when it's ready.";

const encoder = new TextEncoder();

/** Twilio's request signature: HMAC-SHA1 over the exact URL plus sorted POST params, base64. */
export async function twilioSignature(
  authToken: string,
  url: string,
  params: Readonly<Record<string, string>>,
): Promise<string> {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data)));
  let binary = '';
  for (const byte of mac) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function isValidTwilioRequest(
  authToken: string,
  url: string,
  params: Readonly<Record<string, string>>,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!authToken || !url || !signatureHeader) return false;
  const expected = await twilioSignature(authToken, url, params);
  return constantTimeEqual(expected, signatureHeader);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type InboundSms = { messageSid: string; from: string; to: string; body: string };

// Twilio's default opt-out, opt-in and help keywords. Twilio itself acts on them (STOP or CANCEL
// opts the sender out of the number) and answers them, so the assistants never treat them as a
// request or a command, and never reply on top of Twilio's own answer.
export const TWILIO_KEYWORDS = new Set([
  'STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE',
  'START', 'YES', 'UNSTOP', 'HELP', 'INFO',
]);

/** True when Twilio handles this text itself (flagged with OptOutType, or one of its keywords). */
export function isTwilioKeyword(params: Readonly<Record<string, string>>): boolean {
  if ((params.OptOutType ?? '') !== '') return true;
  return TWILIO_KEYWORDS.has((params.Body ?? '').trim().replace(/[.!]+$/, '').toUpperCase());
}

/**
 * The fields we keep from Twilio's form post, or null when anything is malformed or the text is one
 * of Twilio's own keywords.
 */
export function parseInbound(params: Readonly<Record<string, string>>): InboundSms | null {
  if (isTwilioKeyword(params)) return null;
  const messageSid = params.MessageSid ?? params.SmsSid ?? '';
  const from = params.From ?? '';
  const to = params.To ?? '';
  const body = (params.Body ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  const phone = /^\+1\d{10}$/;
  if (!/^(SM|MM)[0-9a-f]{32}$/.test(messageSid)) return null;
  if (!phone.test(from) || !phone.test(to)) return null;
  if (body.length === 0 || body.length > 1600) return null;
  return { messageSid, from, to, body };
}

export function twiml(message?: string): string {
  const inner = message ? `<Message>${escapeXml(message)}</Message>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

function escapeXml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
