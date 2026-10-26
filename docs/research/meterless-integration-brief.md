# Integration Brief

## World Model

### 1. Public Entry Points
- `class WorldModel` (`@world-model/reference/src/index.ts:38`)
  - `constructor(opts: WorldModelOptions)` (`@world-model/reference/src/index.ts:43`)
  - `upsertEntity(input: UpsertEntityInput): Promise<Entity>` (`@world-model/reference/src/index.ts:59`)
  - `upsertContext(input: UpsertContextInput): Promise<Context>` (`@world-model/reference/src/index.ts:98`)
  - `relate(input: RelateInput): Promise<Relationship>` (`@world-model/reference/src/index.ts:117`)
  - `assertFact(input: AssertFactInput): Promise<Fact>` (`@world-model/reference/src/index.ts:139`)
  - `ingest(observations: IngestObservation[]): Promise<IngestReport>` (`@world-model/reference/src/index.ts:184`)
  - `view(name: "graph"): GraphView` (and other overloads) (`@world-model/reference/src/index.ts:212`)
  - `registerView<S>(name: string, spec: CustomView<S>): void` (`@world-model/reference/src/index.ts:229`)
  - `mergeQueue(): readonly MergeProposal[]` (`@world-model/reference/src/index.ts:235`)
  - `approveMerge(proposalId: string, by: string): Promise<void>` (`@world-model/reference/src/index.ts:239`)
  - `rejectMerge(proposalId: string, by: string): Promise<void>` (`@world-model/reference/src/index.ts:252`)
  - `audit(): readonly import("./types.ts").AuditEntry[]` (`@world-model/reference/src/index.ts:263`)
  - `events(): readonly WorldEvent[]` (`@world-model/reference/src/index.ts:267`)
  - `stateShape(): unknown` (`@world-model/reference/src/index.ts:271`)
  - `stateShapeCanonical(): string` (`@world-model/reference/src/index.ts:275`)
  - `subscribeEvents(fn: (e: WorldEvent) => void): () => void` (`@world-model/reference/src/index.ts:279`)

### 2. Minimal Call Sequence
```typescript
import { WorldModel } from "@world-model/reference/src/index.ts";

const wm = new WorldModel({ namespace: "demo", storage: "local", directory: "./data" });

// Ingest a batch of observations
await wm.ingest([
  {
    externalId: "obs-1",
    type: "document",
    title: "Project Alpha",
    at: "2026-10-26T10:00:00Z",
    source: { kind: "manual", at: "2026-10-26T10:00:00Z" }
  }
]);

// Or write records individually
await wm.upsertEntity({ type: "person", name: "Alice", source: { kind: "manual", at: new Date() } });
await wm.upsertContext({ type: "project", attrs: { name: "Alpha" }, source: { kind: "manual", at: new Date() } });
await wm.relate({ from: "person:alice", type: "works_on", to: "project:alpha", source: { kind: "manual", at: new Date() } });
await wm.assertFact({ about: "person:alice", predicate: "role", value: "lead", source: { kind: "manual", at: new Date() } });

// Read views and audit log
const graph = wm.view("graph");
const auditLog = wm.audit();
```

### 3. Gotchas
- **Single-Writer Queue:** Every mutation goes through a FIFO promise queue per instance so concurrent writes serialize safely.
- **Idempotency & Clocks:** Idempotency is maintained because record timestamps derive purely from the observation `at` time, never the wall clock. The wall clock is ONLY used for operator actions (merge approvals, view rebuilds).
- **Conflict Resolution:** Name-keyed entities that are near-duplicates either auto-merge (similarity >= 0.85) or queue for review ([0.82, 0.85)).
- **Relationships:** A new open edge with the same `(from, type, context)` but a different target *closes* the old edge (`validTo` is set) rather than deleting it.

---

## H-MEM

### 1. Public Entry Points
- `class HMEM` (`@hmem/reference/src/index.ts:16`)
  - `constructor(opts: HMEMOptions = {})` (`@hmem/reference/src/index.ts:26`)
  - `add(input: AddInput): MemoryRecord` (`@hmem/reference/src/index.ts:40`)
  - `mine(event: MiningEventType, text: string, opts?: { chatId?: string }): Promise<MemoryRecord[]>` (`@hmem/reference/src/index.ts:43`)
  - `query(query: string, opts?: { topN?: number; threshold?: number; chatId?: string }): QueryResult` (`@hmem/reference/src/index.ts:46`)
  - `feedback(memoryId: string, kind: FeedbackKind): void` (`@hmem/reference/src/index.ts:49`)
- `class DreamingService` (`@hmem/reference/src/dreaming.ts:11`) (Exposed via `HMEM.dreaming`)
  - `dream(): DreamProposal[]` (`@hmem/reference/src/dreaming.ts:47`)
  - `pending(): DreamProposal[]` (`@hmem/reference/src/dreaming.ts:98`)
  - `approve(proposalId: string): MemoryRecord | undefined` (`@hmem/reference/src/dreaming.ts:102`)
  - `reject(proposalId: string): void` (`@hmem/reference/src/dreaming.ts:118`)

