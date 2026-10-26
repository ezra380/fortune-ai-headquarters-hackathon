import path from 'node:path';
import type { AssistantId } from '@fahq/contracts';
import { loadMeterless, type MeterlessEngines } from './meterless.ts';
import { AssistantMemory } from './memory.ts';
import { SharedRecord } from './record.ts';

export { SharedRecord } from './record.ts';
export type { Stamp } from './record.ts';
export { AssistantMemory } from './memory.ts';
export type { Decision } from './memory.ts';
export { loadMeterless } from './meterless.ts';

export type Brain = {
  record: SharedRecord;
  memory(assistant: AssistantId): AssistantMemory;
  engines: MeterlessEngines;
};

/**
 * Opens the company brain: one World Model namespace for the shared record and one H-MEM store per
 * assistant. Exactly one process (the worker) may write; readers open their own copy.
 */
export async function openBrain(opts: {
  meterlessDir: string;
  dataDir: string;
  actor: string;
  namespace?: string;
  clock?: () => Date;
}): Promise<Brain> {
  const engines = await loadMeterless(opts.meterlessDir);
  const clock = opts.clock ?? (() => new Date());
  const wm = new engines.WorldModel({
    namespace: opts.namespace ?? 'fortune-demo',
    storage: 'local',
    directory: path.join(opts.dataDir, 'world'),
    clock,
  });
  const record = new SharedRecord(wm, opts.actor);
  const memories = new Map<AssistantId, AssistantMemory>();
  const memory = (assistant: AssistantId): AssistantMemory => {
    let m = memories.get(assistant);
    if (!m) {
      const hmem = new engines.HMEM({
        persistDir: path.join(opts.dataDir, 'memory', assistant),
        actor: `${opts.actor}/${assistant}`,
        clock: () => clock().getTime(),
      });
      m = new AssistantMemory(hmem, assistant, engines, () => clock().getTime());
      memories.set(assistant, m);
    }
    return m;
  };
  return { record, memory, engines };
}
