import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Meterless's open reference engines (Apache-2.0) are fetched at a pinned commit into
// METERLESS_DIR by scripts/setup-meterless.sh and loaded at runtime, so their source is never copied
// into this repository. These are the narrow shapes we use; the engines' own types stay upstream.

export type WmProvenance = { kind: string; by?: string; at: string | Date; runId?: string };

export type WmEntity = { id: string; type: string; name?: string; attrs: Record<string, unknown>; createdAt?: string };

/**
 * The graph view's reads we use (GraphView upstream, engines/world-model/reference/src/index.ts).
 * Closed edges (a newer edge superseded them) are left out of every one of these.
 */
export interface GraphViewLike {
  entity(id: string): WmEntity | undefined;
  /** Entities on the other end of an open edge, in either direction. */
  neighborsOf(id: string, opts?: { via?: string; inContext?: string }): WmEntity[];
  /** The sources of open edges that point at this entity. */
  incoming(id: string, opts?: { via?: string }): WmEntity[];
}

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
    /**
     * A new open edge with the same (from, type, context) and a different target CLOSES the old one
     * (store.ts, the `relate` case). Pass the target's id here whenever one source may have many targets.
     */
    context?: string;
    attrs?: Record<string, unknown>;
    source: WmProvenance;
  }): Promise<{ id: string }>;
  assertFact(input: {
    about: string;
    predicate: string;
    value: unknown;
    source: WmProvenance;
  }): Promise<{ id: string }>;
  view(name: 'graph'): GraphViewLike;
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
  /** The memory this one replaces, as it was given when it was added (H-MEM only links it; it does not mark the old one). */
  supersedes?: string;
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
