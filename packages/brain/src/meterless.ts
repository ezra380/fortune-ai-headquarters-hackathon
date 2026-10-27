import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Meterless's open reference engines (Apache-2.0) are fetched at a pinned commit into
// METERLESS_DIR by scripts/setup-meterless.sh and loaded at runtime, so their source is never copied
// into this repository. These are the narrow shapes we use; the engines' own types stay upstream.

export type WmProvenance = { kind: string; by?: string; at: string | Date; runId?: string };

export interface WorldModelLike {
  upsertEntity(input: {
    type: string;
    externalKey?: { system: string; id: string };
    name?: string;
    attrs?: Record<string, unknown>;
    source: WmProvenance;
  }): Promise<{ id: string; type: string; name?: string; attrs: Record<string, unknown> }>;
  relate(input: {
    from: string;
    type: string;
    to: string;
    attrs?: Record<string, unknown>;
    source: WmProvenance;
  }): Promise<{ id: string }>;
  assertFact(input: {
    about: string;
    predicate: string;
    value: unknown;
    source: WmProvenance;
  }): Promise<{ id: string }>;
  /** WorldEvent upstream: the event's type is `kind` (upsertEntity, relate, assertFact, ...). */
  events(): readonly { id: string; seq: number; kind: string; at: string; payload?: unknown }[];
  /** AuditEntry upstream. */
  audit(): readonly { seq: number; at: string; kind: string; actor: string; summary: string; eventId?: string; runId?: string }[];
}

export interface MemoryRecordLike {
  id: string;
  content: string;
  layer: string;
  tags: string[];
  confidence: number;
  source: string;
  supersededBy?: string;
  /** When the memory was written (milliseconds); H-MEM sets it. */
  timestamp?: number;
}

export interface HmemLike {
  add(input: {
    content: string;
    type?: 'personal' | 'factual' | 'preference' | 'general';
    layer?: 'short_term' | 'working' | 'long_term';
    tags?: string[];
    confidence?: number;
    source: string;
    provenance?: { origin: string; learnedAt: number; label: string; refs?: string[] };
    supersedes?: string;
  }): MemoryRecordLike;
  query(q: string, opts?: { topN?: number; threshold?: number }): {
    /** Upstream names the score `relevance` (hmem/reference/src/types.ts). */
    memories: { memory: MemoryRecordLike; relevance: number }[];
  };
  store: { get(id: string): MemoryRecordLike | undefined; all(): MemoryRecordLike[] };
}

export interface MeterlessEngines {
  WorldModel: new (opts: {
    namespace: string;
    storage: 'memory' | 'local';
    directory?: string;
    clock?: () => Date;
  }) => WorldModelLike;
  HMEM: new (opts: { persistDir?: string; actor?: string; clock?: () => number }) => HmemLike;
  tokenize: (text: string) => string[];
  jaccard: (a: Iterable<string>, b: Iterable<string>) => number;
}

export async function loadMeterless(meterlessDir: string): Promise<MeterlessEngines> {
  const engines = path.resolve(meterlessDir, 'engines');
  const worldModel = path.join(engines, 'world-model/reference/src/index.ts');
  const hmem = path.join(engines, 'hmem/reference/src/index.ts');
  for (const file of [worldModel, hmem]) {
    if (!fs.existsSync(file)) {
      throw new Error(`Meterless engines not found at ${meterlessDir}. Run scripts/setup-meterless.sh first.`);
    }
  }
  const wm = (await import(pathToFileURL(worldModel).href)) as { WorldModel: MeterlessEngines['WorldModel'] };
  const hm = (await import(pathToFileURL(hmem).href)) as {
    HMEM: MeterlessEngines['HMEM'];
    tokenize: MeterlessEngines['tokenize'];
    jaccard: MeterlessEngines['jaccard'];
  };
  return { WorldModel: wm.WorldModel, HMEM: hm.HMEM, tokenize: hm.tokenize, jaccard: hm.jaccard };
}
