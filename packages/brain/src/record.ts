import type { AssistantId } from '@fahq/contracts';
import type { GraphViewLike, WmEntity, WmProvenance, WorldModelLike } from './meterless.ts';

// The shared record: who asked what, which assistant proposed what, which numbers it cited, and
// what a person decided. Backed by the Meterless World Model (append-only, single writer, nothing
// deleted). Timestamps come from the event itself, so replaying the same event changes nothing.
//
// One rule of the World Model shapes every write here: a new open edge with the same (from, type,
// context) and a different target CLOSES the previous one. So a relation whose source may point at
// many targets (a proposal citing ten metrics, a person asking twice, approving two proposals) is
// written with `context` = the target's id (`many` below). A relation that has one target by nature
// (a proposal answers one request, a recommendation guides one assistant) keeps no context.

export type Stamp = { at: string; runId: string };

export type DecisionWord = 'forwarded' | 'approved' | 'declined';
const DECISION_WORDS: readonly DecisionWord[] = ['forwarded', 'approved', 'declined'];

/** What the record holds about one proposal. Only edges that are still open are returned; nothing is invented. */
export type ProposalExplanation = {
  proposal: { id: string; titles: string[]; dataSource: string } | null;
  request: { text: string; from: string; askedBy: string | null; at: string } | null;
  /** The ids of the metrics the proposal cited. */
  cites: string[];
  decisions: { by: string; action: DecisionWord; planRank: number | null; at: string }[];
};

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

export class SharedRecord {
  constructor(
    private readonly wm: WorldModelLike,
    private readonly actor: string,
  ) {}

  private source(stamp: Stamp): WmProvenance {
    return { kind: 'agent', by: this.actor, at: stamp.at, runId: stamp.runId };
  }

  private entity(type: string, id: string, name: string, attrs: Record<string, unknown>, stamp: Stamp) {
    return this.wm.upsertEntity({
      type,
      externalKey: { system: 'fahq', id },
      name,
      attrs,
      source: this.source(stamp),
    });
  }

  /** A relation that may have many targets from one source: the target is the context, so no edge closes another. */
  private many(from: { id: string }, type: string, to: { id: string }, stamp: Stamp, attrs?: Record<string, unknown>) {
    return this.wm.relate({ from: from.id, type, to: to.id, context: to.id, ...(attrs ? { attrs } : {}), source: this.source(stamp) });
  }

  /** A relation with one target by nature. */
  private one(from: { id: string }, type: string, to: { id: string }, stamp: Stamp) {
    return this.wm.relate({ from: from.id, type, to: to.id, source: this.source(stamp) });
  }

  async request(input: {
    taskId: string;
    personId: string;
    personName: string;
    from: AssistantId;
    to: AssistantId;
    text: string;
  } & Stamp): Promise<string> {
    const person = await this.entity('person', input.personId, input.personName, {}, input);
    const toAssistant = await this.entity('assistant', `assistant:${input.to}`, input.to, {}, input);
    const request = await this.entity('request', input.taskId, `Request ${input.taskId.slice(0, 8)}`, {
      text: input.text.slice(0, 500),
      from: input.from,
    }, input);
    await this.many(person, 'asked', request, input);
    // A round of plans goes to every department, so one request can be assigned to several assistants.
    await this.many(request, 'assigned_to', toAssistant, input);
    return request.id;
  }

  async proposal(input: {
    proposalId: string;
    requestTaskId: string;
    by: AssistantId;
    forPersonId: string;
    titles: string[];
    citedMetricIds: string[];
    dataSource: string;
  } & Stamp): Promise<string> {
    const assistant = await this.entity('assistant', `assistant:${input.by}`, input.by, {}, input);
    const proposal = await this.entity('proposal', input.proposalId, `Proposal ${input.proposalId.slice(0, 8)}`, {
      titles: input.titles,
      dataSource: input.dataSource,
    }, input);
    const request = await this.entity('request', input.requestTaskId, `Request ${input.requestTaskId.slice(0, 8)}`, {}, input);
    await this.many(assistant, 'proposed', proposal, input);
    await this.one(proposal, 'answers', request, input);
    for (const metricId of input.citedMetricIds) {
      const metric = await this.wm.upsertEntity({
        type: 'metric',
        externalKey: { system: 'zetaris', id: metricId },
        name: metricId,
        attrs: {},
        source: this.source(input),
      });
      await this.many(proposal, 'cites', metric, input);
    }
    return proposal.id;
  }

  async decision(input: {
    proposalId: string;
    personId: string;
    personName: string;
    verdict: 'signed' | 'declined';
    planRank: number | null;
    action: 'forward_plan' | 'decide_plan';
  } & Stamp): Promise<void> {
    const person = await this.entity('person', input.personId, input.personName, {}, input);
    const proposal = await this.entity('proposal', input.proposalId, `Proposal ${input.proposalId.slice(0, 8)}`, {}, input);
    const word: DecisionWord = input.action === 'forward_plan' ? 'forwarded' : input.verdict === 'signed' ? 'approved' : 'declined';
    await this.many(person, word, proposal, input, { planRank: input.planRank });
    await this.wm.assertFact({
      about: proposal.id,
      predicate: input.action,
      value: { verdict: input.verdict, planRank: input.planRank, by: input.personId },
      source: this.source(input),
    });
  }

