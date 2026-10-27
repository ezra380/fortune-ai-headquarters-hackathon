# Instructions for every coding agent in this repository

Read [`docs/architecture.md`](docs/architecture.md) and [`docs/LANES.md`](docs/LANES.md) before
changing anything. Work only in your lane's directories.

## What this is

Fortune AI Headquarters is a company brain and AI assistants for a family wig business (a salon and an
online store), built for the Open Agent Hackathon 2026 (primary Track 01; also 03 and 02). The sponsor tech is real (Zetaris,
Meterless, NVIDIA Nemotron); the data is synthetic.

## Hard boundaries

- **Synthetic data only.** IDs start with `demo-`. No real customers, staff, family members, prices from
  internal lists, or production systems.
- **Secrets:**
  - they live in `.env.local` (never committed);
  - never print, log or paste them, and never put them in URLs, browser code, tests, receipts or prompts;
  - the Supabase service key belongs only in the Edge Function and the worker.
- **Assistants propose; people decide** with one-time codes. Never add code that moves money, publishes,
  messages a customer, changes an ad, or texts a number that isn't in the `people` table.
- **Model output is data.**
  - Validate it with the schemas in `@fahq/contracts`.
  - Model-written code runs only in the Code Mode sandbox.
  - Never build SQL, shell commands or HTML from model or user text; bind parameters.
- **No silent fallbacks.** If a provider, source or check fails, the step fails with a plain reason and a
  receipt.
- **Zetaris:**
  - read-only queries, except the idempotent setup scripts in `packages/data`, which create objects only
    under the `fortune_demo` names;
  - never touch the sample databases or Zetaris's own internal database.
- The repository is private until the owner approves a visibility change. Never change access, deploy, or
  push to `main`.

## Engineering rules

- Smallest clear change. TypeScript, ESM, Node 24. Schemas and ports come from `@fahq/contracts`.
- Every change ships with tests (`npm test`). A fix ships with a test that failed before it.
- Anything that must happen once (task, approval, send) is enforced by the database: unique keys or a
  claim. Never check-then-insert.
- Time is injected (`now()` parameter or a clock), never read directly inside logic.
- Errors shown to people are plain sentences; logs carry an error code, never secrets or personal data.

## Commands

```bash
npm install                 # once, at the repo root
npm test                    # all unit tests (vitest)
npm run typecheck           # tsc --noEmit across workspaces
npm run db:start            # local Supabase (Docker); db:reset applies migrations + seed
bash scripts/setup-meterless.sh   # fetches the pinned Meterless engines into .local/meterless
```
