import type { Metric, ProposalDocument } from './schemas.ts';

// Ports are the seams between lanes. A lane implements a port; lane A's worker consumes it.

/** packages/data: business numbers through Zetaris. Read-only. */
export interface DataPort {
  /** Cheap reachability check; never throws. */
  health(): Promise<{ ok: boolean; detail: string }>;
  /**
   * Finance metrics for a period, salon and online kept separate. Every metric carries the same
   * query hash and the Zetaris view it came from. Throws a plain Error on any failure (no fallback).
   */
  getFinanceMetrics(input: { asOf: string; period: string }): Promise<{
    metrics: Metric[];
    queryHash: string;
    view: string;
  }>;
}

export type PrintResult =
  | { status: 'printed'; jobId: string }
  | { status: 'skipped'; reason: string };

/** Lane C (Codex): turning proposals into paper and texts. */
export interface DeliveryPort {
  renderProposalPdf(doc: ProposalDocument): Promise<Uint8Array>;
  /**
   * Sends one SMS for one outbox item. Must refuse a recipient that isn't in `allowedRecipients`
   * and must not send twice for the same outboxId.
   */
  sendSms(input: {
    outboxId: string;
    to: string;
    from: string;
    body: string;
    allowedRecipients: ReadonlySet<string>;
  }): Promise<{ providerMessageId: string }>;
  print(input: {
    outboxId: string;
    printerId: string | undefined;
    pdf: Uint8Array;
    title: string;
  }): Promise<PrintResult>;
}

/** Lane A: one chat call to an OpenAI-compatible provider, with cost accounting. */
export interface ModelPort {
  chat(input: {
    purpose: string;
    model: string;
    system: string;
    user: string;
    maxTokens: number;
    temperature: number;
    json: boolean;
    /** false turns off a reasoning model's thinking (fast classification); default: provider default. */
    thinking?: boolean;
  }): Promise<{ text: string; model: string; inputTokens: number; outputTokens: number; costUsd: number }>;
}
