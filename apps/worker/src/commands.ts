// Approval and control commands are parsed by fixed rules, never by a model, so no text a model
// reads or writes can approve anything.

export type Command =
  | { kind: 'send'; planRank: 1 | 2 | 3; code: string }
  | { kind: 'confirm'; code: string }
  | { kind: 'decline'; code: string }
  | { kind: 'cancel' }
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
  if (t === 'CANCEL') return { kind: 'cancel' };
  if (t === 'STATUS') return { kind: 'status' };
  if (/^(SEND|CONFIRM|DECLINE)\b/.test(t) || /^(YES|Y|OK|APPROVE|APPROVED)$/.test(t)) {
    return { kind: 'malformed', hint: 'To approve, reply exactly: SEND <plan 1-3> <6-digit code>, CONFIRM <code> or DECLINE <code>.' };
  }
  return null;
}
