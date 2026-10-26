/** Internal adapter contracts only; these are not vendor SDK APIs. */
export type SourceRecord = { id: string; source: string; data: Record<string, unknown> };
export type Finding = { id: string; runId: string; summary: string; evidenceIds: string[]; createdAt: string };
export type MemoryEntry = { finding: Finding; namespace: string; version: string };
export type DraftAction = { id: string; findingId: string; body: string; status: "draft" };

export interface DataAdapter {
  // Implementation must allowlist read-only demo queries and preserve source IDs.
  loadDemoRecords(input: { runId: string; datasetVersion: string }): Promise<SourceRecord[]>;
}
export interface MemoryAdapter {
  recall(input: { namespace: string; query: string }): Promise<MemoryEntry[]>;
  remember(input: { namespace: string; finding: Finding }): Promise<MemoryEntry>;
}
export interface AnalysisAdapter {
  analyze(input: { runId: string; asOf: string; records: SourceRecord[]; priorFindings: MemoryEntry[] }): Promise<{ modelId: string; findings: Finding[]; drafts: DraftAction[] }>;
}

// TODO: implement Zetaris, verified Meterless product, and Nemotron adapters.
// Validate model output at runtime; TypeScript types alone do not validate JSON.
