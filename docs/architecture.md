# Architecture and implementation handoff

Status: design only. No backend, database migration, vendor SDK, or runtime integration is implemented.

## Boundaries
The existing headquarters owns its current business integrations. This clean repository owns only the isolated demonstration and reviewed reusable interfaces. Do not move production into this repository.

Zetaris supplies approved read-only records across demo sources. Nemotron analyzes those records. Meterless is intended to supply persistent findings/context; select and verify an actual supported product/API before implementation. Optional isolated Supabase storage owns task/run/approval audit records, not a second undocumented memory authority.

## Workflow
1. Create run_id, fixed evaluation time, and synthetic dataset version.
2. Query demo-only records through a Zetaris adapter; preserve query identity and source record IDs. Fail explicitly on authentication, timeouts, or missing data. Never silently replace live results with fixture output.
3. Retrieve relevant prior findings using a verified Meterless adapter. Preserve scope, provenance, versions, and conflicting findings.
4. Call a configured Nemotron model with minimum required records. Treat conversation text as data, not system instructions. Validate structured results and reject nonexistent evidence IDs.
5. Store findings with run_id, model ID, source IDs, and timestamps. Keep model recommendations separate from authoritative source facts.
6. Create a draft action. Approval state must transition explicitly from draft to approved/rejected with reviewer and timestamp. This demo records decisions only; it does not send messages or mutate business data.

## Planned storage entities
- runs: id, status, evaluation_time, dataset_version, provider/model IDs, started_at, completed_at, error category.
- findings: id, run_id, summary, evidence_ids, memory_reference, created_at.
- proposed_actions: id, finding_id, draft_body, status, reviewer_id, reviewed_at.
Use server-side credentials, authenticated ownership checks, and appropriate row-level policies before exposing a hosted interface.

## Implementation sequence
1. Inspect authorized existing HQ interfaces and choose the smallest reusable boundary.
2. Verify current official sponsor APIs, product requirements, SDK versions, licenses, endpoint/auth formats, and event rules. Record sources in an integration verification document.
3. Add dependency manifests and lockfiles only after choosing a stack aligned with the existing HQ.
4. Build deterministic fixture mode and adapter-level live mode with explicit labeling.
5. Seed only synthetic records into an explicitly authorized demo namespace; demonstrate a join across at least two sources if supported and required.
6. Test evidence validation, approval defaults, resolved-ticket exclusion, missing memory, provider failure, retries, and duplicate runs.
7. Record a reproducible demo with sanitized integration proof.

## Acceptance criteria
- The scenario flags demo-t001 as overdue at its fixed as_of time and excludes resolved demo-t002.
- Each finding cites actual supplied evidence.
- A repeat run retrieves an earlier finding rather than claiming memory without proof.
- Live Zetaris and Nemotron calls, and the selected Meterless functionality, are evidenced independently.
- Approval is recorded and external execution stays disabled.
- A new developer can reproduce the documented result with their own demo credentials.

## Submission assets to prepare
Working quickstart, architecture explanation, sponsor contribution and live/mock matrix, limitations, demo recording, slide deck, and license/provenance review. Repository remains private pending Ezra’s authorization.
