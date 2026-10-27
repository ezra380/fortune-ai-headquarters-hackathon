import type { AssistantId } from '@fahq/contracts';
import type { HmemLike, MemoryRecordLike, MeterlessEngines } from './meterless.ts';

// One assistant's memory, on Meterless H-MEM. A proposal is a low-confidence, short-term memory
// tagged "unapproved". Only a person's decision becomes long-term memory, and it supersedes the
// proposal it settles. Recall for planning returns decisions only, so an unapproved model idea is
// never treated as a fact.
//
// A lesson is a change the HQ Manager recommended and a person adopted by code. It is long-term
// memory tagged "lesson" (never "decision"), so recallDecisions never returns it; lessons() does.
// A review note is the manager's own unapproved summary of a review: short-term, low confidence.

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

  /** A standing lesson the owner adopted. One memory per recommendation (a retried task finds it again). */
  rememberLesson(input: { recommendationId: string; text: string; adoptedBy: string; reviewId: string; runId: string }): MemoryRecordLike {
    const tag = `recommendation:${input.recommendationId}`;
    const existing = this.hmem.store.all().find((m) => m.tags.includes('lesson') && m.tags.includes(tag));
    if (existing) return existing;
    return this.hmem.add({
      content: input.text.slice(0, 2000),
      type: 'general',
      layer: 'long_term',
      confidence: 0.9,
      tags: ['lesson', 'adopted', tag],
      source: `fahq/${this.assistant}/lesson/${input.runId}`,
      provenance: { origin: 'manual', learnedAt: this.now(), label: `Adopted by ${input.adoptedBy}`, refs: [input.recommendationId, input.reviewId] },
    });
  }

  /** Adopted lessons that nothing superseded, newest first. */
  lessons(limit = 10): MemoryRecordLike[] {
    return this.hmem.store
      .all()
      .filter((m) => m.tags.includes('lesson') && m.tags.includes('adopted') && !m.supersededBy)
      .reverse() // insertion order is oldest first; the sort below is stable, so ties keep newest first
      .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
      .slice(0, limit);
  }

  /** The manager's summary of a review, unapproved until a person adopts something from it. One per review. */
  rememberReviewNote(input: { reviewId: string; summary: string; runId: string }): MemoryRecordLike {
    const tag = `review:${input.reviewId}`;
    const existing = this.hmem.store.all().find((m) => m.tags.includes('review') && m.tags.includes(tag));
    if (existing) return existing;
    return this.hmem.add({
      content: `Review ${input.reviewId}: ${input.summary}`.slice(0, 2000),
      type: 'general',
      layer: 'short_term',
      confidence: 0.4,
      tags: ['review', 'unapproved', tag],
      source: `fahq/${this.assistant}/review/${input.runId}`,
      provenance: { origin: 'model_response', learnedAt: this.now(), label: 'Unapproved review', refs: [input.reviewId] },
    });
  }

  /** Decisions only: what people approved or declined, most relevant first. */
  recallDecisions(query: string, topN = 5): Decision[] {
    return this.hmem
      .query(query, { topN: 25, threshold: 0.01 })
      .memories.filter((m) => m.memory.tags.includes('decision') && !m.memory.supersededBy)
      .slice(0, topN);
  }

  /**
   * Declined decisions whose plan title overlaps this plan's title: the plan may repeat a rejected
   * idea. Titles only, with the boilerplate words removed, scored by overlap (shared words over the
   * shorter title): comparing a whole summary with a short decision line never reached the old
   * Jaccard threshold on real plans.
   */
  declinedSimilarTo(planTitle: string, minOverlap = 0.6): MemoryRecordLike[] {
    const words = (t: string) => new Set(this.engines.tokenize(t).filter((w) => !BOILERPLATE.has(w)));
    const plan = words(planTitle);
    return this.hmem
      .store.all()
      .filter((m) => m.tags.includes('decision') && m.tags.includes('declined') && !m.supersededBy)
      .filter((m) => {
        const title = words(/"([^"]+)"/.exec(m.content)?.[1] ?? m.content);
        const shared = [...plan].filter((w) => title.has(w)).length;
        const shorter = Math.min(plan.size, title.size);
        return shorter >= 2 && shared / shorter >= minOverlap;
      });
  }
}

const BOILERPLATE = new Set([
  'the', 'and', 'for', 'with', 'to', 'of', 'on', 'in', 'by', 'at', 'our', 'your', 'a', 'an', 'plan', 'plans',
  'via', 'through', 'from', 'more', 'push', 'grow', 'growth', 'boost', 'drive', 'increase', 'aggressive', 'safe',
  'balanced', 'conservative', 'profit', 'double', 'doubling',
]);
