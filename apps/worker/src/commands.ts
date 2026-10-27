// Approval and control commands are parsed by fixed rules, never by a model, so no text a model
// reads or writes can approve anything. There is no CANCEL command: CANCEL is one of Twilio's
// opt-out keywords (it would stop all texts from the assistant), so the webhook leaves it to
// Twilio. An unused code simply expires (15 minutes; a manager review's ADOPT code, 12 hours).

export type Rank = 1 | 2 | 3;

export type Command =
  | { kind: 'send'; planRank: Rank; code: string }
  | { kind: 'confirm'; code: string }
  | { kind: 'decline'; code: string }
  | { kind: 'adopt'; ranks: Rank[]; code: string }
  | { kind: 'review' }
  | { kind: 'status' }
  | { kind: 'malformed'; hint: string };

export const APPROVAL_HINT = 'To approve, reply exactly: SEND <plan 1-3> <6-digit code>, CONFIRM <code>, DECLINE <code> or ADOPT <1-3> <code>.';

export function parseCommand(text: string): Command | null {
  const t = text.trim().replace(/\s+/g, ' ').toUpperCase();
  let m = /^SEND ([123]) (\d{6})$/.exec(t);
  if (m) return { kind: 'send', planRank: Number(m[1]) as Rank, code: m[2]! };
  m = /^CONFIRM (\d{6})$/.exec(t);
  if (m) return { kind: 'confirm', code: m[1]! };
  m = /^DECLINE (\d{6})$/.exec(t);
  if (m) return { kind: 'decline', code: m[1]! };
  // ADOPT 2 482913 · ADOPT 1 2 482913 · ADOPT 1,2,3 482913: ranks 1-3, each once, then the code.
  m = /^ADOPT ([123](?:(?:,\s?| )[123])*) (\d{6})$/.exec(t);
  if (m) {
    const ranks = (m[1]!.match(/[123]/g) ?? []).map(Number) as Rank[];
    if (new Set(ranks).size === ranks.length) return { kind: 'adopt', ranks: ranks.sort((a, b) => a - b), code: m[2]! };
  }
  if (t === 'REVIEW') return { kind: 'review' };
  if (t === 'STATUS') return { kind: 'status' };
  const approvalWord = /\b(SEND|CONFIRM|DECLINE|ADOPT|APPROVE|APPROVED|YES|OK)\b/.test(t);
  // A near-miss approval: a code next to an approval word ("ok send 2 482913 thanks") never goes to a
  // model; nor does a bare approval word, one followed by a single short token, or ADOPT with only
  // ranks. "Send me three plans" and "Adopt a new pricing strategy for October" are requests and go through.
  const nearMiss =
    (approvalWord && /\b\d{6}\b/.test(t)) ||
    /^(SEND|CONFIRM|DECLINE|ADOPT)( \S{1,8})?$/.test(t) ||
    /^ADOPT( [\d,]{1,8})+$/.test(t) || // ranks and digits only: a missing, short or mistyped code
    /^(YES|Y|OK|APPROVE|APPROVED)$/.test(t);
  if (nearMiss) return { kind: 'malformed', hint: APPROVAL_HINT };
  return null;
}
