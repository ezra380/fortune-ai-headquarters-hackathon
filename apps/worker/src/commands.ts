// Approval and control commands are parsed by fixed rules, never by a model, so no text a model
// reads or writes can approve anything. There is no CANCEL command: CANCEL is one of Twilio's
// opt-out keywords (it would stop all texts from the assistant), so the webhook leaves it to
// Twilio. An unused code simply expires (15 minutes; a manager review's ADOPT code and a division
// brief's APPROVE code, 12 hours).

export type Rank = 1 | 2 | 3;

export type Command =
  | { kind: 'send'; planRank: Rank; code: string }
  | { kind: 'confirm'; code: string }
  | { kind: 'decline'; code: string }
  | { kind: 'adopt'; ranks: Rank[]; code: string }
  | { kind: 'approve'; ranks: Rank[]; code: string }
  | { kind: 'review' }
  | { kind: 'brief' }
  /** REPORT, or REPORT FINANCE|ONLINE|SALON|ALL: a weekly report now (null = the sender's own, or all three for the owner). */
  | { kind: 'report'; division: 'FINANCE' | 'ONLINE' | 'SALON' | 'ALL' | null }
  | { kind: 'status' }
  | { kind: 'malformed'; hint: string };

export const APPROVAL_HINT = 'To approve, reply exactly: SEND <plan 1-3> <6-digit code>, CONFIRM <code>, DECLINE <code>, ADOPT <1-3> <code> or APPROVE <1-3> <code> (APPROVE 1 2 <code> approves two actions at once).';

/** "1 2", "1,2" and "3, 1": ranks 1-3, each once, in order. Null when a rank repeats. */
function ranksOf(list: string): Rank[] | null {
  const ranks = (list.match(/[123]/g) ?? []).map(Number) as Rank[];
  return new Set(ranks).size === ranks.length ? ranks.sort((a, b) => a - b) : null;
}

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
    const ranks = ranksOf(m[1]!);
    if (ranks) return { kind: 'adopt', ranks, code: m[2]! };
  }
  // APPROVE 2 482913 · APPROVE 1 3 482913: the actions of a division brief, by the code the brief's text carried (same grammar as ADOPT).
  m = /^APPROVE ([123](?:(?:,\s?| )[123])*) (\d{6})$/.exec(t);
  if (m) {
    const ranks = ranksOf(m[1]!);
    if (ranks) return { kind: 'approve', ranks, code: m[2]! };
  }
  if (t === 'REVIEW') return { kind: 'review' };
  // BRIEF: the owner asks every division for its brief now; a division head asks for her own.
  if (t === 'BRIEF') return { kind: 'brief' };
  // REPORT: a weekly report now. The owner names a division or ALL; a division head asks for her own.
  m = /^REPORT(?: (FINANCE|ONLINE|SALON|ALL))?$/.exec(t);
  if (m) return { kind: 'report', division: (m[1] ?? null) as Extract<Command, { kind: 'report' }>['division'] };
  if (t === 'STATUS') return { kind: 'status' };
  const approvalWord = /\b(SEND|CONFIRM|DECLINE|ADOPT|APPROVE|APPROVED|YES|OK)\b/.test(t);
  // A near-miss approval: a code next to an approval word ("ok send 2 482913 thanks") never goes to a
  // model; nor does a bare approval word, one followed by a single short token, or ADOPT with only
  // ranks. "Send me three plans" and "Adopt a new pricing strategy for October" are requests and go through.
  const nearMiss =
    (approvalWord && /\b\d{6}\b/.test(t)) ||
    /^(SEND|CONFIRM|DECLINE|ADOPT|APPROVE)( \S{1,8})?$/.test(t) ||
    /^(ADOPT|APPROVE)( [\d,]{1,8})+$/.test(t) || // ranks and digits only: a missing, short or mistyped code
    /^(YES|Y|OK|APPROVE|APPROVED)$/.test(t);
  if (nearMiss) return { kind: 'malformed', hint: APPROVAL_HINT };
  return null;
}
