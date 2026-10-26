# Fortune AI Headquarters — Architecture

Status: **foundation under construction** (branch `hq/foundation`, Oct 26–27, 2026). This file is the
source of truth for every agent working in this repository. Lane ownership is in [`LANES.md`](LANES.md).
Live vs mock status is recorded in the README; nothing here claims a component works until its tests pass.

## 1. What it is

A company brain and a team of AI assistants for a family-run wig business with two separate businesses: a
salon and an online store. Three owners each get an assistant: the online owner, the head stylist and the
finance owner. Assistants **pass proposals, never orders**, and a person decides every consequential step
with a one-time code. Every AI tool (Claude, Cursor, Codex, Gemini, ChatGPT) reads the same brain through
**one MCP door**. Cloudflare's **Code Mode** turns that door into a single typed `code` tool, so an agent
can do many lookups in one sandboxed script instead of many model round trips.

All data in this repository is **synthetic**. No customer, staff or family records, and no production
credentials, are ever used here.

## 2. The flagship workflow (Track 02: "The Agent That Can Explain Why")

1. The owner texts his assistant: *"Ask the finance assistant for three aggressive plans to double profit
   this month."*
2. A Supabase Edge Function verifies the Twilio signature, stores the task once (keyed by `MessageSid`) and
   answers "Working on it" within about a second. **No model runs inside the webhook.**
3. The worker claims the task (lease + `SKIP LOCKED`). The **front door** (Nemotron Lightning, shaped like
   Meterless Scout) classifies intent, risk and target assistant. Anything that touches money, customers or
   ads needs an **execution contract** signed by a person.
4. The owner's assistant sends a **request** to the finance assistant through the mailbox.
5. The finance assistant:
   - pulls metrics from **Zetaris**, a federated, read-only view over separately owned sources (salon book,
     online orders, marketing spend). Salon and online are joined for analysis, never merged into one store;
   - recalls past decisions from its own **Meterless H-MEM** memory;
   - asks **Nemotron 3 Ultra** for exactly three plans, as strict JSON.
6. **Every number is checked.**
   - Evidence numbers must equal the Zetaris metric they cite.
   - Projections must equal `metric × factor`.
   - A single claim may not mix salon and online numbers.
   - Plans that contradict an approved memory are flagged.
7. The proposal is recorded in the **Meterless World Model** (the shared record), rendered as a PDF,
   printed if a printer is configured, and summarized by text.
8. The owner replies `SEND 2 <code>`. The finance owner gets plan 2 and replies `CONFIRM <code>` or
   `DECLINE <code>`. The decision is recorded and promoted to long-term memory. **Nothing moves money,
   messages a customer or changes an ad.**

## 3. Components

| Component | Path | Sponsor / tech | Lane |
|---|---|---|---|
| Shared contracts (schemas, ports, number validator) | `packages/contracts` | zod | A (Claude) |
| Queue, mailbox, approvals, outbox, receipts | `supabase/migrations` | Supabase Postgres + RLS | A |
| SMS webhook (ack + enqueue) | `supabase/functions/inbound` | Supabase Edge Functions, Twilio | A |
| Shared record + per-assistant memory | `packages/brain` | **Meterless World Model + H-MEM** | A |
| Model clients, budget caps, receipts | `packages/models` | **NVIDIA Nemotron** (Ultra, Lightning); optional xAI Grok reviewer | A |
| Code Mode: sandbox executor + brain MCP server | `packages/codemode` | **Cloudflare `@cloudflare/codemode`**, MCP SDK, QuickJS (WASM) | A |
| Assistant runtime: claim loop, front door, handlers | `apps/worker` | — | A |
| Synthetic business data, local source APIs, Zetaris setup, Zetaris adapter | `packages/data` | **Zetaris** (REST tables, views, Virtual Data Mart, data-quality rule) | B (Cursor) |
| Admin console (owner-only, one sub-tab per department) | `apps/console` | Reads the brain over MCP; queue tables server-side | B (Cursor), after data |
| PDF, printing, SMS sender | `packages/delivery` | pdf-lib, PrintNode (optional), Twilio REST | A (Claude) |
| Submission write-up and deck outline | `docs/submission` | — | A (Claude) |

## 4. Where state lives

| Kind of state | Owner | Notes |
|---|---|---|
| Tasks, mailbox, approvals, outbox, receipts | Supabase Postgres | RLS on every table; the worker uses a server-side key; one task per `idempotency_key` |
| Shared record (who asked what, what was proposed and decided, which metrics were cited) | Meterless World Model, namespace `fortune-demo` | Append-only events, single writer, nothing deleted |
| Each assistant's lessons and decisions | Meterless H-MEM, one folder per assistant (`.local/memory/<assistant>`) | Proposals stay short-term; only decisions become long-term |
| Business numbers | The sources themselves, read through Zetaris | Read-only; every metric carries its query hash |
| Secrets | `.env.local` (mode 600), Supabase secrets | Never in git, logs, receipts or prompts |

