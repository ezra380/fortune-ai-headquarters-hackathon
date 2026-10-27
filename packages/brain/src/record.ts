import type { AssistantId } from '@fahq/contracts';
import type { WorldModelLike, WmProvenance } from './meterless.ts';

// The shared record: who asked what, which assistant proposed what, which numbers it cited, and
// what a person decided. Backed by the Meterless World Model (append-only, single writer, nothing
// deleted). Timestamps come from the event itself, so replaying the same event changes nothing.

export type Stamp = { at: string; runId: string };

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
    await this.wm.relate({ from: person.id, type: 'asked', to: request.id, source: this.source(input) });
    await this.wm.relate({ from: request.id, type: 'assigned_to', to: toAssistant.id, source: this.source(input) });
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
    await this.wm.relate({ from: assistant.id, type: 'proposed', to: proposal.id, source: this.source(input) });
    await this.wm.relate({ from: proposal.id, type: 'answers', to: request.id, source: this.source(input) });
    for (const metricId of input.citedMetricIds) {
      const metric = await this.wm.upsertEntity({
        type: 'metric',
        externalKey: { system: 'zetaris', id: metricId },
        name: metricId,
        attrs: {},
        source: this.source(input),
      });
      await this.wm.relate({ from: proposal.id, type: 'cites', to: metric.id, source: this.source(input) });
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
    await this.wm.relate({
      from: person.id,
      type: input.action === 'forward_plan' ? 'forwarded' : input.verdict === 'signed' ? 'approved' : 'declined',
      to: proposal.id,
      attrs: { planRank: input.planRank },
      source: this.source(input),
    });
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
    await this.wm.relate({ from: assistant.id, type: 'reported', to: report.id, source: this.source(input) });
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
    await this.wm.relate({ from: manager.id, type: 'wrote', to: review.id, source: this.source(input) });
    for (const id of input.reviewed ?? []) {
      const reviewed = await this.entity('assistant', `assistant:${id}`, id, {}, input);
      await this.wm.relate({ from: manager.id, type: 'reviewed', to: reviewed.id, source: this.source(input) });
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
    await this.wm.relate({ from: review.id, type: 'recommended', to: recommendation.id, source: this.source(input) });
    await this.wm.relate({ from: person.id, type: 'adopted', to: recommendation.id, source: this.source(input) });
    await this.wm.relate({ from: recommendation.id, type: 'guides', to: assistant.id, source: this.source(input) });
    return recommendation.id;
  }

  /** Oldest first. `type` is the World Model event kind (upsertEntity, relate, assertFact, ...). */
  timeline(limit = 50): readonly { id: string; type: string; at: string }[] {
    return this.wm.events().slice(-limit).map((e) => ({ id: e.id, type: e.kind, at: e.at }));
  }

  audit(limit = 50) {
    return this.wm.audit().slice(-limit);
  }
}
