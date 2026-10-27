import { randomInt } from 'node:crypto';
import type { AssistantId, CodeModeRunner, DataPort, DeliveryPort, ModelPort, ReadTool } from '@fahq/contracts';
import type { Brain } from '@fahq/brain';
import { createReadTools, pick } from './read-tools.ts';
import type { PersonRow, Store, TaskRow } from './store.ts';

// What every flow shares: the worker's dependencies, the outcome of a task, and the small helpers that
// write a receipt or queue a text. (flows.ts re-exports the types other files already import from it.)

export type WorkerDeps = {
  store: Store;
  brain: Brain;
  models: { nvidia: ModelPort; planModel: string; routerModel: string };
  /** The safety model every free text is screened by before anything starts; null = the screen is off. */
  guard: { model: string } | null;
  data: DataPort | null;
  delivery: DeliveryPort | null;
  /** Cloudflare Code Mode in the worker; null = not wired, and the steps that need it fail plainly. */
  codeMode: CodeModeRunner | null;
  /** Each assistant's skill text, the model for each of its jobs, and the read tools it may use. */
  profiles: {
    skill(id: AssistantId): string;
    model(id: AssistantId, job: 'code' | 'answer' | 'review'): string;
    reads(id: AssistantId): readonly string[];
  };
  now: () => Date;
  /** Names the claim loop that holds a task (runConcurrently adds `#<n>` for each loop). */
  worker: string;
  /** How often, in milliseconds, the lease of a task being handled is renewed. Default: once a minute. */
  leaseRenewMs?: number;
  /** true when talking to real providers; recorded on every receipt. */
  live: boolean;
  period: '2026-09' | '2026-10-mtd';
  smsLive: boolean;
  printers: Partial<Record<AssistantId, string>>;
  printDir: string;
  /** Dry-run SMS go here (and to the console) instead of Twilio. */
  smsSink?: (message: { to: string; body: string }) => void;
};

export type Outcome = { status: 'done' | 'failed'; error?: string };

export const newCode = () => String(randomInt(100000, 1000000));
/** A thrown error's own sentence, or the fallback when it has none. */
export const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);
export const done: Outcome = { status: 'done' };
export const fail = (error: string): Outcome => ({ status: 'failed', error });

/** The synthetic numbers of this repository (+1555…), and no number at all, are not live: nothing real can be texted. */
export const isLiveNumber = (number: string | null): boolean => number !== null && /^\+1\d{10}$/.test(number) && !number.startsWith('+1555');

export async function receipt(
  deps: WorkerDeps,
  r: {
    runId: string; taskId: string | null; step: string; assistant: AssistantId | null; started: Date;
    outcome: 'ok' | 'refused' | 'failed'; model?: string; dataSource?: string; detail?: string;
    inputTokens?: number; outputTokens?: number;
  },
) {
  await deps.store.receipt({
    runId: r.runId, taskId: r.taskId, step: r.step, assistantId: r.assistant, live: deps.live,
    model: r.model ?? null, dataSource: r.dataSource ?? null, startedAt: r.started.toISOString(),
    endedAt: deps.now().toISOString(), costUsd: null, outcome: r.outcome, detail: r.detail?.slice(0, 500) ?? null,
    inputTokens: r.inputTokens ?? null, outputTokens: r.outputTokens ?? null,
  });
}

export async function text(deps: WorkerDeps, to: PersonRow, from: AssistantId, body: string, dedupeKey: string) {
  await deps.store.addOutbox({ channel: 'sms', toPersonId: to.id, from, body, attachmentRef: null, dedupeKey });
}

/** The code acts as the person it was issued to (on a shared phone, not necessarily the texted assistant's). */
export async function approverOf(approverId: string | null, sender: PersonRow, task: TaskRow, deps: WorkerDeps) {
  const person = approverId && approverId !== sender.id ? await deps.store.person(approverId) : sender;
  const answer = (body: string) => text(deps, person, person.assistant_id, body, `reply:${task.id}`);
  return { person, answer };
}

/** An SMS body of at most 1600 characters that always keeps its last line (the code and how to reply). */
export function fitSms(head: string, tail: string): string {
  const room = 1600 - tail.length - 1;
  return `${head.length > room ? `${head.slice(0, room - 1).trimEnd()}…` : head}\n${tail}`;
}

/** The read tools an assistant's profile allows. A name that does not exist throws (never silently dropped). */
export function toolsFor(deps: WorkerDeps, id: AssistantId): ReadTool[] {
  const ctx = { store: deps.store, brain: deps.brain, data: deps.data, now: deps.now };
  return pick(createReadTools(ctx, id), deps.profiles.reads(id));
}
