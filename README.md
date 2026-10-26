# Fortune AI HQ — Unified AI Workforce

Private, isolated hackathon extension of Ezra’s existing agentic platform. The goal is a supervised customer-service analysis workflow with shared evidence and persistent findings. Existing business applications remain separate.

## Current status

This repository is a starter scaffold, not a completed sponsor integration. User-reported local verification: Cursor, Claude Code, and Codex each queried the same Docker-hosted Zetaris instance over REST; SELECT 1 and database discovery passed. Available databases: NY_TAXI, POKEAPI_REST, TPCDS_DB. Those credentials and local services are not installed in this repository. Meterless, Nemotron, Supabase orchestration, and the demo interface remain to be implemented.

## Smallest complete demo

1. Query synthetic repair tickets, orders, and service conversations through Zetaris.
2. Retrieve previous findings through a verified Meterless integration.
3. Ask NVIDIA Nemotron to identify missed follow-ups and recurring service problems, citing record IDs.
4. Save findings and evidence; propose a draft response and coaching recommendation.
5. Record a human approval decision. No messages or business changes execute automatically.

## Intended structure

- src/integrations/: separate adapters for Zetaris, Meterless, and Nemotron.
- src/workflows/: orchestration and approval boundaries.
- data/synthetic/: invented records only.
- docs/: architecture, integration verification, and demo instructions.
- AGENTS.md: shared instructions for coding assistants.
- .env.example: placeholders; real configuration stays local.

## Development handoff

Clone this repository in Ubuntu alongside, not inside, ~/zetaris-platform and ~/getting-started. Read AGENTS.md first. Inspect the existing headquarters only when access and its location are supplied. Reuse narrowly reviewed components rather than copying a private repository or its Git history. Do not rebuild the headquarters.

First implementation milestone: document reusable interfaces, verify current official sponsor APIs, then implement one end-to-end workflow with synthetic data and tests for approval and evidence provenance. Treat mocked runs as mocked and live runs as live.

## Submission preparation

Confirm current event rules, eligibility, deadline, required sponsor products, repository access, and licensing before submission. Prepare a reproducible quickstart, actual integration evidence, a short demo video, and slides. No event requirements or sponsor compatibility are independently verified by this scaffold. Keep this repository private until Ezra explicitly approves a visibility change.