### 2. Minimal Call Sequence
```typescript
import { HMEM } from "@hmem/reference/src/index.ts";

const hmem = new HMEM({ persistDir: "./hmem-data" });

// Add memory (supersedes can be provided or auto-detected based on content similarity)
hmem.add({
  content: "User prefers dark mode",
  type: "preference",
  source: "chat",
  supersedes: "mem-1" // explicit manual supersede
});

// Query
const results = hmem.query("dark mode preferences", { topN: 3 });

// Dreaming: proposal and review flow
const proposals = hmem.dreaming.dream();
const pending = hmem.dreaming.pending();
if (pending.length > 0) {
  hmem.dreaming.approve(pending[0].id);
  // or hmem.dreaming.reject(pending[0].id);
}
```

### 3. Gotchas
- **Source Requirement:** A record with no `source` string is rejected by construction.
- **Auto-Enrichment:** Enrichment (domain classification, entity extraction, relation discovery, supersede detection) runs synchronously on *every* `add()`.
- **Dreaming Flow:** Proposals are *NEVER* auto-materialized. They must be explicitly passed to `approve()` to turn into durable memory with lineage.

---

## Markovian

### 1. Public Entry Points
- `class Markovian` (`@markovian/reference/src/index.ts:16`)
  - `constructor(opts: MarkovianOptions = {})` (`@markovian/reference/src/index.ts:24`)
  - `onProgress(fn: (s: ProgressState) => void): () => void` (`@markovian/reference/src/index.ts:32`)
  - `run(options: RunOptions): Promise<MarkovianRun>` (`@markovian/reference/src/index.ts:36`)

### 2. Minimal Call Sequence
```typescript
import { Markovian } from "@markovian/reference/src/index.ts";

const markovian = new Markovian({ historyDir: "./runs" });

// Run multi-step job with a custom model call function
await markovian.run({
  goal: "Analyze the documentation and summarize it",
  generator: async (prompt, attachments, sysPrompt, onStream, abortSignal) => {
    // Custom LLM invocation
    return { text: "Generated marker content: [DONE]" };
  },
  // Alternately use stepFn for a simpler interface:
  // stepFn: async ({ goal, carryover, step }) => { return { content: "..." }; }
});
```

### 3. Gotchas
- **Reflection Failure is Non-Fatal:** If the optional reflection pass fails at the end, it never fails the overall run (the output is preserved and the error is logged).
- **Abort & Persistence:** The abort signal is checked *before* generating each chunk and *before* compression. Persisting the chunk happens immediately after generation, meaning aborting still preserves partial output.
- **Estimated Tokens:** Markovian strictly uses an estimation of `Math.ceil(chars / 4)` for token accounting, labeled as `"estimated"`.

---

## Scout (Intent Engine)

### 1. Public Entry Points
- `class Scout` (`@scout-intent/AGENTS.md:39`)
  - `constructor(options: { intentRegistry: string | IntentRegistry; policyPack?: string; modelProfiles?: string; })` (`@scout-intent/AGENTS.md:40`)
  - `decide(input: { prompt: string; user?: UserRef; surface: string; context?: unknown }): Promise<Decision>` (`@scout-intent/AGENTS.md:47`)
  - `classify(input: { prompt: string; surface: string }): Promise<{ candidates: IntentCandidate[] }>` (`@scout-intent/AGENTS.md:50`)
  - `replan(input: { parent: string; reason: string; state?: unknown }): Promise<Decision>` (`@scout-intent/AGENTS.md:53`)

### 2. Execution Contract
The execution contract is the ONLY artifact downstream engines accept (`@scout-intent/AGENTS.md:195`):
```typescript
type ExecutionContract = {
  contractId: string;            
  parentId?: string;             // For re-planning lineage
  traceId: string;               // Telemetry correlation
  intent: { primary: string, parameters: any, references: any, confidence: number, alternates: any };
  risk: { level: string, flags: any, redactions: any, approvals: any };
  toolPlan: ToolStep[];
  modelProfile: ModelProfileRef;
  scope: { user: any, surface: string, capabilities: string[], deadline?: Date, budget?: any };
  issuedAt: ISODate;
  expiresAt: ISODate;            // Default TTL: 5 minutes
  registryVersion: number;
  policyPackVersion: string;
  signature: string;             // HMAC_SHA256 signature
  signedBy: "scout";
};
```

### 3. Gotchas
- **Nothing Acts on a Raw Prompt:** Executors strictly consume verified `ExecutionContract` artifacts. 
- **Registry Floor:** If an intent is not in the registry, it cannot be acted on. This mathematically bounds system scope drift.
- **Mandatory Expiration & Signature:** Contracts default to a 5-minute TTL (`expiresAt`) and are fully immutable post-signature. Extensions are forbidden; long jobs must `replan()`. Signatures are mandatory even in development.
- **Refuse at the Boundary:** Scope violations are rejected by the executor verifying the contract (e.g. attempting to call an unlisted tool), not by polite pre-wrapping.
