import type { AssistantId } from '@fahq/contracts';
import type { HmemLike, MemoryRecordLike, MeterlessEngines } from './meterless.ts';

// One assistant's memory, on Meterless H-MEM. A proposal is a low-confidence, short-term memory
// tagged "unapproved". Only a person's decision becomes long-term memory, and it supersedes the
// proposal it settles. Recall for planning returns decisions only, so an unapproved model idea is
// never treated as a fact.

export type Decision = { memory: MemoryRecordLike; relevance: number };

export class AssistantMemory {
  constructor(
    private readonly hmem: HmemLike,
    private readonly assistant: AssistantId,
    private readonly engines: Pick<MeterlessEngines, 'tokenize' | 'jaccard'>,
    private readonly now: () => number,
  ) {}

  rememberProposal(input: { proposalId: string; summary: string; runId: string }): MemoryRecordLike {
    // A retried task calls this again: keep one memory per proposal.
    const existing = this.hmem.store.all().find((m) => m.tags.includes('proposal') && m.tags.includes(`proposal:${input.proposalId}`));
    if (existing) return existing;
    return this.hmem.add({
      content: `Proposal ${input.proposalId}: ${input.summary}`.slice(0, 2000),
      type: 'general',
      layer: 'short_term',
      confidence: 0.4,
      tags: ['proposal', 'unapproved', `proposal:${input.proposalId}`],
      source: `fahq/${this.assistant}/run/${input.runId}`,
      provenance: { origin: 'model_response', learnedAt: this.now(), label: 'Unapproved proposal', refs: [input.proposalId] },
    });
  }

  rememberDecision(input: {
    proposalId: string;
    personId: string;
    verdict: 'signed' | 'declined';
    planRank: number | null;
    planTitle: string;
    runId: string;
  }): MemoryRecordLike {
    const proposal = this.hmem.store.all().find((m) => m.tags.includes(`proposal:${input.proposalId}`) && m.tags.includes('unapproved'));
    const word = input.verdict === 'signed' ? 'approved' : 'declined';
    // A retried task calls this again: keep one decision per person, proposal and verdict.
    const existing = this.hmem.store.all().find((m) =>
      m.tags.includes('decision') && m.tags.includes(word) && m.tags.includes(`proposal:${input.proposalId}`) && m.content.includes(` ${input.personId} `));
    if (existing) return existing;
    return this.hmem.add({
      content: `Decision: ${input.personId} ${word} plan ${input.planRank ?? '-'} "${input.planTitle}" (proposal ${input.proposalId}).`,
      type: 'factual',
      layer: 'long_term',
      confidence: 0.9,
      tags: ['decision', word, `proposal:${input.proposalId}`],
      source: `fahq/${this.assistant}/decision/${input.runId}`,
      provenance: { origin: 'manual', learnedAt: this.now(), label: `Decision by ${input.personId}`, refs: [input.proposalId] },
      ...(proposal ? { supersedes: proposal.id } : {}),
    });
  }

  /** Decisions only: what people approved or declined, most relevant first. */
  recallDecisions(query: string, topN = 5): Decision[] {
    return this.hmem
      .query(query, { topN: 25, threshold: 0.01 })
      .memories.filter((m) => m.memory.tags.includes('decision') && !m.memory.supersededBy)
      .slice(0, topN);
  }

  /** Declined decisions whose wording overlaps this plan: the plan may repeat a rejected idea. */
  declinedSimilarTo(planText: string, minOverlap = 0.25): MemoryRecordLike[] {
    const planTokens = this.engines.tokenize(planText);
    return this.hmem
      .store.all()
      .filter((m) => m.tags.includes('decision') && m.tags.includes('declined') && !m.supersededBy)
      .filter((m) => this.engines.jaccard(planTokens, this.engines.tokenize(m.content)) >= minOverlap);
  }
}
