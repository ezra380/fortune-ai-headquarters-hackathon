# Fortune AI Headquarters

**A company brain and AI assistants for a family-run wig business: a salon and an online store, kept
separate.** Every AI tool reads the same brain through one MCP door. Assistants propose; people decide
with one-time codes. Built for the Open Agent Hackathon 2026, Track 02: "The Agent That Can Explain
Why".

> All data here is synthetic. No customer, staff or family records and no production credentials.

## The flagship workflow

The owner texts his assistant: *"Ask the finance assistant for three aggressive plans to double profit this
month."*
1. The SMS webhook stores the task once and answers "working on it" in about a second.
2. A front door on **NVIDIA Nemotron Lightning** routes the text and flags the risks.
3. The finance assistant pulls numbers through **Zetaris**, a federated view over separately owned salon,
   online and marketing sources.
4. It recalls past decisions from **Meterless H-MEM** and asks **Nemotron 3 Ultra** for three plans.
5. A validator rejects any plan whose numbers don't trace to a Zetaris metric, a computed projection, or
   a declared proposed setting.
6. The owner forwards one plan with `SEND <n> <code>`, and the finance owner answers `CONFIRM <code>` or
   `DECLINE <code>`.
7. Everything is recorded in the **Meterless World Model**, and the decision becomes long-term memory.
8. Every AI tool can read the same brain through **Cloudflare Code Mode**: one typed `code` tool, run in a
   sandbox.

Architecture: [`docs/architecture.md`](docs/architecture.md) · Who builds what: [`docs/LANES.md`](docs/LANES.md)

## Status (live vs mock, updated as lanes land)

| Piece | State | Proof |
|---|---|---|
| Queue, mailbox, approval codes, outbox, receipts, spending cap (Supabase) | **Working** on local Supabase | 10 real-Postgres tests: duplicates, concurrent claims, leases, code refusals and lockout, cap under concurrency, anon sees nothing |
| SMS webhook (Supabase Edge Function) | **Live** on the `fortune-ai-hq` cloud project; three assistant numbers point at it | Signed probe 2026-10-26: unsigned or forged 403; unknown sender and STOP silent; registered sender "Got it" in 0.3 s; a Twilio retry is not answered twice |
| Adversarial review (172 agents) | **Done**; all 7 medium findings fixed | [`docs/research/review-2026-10-26.md`](docs/research/review-2026-10-26.md) |
| Shared record (Meterless World Model) | **Working** | Persists, replays, idempotent re-ingest |
| Assistant memory (Meterless H-MEM) | **Working** | Unapproved ideas never recalled as decisions; declined ideas flagged |
| Front door (Nemotron 3.5 Lightning, thinking off) | **Live-tested** | Routed correctly in 0.5–1.5 s |
| Plan writer (Nemotron 3 Ultra, thinking on) + number validator | **Live-tested on sample metrics** | Passed validation on the first attempt in 82 s; every run recorded in [`docs/research/live-runs-2026-10-26.md`](docs/research/live-runs-2026-10-26.md). The validator proves numbers are traceable, not that assumptions are wise; people approve. |
| Cloudflare Code Mode over the brain MCP server | **Working** | QuickJS sandbox: no network, files or timers; deadline, memory and tool-call caps; one `code` call answers a multi-tool script |
| Full chain request → plans → forward → decision | **Working** with models and data **mocked** | End-to-end test on the real local database and the real Meterless engines |
| Business numbers through Zetaris | **Working** on local Zetaris | Three source databases federated into one governed view with data-quality rules; `npm run zetaris:setup` proves the live answer equals an independent computation (33 of 33 metrics, both periods) |
| Admin console (owner only, read-only) | **Working** against the cloud project | Tabs for Owner HQ, Finance, Online Customer Service and a Salon (Cindy) placeholder; loopback only, numbers masked, codes redacted; 24 tests |
| Proposal PDF, printing, SMS sender | **Built** | 9 tests; printing is skipped unless a PrintNode printer is configured |

## Quickstart (WSL / Linux, Node 24, Docker)

```bash
npm install
bash scripts/setup-meterless.sh        # pinned Meterless engines → .local/meterless
cp .env.example .env.local && chmod 600 .env.local   # fill in NEMOTRON_API_KEY etc.
npm run db:start                        # local Supabase (applies migrations + synthetic seed)
npm test                                # unit, real-database and end-to-end tests
npm run zetaris:setup                   # Zetaris sources, views and the proof (needs local Zetaris)
npx tsx scripts/try-live-plans.ts       # LIVE Nemotron routing + plans on LIVE Zetaris metrics
npm run console                         # the owner's read-only Admin console (127.0.0.1:5180)
npm run worker -- --once                # drain the queue once (dry-run SMS without Twilio)
npx tsx packages/codemode/src/serve.ts  # the brain MCP server behind Code Mode (stdio)
```

Connect the brain to Claude Code: `claude mcp add fortune-brain -- npx tsx packages/codemode/src/serve.ts`.
Cursor, Codex and Gemini CLI use the same command as a stdio MCP server.

## Safety rules (each has a test)

- **Synthetic data only.**
- **The webhook never calls a model.**
- **Each task runs once.**
- **Approvals only by code:** codes are single-use, hashed, tied to one person and one proposal, and expire
  in 15 minutes; five wrong tries lock them; a plain "yes" never counts.
- **No numbers without a source.**
- **Memory holds only what a person decided.**
- **Model-written code runs only in the sandbox.**
- **Spending caps:** a daily model-token cap per worker process that fails closed (not yet shared across
  restarts).
- **Honest receipts for every step.**

## Pre-existing components (declared)

- **Meterless open engines** (Apache-2.0), fetched at a pinned commit, not copied.
- **The idea** of the owner's existing internal platform. **No code, schema or data** from it is in this
  repository.
