import type { Division, Metric, Period, ProposalDocument } from './schemas.ts';

// Ports are the seams between lanes. A lane implements a port; lane A's worker consumes it.

/** A fixed data rule that fired: the program, never a model, says a number needs a look. */
export type Attention = { metricId: string; level: 'watch' | 'act'; rule: string };

/** One division's numbers, read through that division's own Zetaris mart. */
export type DivisionData = {
  division: Division;
  metrics: Metric[];
  /** The attention rules that fired on these metrics (empty when everything is normal). */
  attention: Attention[];
  queryHash: string;
  /** The Zetaris mart (or view) the numbers came from. */
  view: string;
};

/** packages/data: business numbers through Zetaris. Read-only. */
export interface DataPort {
  /**
   * One division's metrics for a period (period totals plus the as-of-now "standing" numbers), with
   * the attention rules that fired. Optional: a port without it is read through getFinanceMetrics,
   * sliced by business (see the worker's divisionData).
   */
  getDivisionMetrics?(input: { division: Division; period: string; asOf: string }): Promise<DivisionData>;
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
  /**
   * The metrics this port can return, so a read tool can name the exact ids up front instead of
   * leaving a script to guess labels. Optional: a port without it just gets a shorter description.
   */
  readonly catalog?: readonly MetricInfo[];
  /**
   * The periods this port serves, oldest first, so a read tool offers exactly those. Optional: a port
   * without it serves DEFAULT_PERIODS.
   */
  readonly periods?: readonly Period[];
}

export type MetricInfo = Pick<Metric, 'id' | 'label' | 'unit' | 'business'> & {
  /** Who reads it; absent on a port that has no divisions (every metric is then its business's). */
  divisions?: readonly Division[];
};

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

/**
 * One read-only function an assistant's Code Mode script may call (as `codemode.<name>(args)`).
 * Writes are never tools: proposals and reports are fixed code paths in the worker.
 */
export type ReadTool = {
  /** A JavaScript identifier. */
  name: string;
  /** One line: what it returns and where the data comes from. */
  description: string;
  /** The typed signature shown to the model, e.g. '(args: { period: "2026-09" }) => Promise<{ metrics: Metric[] }>'. */
  signature: string;
  /** Validates its own arguments; returns plain JSON. */
  run: (args: unknown) => Promise<unknown>;
};

/** What one read tool returned to a script, as the sandbox received it (plain JSON). */
export type ToolOutput = { tool: string; output: unknown };

export type CodeModeResult = {
  ok: boolean;
  /**
   * The script's return value (plain JSON) when ok. A result is only ok when at least one tool returned
   * data to the script, but the runner cannot tell arithmetic from a number the script typed itself:
   * check numbers against `toolOutputs` (see `untracedResultNumbers` in @fahq/codemode).
   */
  result: unknown;
  /** Why it failed, in a plain sentence, when not ok. */
  error: string | null;
  script: string | null;
  attempts: number;
  /** Calls made over all attempts, including refused ones. */
  toolCalls: number;
  /**
   * What each tool returned during the run that produced `result`, in call order (empty when not ok).
   * Held in memory for number checks; it never reaches a prompt.
   */
  toolOutputs: ToolOutput[];
  /** Characters of the script's result (what reaches the next model instead of raw tool output). */
  resultChars: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
};

/**
 * Cloudflare Code Mode inside the worker: a model writes one script against an assistant's typed
 * read API, the QuickJS sandbox runs it with only those tools, and only the script's small result
 * goes on to the next model. One retry with the sandbox's error, then a plain failure.
 */
export type CodeModeRunner = (input: {
  /** Receipt step name, e.g. 'owner.lookup'. */
  purpose: string;
  /** The model that writes the script. */
  model: string;
  /** The assistant's skill text (its rules), placed before the API in the system prompt. */
  skill: string;
  question: string;
  tools: readonly ReadTool[];
}) => Promise<CodeModeResult>;

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
    /** true sends the user message alone, with no system message (safety-guard models answer a bare message). */
    noSystem?: boolean;
  }): Promise<{ text: string; model: string; inputTokens: number; outputTokens: number; costUsd: number }>;
}
