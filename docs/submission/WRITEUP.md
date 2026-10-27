# Fortune AI Headquarters: written explanation (rule 6.4)

**Track 01: Solving Fragmented Intelligence.** DRAFT for the owner's review. Every number in this file comes from a
recorded run or a test in this repository; a number marked [run] is filled in from the live run before submission.
All data is synthetic.

## The problem

Fortune Wigs is a family company that is really two businesses under one name: a salon (Brooklyn and Lakewood) and an
online wig store. Their numbers are scattered across a dozen systems: the online store's orders, the salon's bookings,
email marketing, Google, Meta, Amazon and Walmart ads and sales, the support inbox (email, texts, chat), repair and
personalization tickets, supplier invoices, inventory and the website. Each person who runs a part of the company sees
one or two of them. Nobody sees the whole, and the two businesses' money must never be blended, because they have
different owners.

So the owner can't answer simple questions without a week of calls: Is everything running normally? Where is money
leaking? What should each part of the company do this week?

## What we built

The company is organized like an enterprise, in four divisions, each with an AI manager and a human head:

| Division | Manager | Head | What its manager watches |
|---|---|---|---|
| Finance | George | Alan | the whole marketing fleet (email, Google, Meta, Amazon, Walmart) and both businesses' money, kept apart |
| Online | Georgette | Emma | messages and reply speed, the store journey, stock, returns and reviews, site speed and content |
| Salon | Cindy | Esther | clients and their segments, repair and personalization turnaround, appointments |
| HQ / CEO | Owner HQ | Ezra | one line per division: running normally, or where to look |

1. **One governed picture, without copying the data.** Zetaris federates every source where it lives, applies
   data-quality rules inside the views, and serves four Virtual Data Marts, one per division (below).
2. **Daily workers.** Each manager has recurring workers, one per segment of the job ([run] workers in all). Each
   morning a worker reads only its division's mart. A program sets its status (normal, watch or act) from fixed
   attention rules, and NVIDIA Nemotron writes the headline and findings. Any number that does not trace back to
   the data is refused.
3. **Managers ask each other.** When George needs client segments, he asks Cindy; when Georgette needs Amazon and
   Walmart stock to plan restocking, she asks George. Each request is a typed mailbox row, and the answering
   manager pulls the numbers with its own tools. A division's mart simply does not hold what it must ask for.
4. **Weekly reports.** Every Monday each manager writes a thorough report from the workers' reports. George's report
   ends with a profit goal of the week and three paths, each with evidence, a test and a stop-loss, checked by the
   same validator as every plan. The report goes to the head's phone, printer and email, as an on-brand PDF.
5. **People decide by code.** A head approves a path or an action with `APPROVE <n> <code>`. Codes are single-use,
   hashed, tied to one person and expire. The agents never act on a live system.
6. **The CEO digest.** Each morning the owner gets one short text: one line per division, "running normally" or
   "needs a look", with no detail he doesn't need.
7. **The HQ Manager** reviews every assistant's end-of-work report, and outside AI tools' reports too. It keeps
   the assistants' profiles in Supabase and recommends changes; the owner adopts them by code.
8. **Doors for any AI tool.** Claude Code, Cursor, Codex or Gemini can call a division's profile through a read-only
   MCP door behind Cloudflare Code Mode, with a token per profile, and file their work report back.

## How we used Zetaris

- **[run] separately owned sources, federated and not merged.** Store orders, salon appointments, marketing (email,
  Google, Meta, Amazon, Walmart), the support inbox, repair and personalization tickets, supplier invoices,
  inventory, product lines, reviews and the site each live in their own Lightning REST database. Zetaris joins
  them only at query time.
- **Three layers of governed views.** Period totals over 13 months, derived numbers (budget room, revenue per ad
  dollar, the seasonal index against last year) and standing numbers as of the data date (open repairs, overdue
  invoices, messages waiting over a day).
- **Four Virtual Data Marts, one per division.** Each one is generated from the metric catalog's routing. Salon
  never reads an online number, and Online never a salon one; a test proves it on every layer.
- **Data-quality rules live in the views.** Every source has its rules and a visible rejected-rows count.
- **Proof, not trust.** The catalog is defined once and generates both the Zetaris SQL and an independent TypeScript
  computation. Setup proves the live answer equals the independent one, metric by metric, in every period
  ([run] comparisons, 0 mismatches).
- **Provenance.** Every number carries its mart table and a SHA-256 hash of the view bodies and the query.

## How we used Meterless

- **World Model:** the shared record of requests, data requests between divisions, proposals, metrics and decisions,
  with provenance.
- **H-MEM:** each manager's memory. Only a person's decision becomes long-term memory, so an idea nobody approved is
  never treated as fact.
- **Nightshift (Meterless Runtime):** [if installed] every Nemotron call goes through the runtime as the primary
  provider (`MODEL_PROVIDER=meterless`).

## Where NVIDIA contributes

- **Nemotron 3 Ultra** writes the weekly reports and the profit paths (thinking on).
- **Nemotron 3.5 Lightning** routes each text and writes the daily worker reports.
- **Nemotron 3.5 Content Safety** screens what people send.

## Cloudflare Code Mode: the measured trade-off

Code Mode cut tokens by 73–88% in 8 live runs. With the fast model, though, its answers were clean less often than
classic tool calling (5 of 15 with reasoning off, 4 of 6 with it on, against 20 of 21). So the worker now has the
script step reason first, and every number in an answer is still traced before anyone sees it.

## How it was built

Built with Claude Code, in parallel lanes on git worktrees, each lane reviewed by an independent reviewer before its
merge. Tests: unit, real-Postgres, live Zetaris proofs and end-to-end ([run] passing at submission).

## What is unique

- Fragmented data made whole **without merging two businesses that must stay apart**. That separation is enforced in
  three places: the marts, the validator and the reports.
- Managers that **ask each other** for what they don't own, instead of one agent that sees everything.
- **An agent that cannot invent a number**: every figure traces to a Zetaris metric, a computed projection or a
  declared proposed setting.
- **People decide, by code, by text**; the CEO gets one line per division.

## Pre-existing parts (declared)

- Meterless open reference engines (Apache-2.0), fetched at a pinned commit.
- The idea of the owner's existing operations hub. No code, schema or data from it is in this repository. All data
  is synthetic.
