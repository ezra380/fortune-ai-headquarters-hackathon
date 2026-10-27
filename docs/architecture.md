# Fortune AI Headquarters — Architecture

Status: **foundation built** (branch `hq/foundation`, Oct 26–27, 2026; 524 tests). This file is the
source of truth for every agent working in this repository. Lane ownership is in [`LANES.md`](LANES.md).
Live vs mock status is recorded in the README; nothing here claims a component works until its tests pass.
Where this is headed: [`roadmap.md`](roadmap.md).

## 1. What it is

A company brain and a team of AI assistants for a family-run wig business with two separate businesses: a
salon and an online store. Each department has its own assistant: **Owner HQ** (the owner's), **Finance**,
**Online** and the **Salon** (a stand-in for the head stylist's own assistant, on synthetic data). The **HQ
Manager** sits under Owner HQ: it reads what every assistant did and recommends changes. Assistants **pass
proposals, never orders**, and a person decides every consequential step with a one-time code. Every AI tool
(Claude, Cursor, Codex, Gemini, ChatGPT) reads the same brain through **one MCP door**. Cloudflare's **Code
Mode** turns reads into one sandboxed script instead of many model round trips, inside the worker as well as
at the door.

All data in this repository is **synthetic**. No customer, staff or family records, and no production
credentials, are ever used here.

## 2. The flagship workflow (Track 02: "The Agent That Can Explain Why")

1. The owner texts Owner HQ: *"Get me three plans to double profit this month."*
2. A Supabase Edge Function verifies the Twilio signature, stores the task once (keyed by `MessageSid`) and
   answers "Working on it" within about a second. **No model runs inside the webhook.**
3. The worker claims the task (lease + `SKIP LOCKED`, renewed while it works). A **safety screen**
   (`nemotron-3.5-content-safety`, fails closed) and the **front door** (Nemotron Lightning) start together;
   the front door's answer is used only if the screen says safe. It reads intent (plans, question, status)
   and the target department.
4. **The departments propose together.** Owner HQ posts one request to Finance, Online and the Salon through
   the mailbox, and one round task collects them (`apps/worker/src/rounds.ts`). Each department:
   - reads only its own slice of the metrics from **Zetaris**, a federated, read-only view over separately
     owned sources (salon book, online orders, marketing spend). Salon and online are never merged;
   - recalls its own past decisions and adopted lessons from its **Meterless H-MEM** memory;
   - asks **Nemotron 3 Ultra** for three plans, as strict JSON.
5. **Every number is checked**, per department and again on the final set:
   - Evidence numbers must equal the Zetaris metric they cite; projections must equal `metric × factor`.
   - No sentence mixes a salon number and an online number.
   - Plans that contradict an approved memory are flagged.
6. **Owner HQ picks three** (`synthesis.ts`): one model call ranks the departments' plans and writes a reason
   for each; it can reorder plans but never change a number, and its reasons pass the same checks. If it
   fails twice, a fixed rule picks instead, and the text says so.
7. The final proposal is recorded in the **Meterless World Model** with a link to the department each plan
   came from, rendered as a PDF, printed if a printer is configured, and summarized by text.
8. The owner replies `SEND 2 <code>`. The finance owner gets plan 2 and replies `CONFIRM <code>` or
   `DECLINE <code>`. The decision is remembered by Finance and by the department the plan came from.
   **Nothing moves money, messages a customer or changes an ad.**
9. **Explain why.** "Why plan 2?" is answered from the World Model graph (`explain_proposal`): who asked,
   which department proposed it, why it was picked, the metrics it cited with their Zetaris view and query
   hash, and who decided. Never a code or a phone number.

## 3. Assistants: profiles, Code Mode, the mailbox and who decides

- **Profiles** (`packages/profiles`). Each assistant has one `SKILL.md` (its job and its read-only rules), a
  model for each job (route, plan, code, answer, review) and a fixed list of read tools. No assistant has a
  write tool: proposals, reports and reviews are fixed code paths in the worker.
- **Code Mode inside the worker** (`packages/codemode`). A question to any department is a Code Mode lookup:
  the model writes one script against that profile's typed read API, the QuickJS sandbox runs it, and only
  the small result goes back. A second call words the answer; its numbers are traced to the result, with one
  correction round, and otherwise the person gets the facts as they are. Live runs: 73–88% fewer tokens than
  classic tool calling, but less reliable answers with this small model
  ([summary](research/codemode-savings-summary-2026-10-27.md)).
- **Assistants talk through the API, never by text.** A request, a proposal, a report or a decision between
  assistants is a typed row in the Supabase mailbox, keyed so a retry never duplicates it. Texts go only
  between a person and their own assistant's number. One department reading another's numbers does so
  through its own read tools, never by asking the other assistant.
- **Who decides.** The owner can ask any department anything ("ask the salon how Tuesdays went"). A
  department head asks only her own assistant, on her own data. A decision in someone's field needs that
  person's code: a plan for Finance is confirmed by the finance owner, not the owner.
- **The HQ Manager** ([`manager.md`](manager.md)). Every finished task leaves a work report (steps, models,
  tokens, rule-based suggestions), and the reports outside AI tools file at a door are read too. `REVIEW` (and a
  daily job) asks the manager to read them through Code Mode and recommend at most three typed changes (a lesson, a
  skill note, a change to what an assistant may read, a change of model). Every one waits for the owner, who
  approves it with `ADOPT <n> <code>`, and then becomes a new version of the assistant's profile in Supabase
  (reversible from the history). A program table decides who applies each kind; today it names no one but the owner,
  and the mechanism for the manager applying a lesson or a note by itself stays in the code, off, until Ezra
  approves it in writing. The database is the source of the lessons; H-MEM is a cache of them.

## 4. Components

| Component | Path | Sponsor / tech | Lane |
|---|---|---|---|
| Shared contracts (schemas, ports, number validator) | `packages/contracts` | zod | A (Claude) |
| Queue, mailbox, approvals, outbox, receipts | `supabase/migrations` | Supabase Postgres + RLS | A |
| SMS webhook (ack + enqueue) | `supabase/functions/inbound` | Supabase Edge Functions, Twilio | A |
| Shared record + per-assistant memory | `packages/brain` | **Meterless World Model + H-MEM** | A |
| Model clients, budget caps, receipts | `packages/models` | **NVIDIA Nemotron** (Ultra, Lightning); optional xAI Grok reviewer | A |
| Code Mode: sandbox executor, the worker's script runner, brain MCP server | `packages/codemode` | **Cloudflare `@cloudflare/codemode`**, MCP SDK, QuickJS (WASM) | A |
| Assistant profiles: one read-only skill, models per job, read tools | `packages/profiles` | — | A |
| Assistant runtime: claim loops, safety screen, front door, department rounds, Owner HQ's pick, questions, HQ Manager | `apps/worker` | **NVIDIA Nemotron** content safety | A |
| Synthetic business data, local source APIs, Zetaris setup, Zetaris adapter | `packages/data` | **Zetaris** (REST tables, views, Virtual Data Mart, data-quality rule) | B (Cursor) |
| Admin console (owner-only, one sub-tab per department) | `apps/console` | Reads the brain over MCP; queue tables server-side | B (Cursor), after data |
| PDF, printing, SMS sender | `packages/delivery` | pdf-lib, PrintNode (optional), Twilio REST | A (Claude) |
| Submission write-up and deck outline | `docs/submission` | — | A (Claude) |

## 5. Where state lives

| Kind of state | Owner | Notes |
|---|---|---|
| Tasks, mailbox, approvals, outbox, receipts | Supabase Postgres | RLS on every table; the worker uses a server-side key; one task per `idempotency_key` |
| Shared record (who asked what, what was proposed and decided, which metrics were cited) | Meterless World Model, namespace `fortune-demo` | Append-only events, single writer, nothing deleted |
| Each assistant's lessons and decisions | Meterless H-MEM, one folder per assistant (`.local/memory/<assistant>`) | Proposals stay short-term; only decisions become long-term |
| Business numbers | The sources themselves, read through Zetaris | Read-only; every metric carries its query hash |
| Secrets | `.env.local` (mode 600), Supabase secrets | Never in git, logs, receipts or prompts |

## 6. Invariants (each has a test)

1. **Synthetic only.** Every record ID starts with `demo-`. No production credentials anywhere.
2. **The webhook is fast and dumb.** Valid Twilio signature or 403. Unknown sender gets a refusal and no
   task. A duplicate `MessageSid` makes one task. It never calls a model.
3. **Each task runs once.** Claimed with a lease and `SKIP LOCKED`, at most 3 attempts, then `failed` with
   a reason. The lease is short (5 minutes, so a task a dead worker left is tried again inside an approval
   code's 15 minutes) and the worker renews it every minute while it handles the task (`extend_lease`, which
   only the holder can call). Every claim loop is its own worker id (`<worker>#<n>`), so a loop that lost its
   lease cannot finish or renew a task another loop took. Twilio's own keywords (STOP, CANCEL, START, HELP and
   the rest) are left to Twilio and never become a task; an unused approval code simply expires.
4. **Proposals, never orders.** Only a person's code turns a proposal into a decision. A code is 4+
   digits, hashed, single-use, bound to that person and that proposal, and expires after 15 minutes. A
   plain "yes" never confirms.
5. **No action on the world.** The outbox sends only to registered people. Nothing charges, publishes,
   messages a customer or changes an ad.
6. **No invented numbers.** Evidence must match the metric it cites; projections must equal
   `metric × factor`; no claim mixes salon and online (a plan's own words, and the reasons and note Owner HQ
   writes about picked plans, pass the same sentence rule: each number belongs to the business of the metric
   it traces to). On failure the task fails with the reason. No silent fallback model.
7. **Memory holds only what a person decided.**
8. **Model-written code runs only in the sandbox.** No network, no files, no timers. Time and memory
   limits. Only the brain tools passed in are reachable.
9. **Honest receipts.** Every step records run, assistant, model, data source, timing, cost and
   live/mock.
10. **Spending caps** per task and per day, enforced before the call.
11. **A safety screen in front of every free text.** No router, plan writer or answer model acts on a text
    the screen did not call safe; a screen that cannot be reached counts as not safe. Commands with codes are
    parsed before any model and never reach one.
12. **Read-only assistants.** Every tool an assistant's script can call reads; each one blanks phone numbers
    and codes in what it returns.

## 7. Runtime topology

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

## 8. Departments and the Admin console

Each assistant is its own department, with its own text number, memory, mailbox and app view:

| Department | Assistant | Number (in `.env.local`, never in git) |
|---|---|---|
| Joey (Owner HQ) | the owner's CEO assistant (id `owner`) | `TWILIO_FROM_OWNER_ASSISTANT` |
| Finance Department | the finance owner's assistant (money decisions, marketing reports) | `TWILIO_FROM_FINANCE_ASSISTANT` |
| Online Customer Service Department | the online customer-service manager | `TWILIO_FROM_ONLINE_ASSISTANT` |
| Salon Department | Cindy, the head stylist's existing assistant (separate app); here a stand-in on synthetic salon data | her own number |
| HQ Manager | under Owner HQ: reviews the other assistants' work | none: it reaches the owner through Owner HQ |

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
her app; only salon work crosses into the business brain. For the event the worker runs a **Salon stand-in**:
it proposes in rounds and answers the owner from the salon metrics only (`get_salon_metrics`), on synthetic
data. The console's Salon sub-tab reads that stand-in like any other department. A **Divisions** tab (first) shows the CEO
digest and, per division, its latest brief, where each action stands and the data requests the divisions sent each other
([divisions.md](divisions.md)).

## 9. Production path (planned, not built here)

- The four assistants (owner, salon, finance, online staff) move into the business's existing internal
  platform behind its existing sign-in and roles.
- Meterless World Model and H-MEM contracts get implemented on that platform's Postgres, proven by
  Meterless's conformance suites.
- Zetaris gets hosted.
- Private models can run on owned hardware for sensitive data.
- None of that is in this repository. Only the concept carries over: no business code, schema or data.
