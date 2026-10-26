# Fortune AI Headquarters: written explanation (rule 6.4)

**Track 02: "The Agent That Can Explain Why."** DRAFT for the owner's review. Every number in this
file comes from a recorded run; nothing here is a forecast.

## The problem

Fortune Wigs is a family business with two separate businesses under one name: a salon (Brooklyn and
Lakewood) and an online store. Three people run it, and each one decides different things: the online
owner, the head stylist, and the finance owner. Their numbers live in separate systems and must stay
separate, because the two businesses have different owners and different profit.

Today an idea such as "run a 20% Mazali promotion" travels by phone call and memory. Nobody can later
answer *why* it was approved, which numbers it rested on, or whether it was already tried and declined.

## What we built

A company brain with an assistant per person, each reachable by text message on its own number.

1. The owner texts his assistant: *"Ask the finance assistant for three aggressive plans to double
   profit this month."* A Supabase Edge Function checks Twilio's signature, stores the text once and
   answers "Working on it" in about a second. No model runs inside the webhook.
2. A worker claims the task. **NVIDIA Nemotron 3.5 Lightning** (thinking off) routes it.
3. The finance assistant reads the business numbers through **Zetaris** (below), recalls what people
   decided before from **Meterless H-MEM**, and asks **NVIDIA Nemotron 3 Ultra** for three plans.
4. A validator rejects any plan whose numbers do not trace back: every evidence number must equal a
   Zetaris metric, every projection must equal metric × factor, every new choice (a price, a budget) is
   declared as a proposed setting, and salon and online numbers are never added together.
5. The owner forwards one plan with `SEND <n> <code>`; the finance owner answers `CONFIRM <code>` or
   `DECLINE <code>`. Codes are single-use, hashed, tied to one person and one proposal, and expire in
   15 minutes.
6. The **Meterless World Model** records the request, the numbers, the plans and the decision; the
   decision becomes long-term memory. That record is the answer to "why".
7. Every AI tool reads the same brain through one MCP server behind **Cloudflare Code Mode**: one typed
   `code` tool, run in a QuickJS sandbox with no network, files or timers.

An owner-only Admin console shows each department's tasks, mailbox, approvals, texts and memory, with
phone numbers masked and codes redacted.

## How we used Zetaris

- **Three separately owned sources, federated, not merged.** Salon bookings, online orders and marketing
  results are three Lightning REST databases (`FORTUNE_DEMO_SALON`, `FORTUNE_DEMO_ONLINE`,
  `FORTUNE_DEMO_MARKETING`). Each source keeps its own data; Zetaris joins them only at query time.
- **One governed view.** `fortune_hq.finance_metrics` turns the four source tables into 33 named
  metrics per period, each tagged salon or online. The assistant can read only this view.
- **Data-quality rules live in the view.** Invalid rows (a negative order, an unknown product line, a
  negative salon price) never reach a revenue number, and each business has a "rows rejected by data
  checks" metric, so the filter is visible rather than silent.
- **Proof, not trust.** The metric catalog is defined once and generates both the Zetaris SQL and an
  independent TypeScript computation. `npm run zetaris:setup` proves the live Zetaris answer equals the
  independent computation, metric by metric, for both periods (33 of 33 matched on 2026-10-26).
- **Provenance.** Every metric carries the view name and a SHA-256 hash of the view definition and the
  query. A plan cites metric ids; the PDF and the shared record show exactly which query produced them.

## How we used Meterless

- **World Model** (the shared record): people, assistants, requests, proposals, metrics and decisions
  as entities and relations, with provenance on every write and a replayable event log.
- **H-MEM** (each assistant's memory): a model's proposal is stored as short-term and "unapproved"; only
  a person's decision becomes long-term memory. Planning recalls decisions only, so an unapproved idea is
  never treated as a fact, and a plan that repeats a declined idea is flagged.
- The engines are Meterless's open reference engines (Apache-2.0), fetched at a pinned commit at setup,
  not copied into this repository.

## Where NVIDIA contributes

- **Nemotron 3 Ultra** writes the three plans (thinking on).
- **Nemotron 3.5 Lightning** is the front door that routes each text (thinking off, about a second).

## How it was built

Built with Claude Code. Cursor was planned for the console but was not used; Gemini CLI did
documentation research. Tests: unit, real-Postgres and end-to-end (90 passing at this draft).

## What is unique

- Two businesses that must never blend their numbers, enforced in three places: the Zetaris view tags
  every metric, the validator refuses salon + online sums, and plans name which business they touch.
- An agent that cannot invent a number: every figure in a plan traces to a Zetaris metric, a computed
  projection, or a declared proposed setting.
- Approvals by people, by code, by text message; the agents propose, never act.

## Pre-existing parts (declared)

- Meterless open reference engines (Apache-2.0), fetched at a pinned commit.
- The idea of the owner's existing internal platform. No code, schema or data from it is in this
  repository. All data is synthetic.
