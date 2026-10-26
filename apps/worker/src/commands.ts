// Approval and control commands are parsed by fixed rules, never by a model, so no text a model
// reads or writes can approve anything. There is no CANCEL command: CANCEL is one of Twilio's
// opt-out keywords (it would stop all texts from the assistant), so the webhook leaves it to
// Twilio. An unused code simply expires after 15 minutes.

export type Command =
  | { kind: 'send'; planRank: 1 | 2 | 3; code: string }
  | { kind: 'confirm'; code: string }
  | { kind: 'decline'; code: string }
  | { kind: 'status' }
  | { kind: 'malformed'; hint: string };

export function parseCommand(text: string): Command | null {
  const t = text.trim().replace(/\s+/g, ' ').toUpperCase();
  let m = /^SEND ([123]) (\d{6})$/.exec(t);
  if (m) return { kind: 'send', planRank: Number(m[1]) as 1 | 2 | 3, code: m[2]! };
  m = /^CONFIRM (\d{6})$/.exec(t);
  if (m) return { kind: 'confirm', code: m[1]! };
  m = /^DECLINE (\d{6})$/.exec(t);
  if (m) return { kind: 'decline', code: m[1]! };
  if (t === 'STATUS') return { kind: 'status' };
  const approvalWord = /\b(SEND|CONFIRM|DECLINE|APPROVE|APPROVED|YES|OK)\b/.test(t);
  // A near-miss approval: a code next to an approval word ("ok send 2 482913 thanks") never goes to a
  // model; nor does a bare approval word or one followed by a single short token. "Send me three plans"
  // is a request and goes through.
  const nearMiss =
    (approvalWord && /\b\d{6}\b/.test(t)) ||
    /^(SEND|CONFIRM|DECLINE)( \S{1,8})?$/.test(t) ||
    /^(YES|Y|OK|APPROVE|APPROVED)$/.test(t);
  if (nearMiss) {
    return { kind: 'malformed', hint: 'To approve, reply exactly: SEND <plan 1-3> <6-digit code>, CONFIRM <code> or DECLINE <code>.' };
  }
  return null;
}
