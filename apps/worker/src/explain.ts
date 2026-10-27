import type { Brain, DecisionWord } from '@fahq/brain';
import { originsOf } from './departments.ts';
import type { ApprovalSummary, MessageRow, Store } from './store.ts';

// "Why did you propose plan 2?" answered from what was kept: the proposal as stored (its plans, where each
// came from, why it was picked, the numbers it cited with their values and Zetaris view and query hash),
// the approvals on it (status only, never a code) and the shared record's trail (who asked, who decided).
// Nothing here is written by a model, and a gap is reported as a gap.

export type ExplainContext = {
  store: Pick<Store, 'latestFinalProposal' | 'proposalByPrefix' | 'approvalsOf'>;
  brain: Pick<Brain, 'record'>;
  now: () => Date;
};

export type Explained = {
  proposal: {
    id: string; createdAt: string; from: string; requestText: string; view: string; queryHash: string;
    /** Who chose the final three: Owner HQ's model, or a rule; null for a proposal from one department alone. */
    pickedBy: 'model' | 'rule' | null;
    failedDepartments: string[];
  } | null;
  plans: { rank: number; title: string; department: string; originalRank: number; why: string | null; cites: string[] }[];
  cited: { id: string; label: string; value: number; unit: string; business: string }[];
  approvals: { action: string; status: string; planRank: number | null; decidedAt: string | null }[];
  decisions: { by: string; action: DecisionWord; planRank: number | null; at: string }[];
  record: { askedBy: string | null; request: { text: string; from: string; at: string } | null; cites: string[] } | null;
  notes: string[];
};

type StoredPlan = { rank?: number; title?: string; evidence?: { metricId?: string }[]; projections?: { baseMetricId?: string }[] };
type StoredMetric = { id?: string; label?: string; value?: number; unit?: string; business?: string; source?: { view?: string; queryHash?: string } };

const none = (note: string): Explained => ({ proposal: null, plans: [], cited: [], approvals: [], decisions: [], record: null, notes: [note] });
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

async function find(ctx: ExplainContext, requested: string | undefined): Promise<{ row: MessageRow } | { note: string }> {
  if (!requested) {
    const row = await ctx.store.latestFinalProposal();
    return row ? { row } : { note: 'No proposal has been made yet.' };
  }
  const found = await ctx.store.proposalByPrefix(requested.toLowerCase());
  if (found.ambiguous) return { note: `More than one proposal starts with "${requested}"; give more characters.` };
  return found.proposal ? { row: found.proposal } : { note: `No proposal starts with "${requested}".` };
}

const effective = (a: ApprovalSummary, now: Date): string => (a.status === 'pending' && Date.parse(a.expiresAt) <= now.getTime() ? 'expired' : a.status);

export async function explainProposal(ctx: ExplainContext, requested: string | undefined): Promise<Explained> {
  const found = await find(ctx, requested);
  if ('note' in found) return none(found.note);
  const { row } = found;
  const body = row.body;
  const origins = originsOf(body);
  const whyOf = new Map(list<{ rank?: number; text?: string }>(body.why).map((w) => [w.rank, str(w.text)]));
  const metrics = list<StoredMetric>(body.metrics);

  const plans = list<StoredPlan>((body.plans as { plans?: unknown } | undefined)?.plans).map((p) => {
    const origin = origins.find((o) => o.rank === p.rank);
    const cites = [...new Set([...list<{ metricId?: string }>(p.evidence).map((e) => str(e.metricId)), ...list<{ baseMetricId?: string }>(p.projections).map((x) => str(x.baseMetricId))].filter(Boolean))];
    return {
      rank: p.rank ?? 0, title: str(p.title), cites,
      department: origin?.department ?? (str(body.department) || row.from_assistant),
      originalRank: origin?.originalRank ?? p.rank ?? 0,
      why: whyOf.get(p.rank) || null,
    };
  });

  const trail = ctx.brain.record.explainProposal(row.id);
  const notes: string[] = [];
  const citedIds = [...new Set(plans.flatMap((p) => p.cites))];
  if (!trail.proposal) notes.push('The shared record has no entry for this proposal.');
  else if (citedIds.some((id) => !trail.cites.includes(id))) notes.push('The shared record lists fewer cited metrics than the proposal holds (an older record can lose links).');

  const approvals = (await ctx.store.approvalsOf(row.id)).map((a) => ({ action: a.action, status: effective(a, ctx.now()), planRank: a.planRank, decidedAt: a.decidedAt }));
  return {
    proposal: {
      id: row.id.slice(0, 8), createdAt: new Date(row.created_at).toISOString(), from: row.from_assistant,
      requestText: str(body.requestText) || trail.request?.text || '',
      view: str(body.view) || str(metrics[0]?.source?.view), queryHash: str(body.queryHash) || str(metrics[0]?.source?.queryHash),
      pickedBy: body.pickedBy === 'model' || body.pickedBy === 'rule' ? body.pickedBy : null,
      failedDepartments: list<string>(body.failedDepartments).filter((d) => typeof d === 'string'),
    },
    plans,
    cited: metrics.map((m) => ({ id: str(m.id), label: str(m.label), value: Number(m.value), unit: str(m.unit), business: str(m.business) })),
    approvals,
    decisions: trail.decisions,
    record: trail.proposal ? { askedBy: trail.request?.askedBy ?? null, request: trail.request ? { text: trail.request.text, from: trail.request.from, at: trail.request.at } : null, cites: trail.cites } : null,
    notes,
  };
}
