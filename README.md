# Fortune AI Headquarters

**A company brain and AI assistants for a family-run wig business: a salon and an online store, kept
separate.** Every AI tool reads the same brain through one MCP door. Assistants propose; people decide
with one-time codes. Built for the Open Agent Hackathon 2026, Track 02: "The Agent That Can Explain
Why".

> All data here is synthetic. No customer, staff or family records and no production credentials.

## The flagship workflow

The owner texts Joey, his CEO assistant (Owner HQ): *"Get me three plans to double profit this month."*
1. The SMS webhook stores the task once and answers "working on it" in about a second.
2. An **NVIDIA Nemotron** safety screen and the Nemotron Lightning front door read the text together;
   nothing acts on a text the screen did not pass.
3. **Finance, Online and the Salon propose at once**, each from its own slice of the numbers, read through
   **Zetaris**, a federated view over separately owned salon, online and marketing sources. Each recalls its
   own decisions and adopted lessons from **Meterless H-MEM** and asks **Nemotron 3 Ultra** for three plans.
4. A validator rejects any plan whose numbers don't trace to a Zetaris metric, a computed projection, or
   a declared proposed setting.
5. **Joey picks the final three** and says why; it can rank plans but never change a number.
6. The owner forwards one plan with `SEND <n> <code>`, and the finance owner answers `CONFIRM <code>` or
   `DECLINE <code>`.
7. Everything is recorded in the **Meterless World Model**. "Why plan 2?" is answered from that graph: who
   asked, which department proposed it, the metrics it cited, who decided.
8. Questions to any department run through **Cloudflare Code Mode**: one script over that assistant's
   read-only tools, in a sandbox. The **HQ Manager** reviews every assistant's work and the reports outside AI
   tools filed (`REVIEW`, and once a day) and recommends at most three changes to an assistant's profile in
   Supabase. Every one waits for the owner's one-time code (`ADOPT`) and then becomes a new, reversible version.

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
| Departments propose together; Joey picks three; explain why | **Working** with models **mocked** | Round, pick, number checks, retries and the World Model links tested on the real local database and Meterless; not yet run live end to end |
| Ask any department; department heads ask their own | **Working** | Each answers through Code Mode on its own read tools; the salon is a stand-in on synthetic data |
| Code Mode savings | **Measured live**, 8 runs | 73–88% fewer tokens than classic tool calling every run; answers less reliable with this small model (clean 5 of 15 reasoning off, 4 of 6 on, against 20 of 21): [summary](docs/research/codemode-savings-summary-2026-10-27.md) |
| HQ Manager: work reports, `REVIEW`, `ADOPT`, lessons | **Working** with models **mocked** | Review numbers traced to the digest; every change (a lesson, a skill note, read tools, a model) waits for the owner's code and becomes a profile version he made; a daily review at 09:00 ET; lessons reach the plan writers and every Code Mode answer |
| Safety screen (Nemotron 3.5 content safety) | **Built**, fails closed | Every free text screened before any model acts; long texts screened in windows |
| Business numbers through Zetaris | **Working** on local Zetaris | Three source databases federated into one governed view with data-quality rules; `npm run zetaris:setup` proves the live answer equals an independent computation (33 of 33 metrics, both periods) |
| Admin console (owner only, read-only) | **Working** against the cloud project | Tabs for Divisions (digest, briefs, data requests), Joey (Owner HQ), Finance, Online Customer Service, the HQ Manager and the Salon stand-in; loopback only, numbers masked, codes redacted |
| Proposal PDF, printing, SMS sender | **Built** | 9 tests; printing is skipped unless a PrintNode printer is configured |

## What runs where

| The owner texts | NVIDIA Nemotron | Zetaris | Meterless | Code Mode | Supabase |
|---|---|---|---|---|---|
| any free text | 3.5 content safety screens it; Lightning routes it | | | | the task, stored once |
| "Get me three plans to double profit this month" | 3 Ultra writes each department's plans, then picks three | each department's slice of the metrics | H-MEM: each department's decisions and lessons; World Model: the proposal and its links | | mailbox requests, the round task, the `SEND` code |
| "How is the salon doing?" (any department) | Lightning writes the script (reasoning on) and the reply | the metrics the script reads | H-MEM and World Model reads | one script over that department's read tools | receipts, work report |
| "Why plan 2?" | Lightning | | World Model graph (`explain_proposal`) | the lookup | approvals (status only) |
| `SEND` / `CONFIRM` / `DECLINE` | none | | the decision, in Finance's memory and the proposing department's | | single-use codes |
| `REVIEW` / `ADOPT` | Lightning reviews (reasoning on) | | lessons into H-MEM | the digest of work reports | reviews, recommendations, the `ADOPT` code |

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
npx tsx packages/codemode/src/serve.ts --local  # the brain MCP server behind Code Mode (stdio), file profiles
```

Connect the brain to Claude Code: `claude mcp add fortune-brain -- npx tsx packages/codemode/src/serve.ts --local`.
Cursor, Codex and Gemini CLI use the same command as a stdio MCP server. To serve an assistant's stored profile and
let the tool file its end-of-work report, give it a door token instead of `--local` (see `docs/manager.md`).

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