  /** An assistant handed the HQ Manager the report of a finished task. */
  async report(input: {
    taskId: string;
    assistant: AssistantId;
    outcome: 'done' | 'failed' | 'retrying';
    summary: string;
  } & Stamp): Promise<string> {
    const assistant = await this.entity('assistant', `assistant:${input.assistant}`, input.assistant, {}, input);
    const report = await this.entity('report', `report:${input.taskId}`, `Report ${input.taskId.slice(0, 8)}`, {
      outcome: input.outcome,
      summary: input.summary.slice(0, 300),
    }, input);
    await this.many(assistant, 'reported', report, input);
    return report.id;
  }

  /** The HQ Manager wrote a review (optionally naming the assistants whose work it covered). */
  async review(input: {
    reviewId: string;
    recommendationCount: number;
    reviewed?: readonly AssistantId[];
  } & Stamp): Promise<string> {
    const manager = await this.entity('assistant', 'assistant:manager', 'manager', {}, input);
    const review = await this.entity('review', `review:${input.reviewId}`, `Review ${input.reviewId.slice(0, 8)}`, {
      recommendationCount: input.recommendationCount,
    }, input);
    await this.many(manager, 'wrote', review, input);
    for (const id of input.reviewed ?? []) {
      const reviewed = await this.entity('assistant', `assistant:${id}`, id, {}, input);
      await this.many(manager, 'reviewed', reviewed, input);
    }
    return review.id;
  }

  /** A person adopted a recommendation; it now guides one assistant. */
  async adoption(input: {
    recommendationId: string;
    reviewId: string;
    personId: string;
    personName: string;
    assistant: AssistantId;
  } & Stamp): Promise<string> {
    const person = await this.entity('person', input.personId, input.personName, {}, input);
    const recommendation = await this.entity('recommendation', `recommendation:${input.recommendationId}`, `Recommendation ${input.recommendationId.slice(0, 8)}`, {}, input);
    const review = await this.entity('review', `review:${input.reviewId}`, `Review ${input.reviewId.slice(0, 8)}`, {}, input);
    const assistant = await this.entity('assistant', `assistant:${input.assistant}`, input.assistant, {}, input);
    await this.many(review, 'recommended', recommendation, input);
    await this.many(person, 'adopted', recommendation, input);
    await this.one(recommendation, 'guides', assistant, input);
    return recommendation.id;
  }

  /**
   * Why a proposal exists, from the graph: the request it answers and who asked it, the metrics it
   * cited, and who forwarded, approved or declined it. An unknown proposal comes back empty. Records
   * written before relations carried a context may have lost edges to later ones; this returns what
   * is open and never fills a gap.
   */
  explainProposal(proposalId: string): ProposalExplanation {
    const graph = this.wm.view('graph');
    // Externally keyed entities have the literal id `type:system:id` (stableIds.ts, externalId).
    const entity = graph.entity(`proposal:fahq:${proposalId}`);
    if (!entity) return { proposal: null, request: null, cites: [], decisions: [] };
    const titles = Array.isArray(entity.attrs.titles) ? entity.attrs.titles.filter((t): t is string => typeof t === 'string') : [];
    const asked = graph.neighborsOf(entity.id, { via: 'answers' }).find((e) => e.type === 'request');
    return {
      proposal: { id: proposalId, titles, dataSource: text(entity.attrs.dataSource) },
      request: asked ? this.requestOf(graph, asked) : null,
      cites: graph.neighborsOf(entity.id, { via: 'cites' }).map((m) => m.name ?? m.id).sort(),
      decisions: this.decisionsOn(graph, entity.id),
    };
  }

  private requestOf(graph: GraphViewLike, request: WmEntity): NonNullable<ProposalExplanation['request']> {
    const asker = graph.incoming(request.id, { via: 'asked' }).find((e) => e.type === 'person');
    return { text: text(request.attrs.text), from: text(request.attrs.from), askedBy: asker?.name ?? null, at: request.createdAt ?? '' };
  }

  /** Open forwarded / approved / declined edges into the proposal, with the plan rank and time of their events. */
  private decisionsOn(graph: GraphViewLike, proposalId: string): ProposalExplanation['decisions'] {
    const open = new Set(DECISION_WORDS.flatMap((word) => graph.incoming(proposalId, { via: word }).map((p) => `${p.id}|${word}`)));
    const out: ProposalExplanation['decisions'] = [];
    for (const e of this.wm.events()) {
      const rel = e.kind === 'relate' ? (e.payload as { from?: string; to?: string; type?: string; attrs?: { planRank?: unknown } } | undefined) : undefined;
      if (!rel || rel.to !== proposalId || !rel.from || !rel.type || !open.has(`${rel.from}|${rel.type}`)) continue;
      const rank = rel.attrs?.planRank;
      out.push({
        by: graph.entity(rel.from)?.name ?? rel.from,
        action: rel.type as DecisionWord,
        planRank: typeof rank === 'number' ? rank : null,
        at: e.at,
      });
    }
    return out;
  }

  /** Oldest first. `type` is the World Model event kind (upsertEntity, relate, assertFact, ...). */
  timeline(limit = 50): readonly { id: string; type: string; at: string }[] {
    return this.wm.events().slice(-limit).map((e) => ({ id: e.id, type: e.kind, at: e.at }));
  }

  audit(limit = 50) {
    return this.wm.audit().slice(-limit);
  }
}