## 5. Invariants (each has a test)

1. **Synthetic only.** Every record ID starts with `demo-`. No production credentials anywhere.
2. **The webhook is fast and dumb.** Valid Twilio signature or 403. Unknown sender gets a refusal and no
   task. A duplicate `MessageSid` makes one task. It never calls a model.
3. **Each task runs once.** Claimed with a lease and `SKIP LOCKED`, at most 3 attempts, then `failed` with
   a reason. `CANCEL` works.
4. **Proposals, never orders.** Only a person's code turns a proposal into a decision. A code is 4+
   digits, hashed, single-use, bound to that person and that proposal, and expires after 15 minutes. A
   plain "yes" never confirms.
5. **No action on the world.** The outbox sends only to registered people. Nothing charges, publishes,
   messages a customer or changes an ad.
6. **No invented numbers.** Evidence must match the metric it cites; projections must equal
   `metric × factor`; no claim mixes salon and online. On failure the task fails with the reason. No
   silent fallback model.
7. **Memory holds only what a person decided.**
8. **Model-written code runs only in the sandbox.** No network, no files, no timers. Time and memory
   limits. Only the brain tools passed in are reachable.
9. **Honest receipts.** Every step records run, assistant, model, data source, timing, cost and
   live/mock.
10. **Spending caps** per task and per day, enforced before the call.

## 6. Runtime topology

- **Development:** Supabase local stack (Docker, via the `supabase` CLI) on the same machine as Zetaris
  (Docker) and the worker (Node 24, WSL).
- **Live SMS:** a Supabase cloud project hosts the `inbound` Edge Function. Two Twilio numbers point at it.
  The worker connects outbound to that project.
- **The worker runs on the owner's machine for the event,** because Zetaris and the memory files are local.
  Production moves it to an always-on host.
- **MCP door:** stdio for local agents (Claude Code, Cursor, Gemini CLI, Codex CLI); an HTTP endpoint is
  the production path for ChatGPT and staff accounts.
- **Code Mode:** `codeMcpServer` from `@cloudflare/codemode/mcp` wraps the brain MCP server into one
  `code` tool. Code runs in a QuickJS WebAssembly sandbox implementing Code Mode's `Executor`
  interface. On Cloudflare, `DynamicWorkerExecutor` (Worker Loader) replaces it with no other change.

## 7. Departments and the Admin console

Each assistant is its own department, with its own text number, memory, mailbox and app view:

| Department | Assistant | Number (in `.env.local`, never in git) |
|---|---|---|
| Owner HQ | the owner's head assistant / manager | `TWILIO_FROM_OWNER_ASSISTANT` |
| Finance Department | the finance owner's assistant (money decisions, marketing reports) | `TWILIO_FROM_FINANCE_ASSISTANT` |
| Online Customer Service Department | the online customer-service manager | `TWILIO_FROM_ONLINE_ASSISTANT` |
| Salon Department | Cindy, the head stylist's existing assistant (separate app) | her own number |

Every text gets an immediate acknowledgement from the webhook; the assistant's real work runs afterwards
and replies when it is done.

**The Admin console** (`apps/console`) is the owner's backend for all of them: one **Admin** tab with a
sub-tab per department. Each sub-tab shows:
- the assistant's tasks;
- its mailbox (requests, proposals, decisions);
- approvals (status only, never codes);
- outbox (with codes blanked);
- receipts (step, model, data source, outcome, time);
- the decisions in its memory;
- its slice of the shared record.

It is read-only and owner-only (localhost for the event; behind the platform's admin role in production).
Phone numbers show only their last four digits.

The **Salon Department** sub-tab is reserved for Cindy, which is a separate, already-running app. In
production it mirrors Cindy's own backend (her memory, her salon actions, her personal-to-business
hand-offs) at the same admin level, with the head stylist's knowledge. Her family and personal data stay in
her app; only salon work crosses into the business brain. For the event it is a labeled placeholder.

## 8. Production path (planned, not built here)

- The four assistants (owner, salon, finance, online staff) move into the business's existing internal
  platform behind its existing sign-in and roles.
- Meterless World Model and H-MEM contracts get implemented on that platform's Postgres, proven by
  Meterless's conformance suites.
- Zetaris gets hosted.
- Private models can run on owned hardware for sensitive data.
- None of that is in this repository. Only the concept carries over: no business code, schema or data.
