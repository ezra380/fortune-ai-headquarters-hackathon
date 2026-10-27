# Fortune AI Headquarters: written explanation (rule 6.4)

The text submitted with the project, copied from the final submission pack. Primary track 01, also 03 and 02.
All data is synthetic. Setup, usage, tests and the live and mock table are in the [README](../../README.md).

## Project description

Fortune Wigs is one family company that is really two businesses: a salon in Brooklyn and Lakewood, owned by Ezra's parents, and an online wig store, owned by Ezra. Their numbers live in a dozen separate systems, and the two businesses' money must never be merged. Ezra wanted one place that tells him exactly what he needs to know to run the company and make profitable decisions.

Fortune AI Headquarters runs it like an enterprise, in four divisions. Each has an AI manager and a human head who decides: Salon (Cindy, for Esther), Finance (George, for Alan), Online (Georgette, for Emma), and HQ, where Joey is Ezra's CEO assistant. Zetaris federates 21 synthetic sources into four governed division marts; each manager sees only its own. Fifteen daily workers watch ads, marketplaces, email, messages, stock, returns, repairs and appointments; 13 have data connected so far. Each Monday the managers send a weekly PDF report; George adds a goal of the week and three profit paths, each with arithmetic, a test and a stop-loss. Managers ask each other for numbers they may not read. A head approves with a one-time code, never a plain yes. Joey sends Ezra one short digest, written by a program. An HQ Manager reviews everyone's work, keeps each assistant's versioned profile in Supabase, and applies lessons by itself only when no outside report is involved. Staff AI tools reach a profile through a token-locked MCP door. A Legal Team rates contract clauses green, yellow or red.

Why it is different: the model writes words, never a status. Every number must trace to the data it came from, or it goes back once, then falls back to a rule-written version that says so. Salon and online money are never added. Memory treats only a person's decision as fact, and "why" is answered from a recorded graph. Nothing moves money or messages a customer. Nemotron runs through Meterless Nightshift; only the safety screen calls NVIDIA directly. All data is synthetic.

## Sponsor technology

```text
ZETARIS
Zetaris is the only way the build reads business numbers. Twenty-one synthetic sources, from salon appointments to Amazon sales and supplier invoices, sit in seven Lightning databases. Three Zetaris views compute period totals, derived metrics (MER, budget room, seasonality with window functions) and standing items. Four Virtual Data Marts give each division only its own metrics, with no copy of the data. Each source has one planted bad row that must be rejected.
How: packages/data reads one division's mart; scripts/zetaris-setup.ts --v2 builds and checks it. Every metric carries its mart table and a SHA-256 hash of the view and query.
Proof: on the first 12 sources, --verify-only matched 145 of 145 comparisons with an independent computation; on all 21, each division's read matched too (590 values, 0 mismatches).

METERLESS
Engines implemented: World Model and H-MEM, fetched at a pinned commit (scripts/setup-meterless.sh).
World Model (packages/brain/src/record.ts): the shared record of who asked, who proposed what, which metrics it cited, and who approved. explainProposal answers "Why plan 2?" from that graph alone. Tests: brain.test.ts "records request → proposal → decision, persists, and replays without duplicates"; links.test.ts "gives the request and who asked it, every cited metric, and each decision with its plan rank".
H-MEM (packages/brain/src/memory.ts): a model's proposal is short-term and unapproved; only a person's decision becomes long-term. Tests: brain.test.ts "never recalls an unapproved proposal as a decision, and recalls a decision once made".
Nightshift is our primary AI provider, and the deployed worker runs on it: MODEL_PROVIDER=meterless, GUARD_PROVIDER=nvidia. Every model call but the safety screen goes through Nightshift, which holds the NVIDIA key; scripts/nightshift-bridge.mjs links the WSL worker to it. Tests: models.test.ts, "Nightshift (the Meterless Runtime) as the provider". Live: Lightning answered in about 2 s, Ultra in about 5 s; a wrong token got 401. The token is never printed.

NVIDIA NEMOTRON
Nemotron 3.5 Lightning, reasoning off: the front door, reading intent in 0.5 to 0.8 s (direct, Oct 26). It also writes Code Mode scripts, answers and the HQ Manager's review.
Nemotron 3 Ultra, reasoning on: three plans per division, Joey's pick of three, daily briefs, worker and weekly reports. With reasoning off it failed our number check twice on every prompt.
Nemotron 3.5 Content Safety: screens every free text first and fails closed. Nightshift does not serve it, so it alone calls NVIDIA directly.

CLOUDFLARE CODE MODE
packages/codemode: a question becomes one model-written script over the assistant's read tools, run in a QuickJS sandbox with no network. Live: 73 to 88% fewer tokens, but fewer clean answers (4 of 6 with reasoning on, against 20 of 21 for a tool loop). So every number in a reply must trace.

CURSOR
Not used.

WHAT WAS UNIQUE
Sponsor tech carries the trust. Zetaris hashes prove where each number came from, and its marts keep two businesses apart. The World Model explains why from the record. H-MEM never treats a model's idea as a decision. Nemotron writes words; programs set statuses and check numbers; only a person's one-time code turns a proposal into a decision. The Legal Team's texts may not carry a figure or citation that is not in the facts. The merged build passes 1,641 tests (87 files, 0 failed).
```

## Tracks

- **Primary: 01 Solving Fragmented Intelligence.** 21 separately owned sources, federated by Zetaris into four governed
  division marts; salon and online money never merged; managers ask the division that owns what they lack.
- **Also: 03 Reasoning Architecture.** The model never sets a status, H-MEM keeps only decisions, numbers must trace,
  and only a person's one-time code turns a proposal into a decision.
- **Also: 02 The Agent That Can Explain Why.** "Why plan 2?" is answered from the World Model record, with every cited
  metric and who decided.

## Pre-existing parts (declared)

See the README's "Pre-existing components" section: the Meterless open engines (Apache-2.0, fetched at a pinned commit),
the repository's first 12 commits (the owner's own starter work), and the idea of the owner's existing platform, with no
code, schema or data from it.
