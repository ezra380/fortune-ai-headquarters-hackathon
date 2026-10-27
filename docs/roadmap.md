# Roadmap: from the hackathon build to the company's headquarters

The hackathon build shows the pattern on synthetic data. This file is the owner's picture of the real thing
(agreed 2026-10-26) and what each step needs. Nothing here runs yet unless the "Built now" column says so.

## The idea

Fragmented data is the problem: every system knows one slice of the business. Each assistant becomes an
expert on one department's data and pays attention to the small details there. A chief of staff over them
asks every department for its best ideas and hands the owner three, each with the evidence behind it.

```
                    Owner  ── texts ──  Owner HQ (chief of staff)
                                         ├─ HQ Manager (sub-manager: work reports, lessons, profiles)
                                         │
              ┌──────────── mailbox in Postgres (API, never texts) ────────────┐
          Finance Department        Salon Department          Online Department
          (finance owner)           (head stylist; Cindy)     (online staff)
```

- **Assistants talk through the API.** Requests, proposals, decisions and reports are typed rows in the
  mailbox. Texts only go between a person and their own assistant.
- **Reads cross departments through Code Mode.** An assistant writes one sandboxed script against another
  department's read-only functions and gets back only the few values it needs.
- **People decide.** The owner can see and ask any department. A decision in someone's field needs that
  person's one-time code: the finance owner decides money plans, the head stylist the salon's.

## Each department's data (production)

| Department | Data it centralizes | What it should notice | Built now (synthetic) |
|---|---|---|---|
| **Salon** (Cindy's backend) | Appointment book, salon customer history joined with online purchase history, repair tickets with costs and turnaround | Customers who spend a lot and come often; who to prioritize; who visits but never buys; who buys only during sales; who buys a little; what each repair costs and how fast repairs are done | Salon revenue, services, appointments and no-shows through Zetaris |
| **Finance** (the finance owner) | Factory invoices and the finance owner's own work; every marketing agent's daily spend report; store financials; seasonality across the salon and online year | Which months historically earn more or less, and how much room each channel has to spend this month | All salon and online metrics side by side through Zetaris; three checked plans per request |
| **Online** (the online staff's assistant) | Email and text timestamps (request to reply), phone-system texts that went unanswered, the email platform's journeys and segments, store sessions, landing pages, abandoned checkouts, inventory | Slow replies, buyers whose interest wasn't picked up, products customers want that are low on stock | Online revenue, orders, discounts, ads and email metrics through Zetaris |
| **HQ Manager** (under Owner HQ) | Every assistant's end-of-work report: steps, models, tokens, failures, suggestions | Patterns across assistants; changes to an assistant's instructions, settings or checks | Work reports in Postgres, reviews, recommendations, lessons adopted by code |

Every department can print a weekly report of its division (the printing path exists; a printer is
configured per department).

## How a request for plans flows

1. The owner texts: "Get me three plans to double profit this month."
2. Owner HQ asks Finance, Salon and Online at the same time. Each plans from its own data only, and a
   program checks every number against that department's data.
3. Owner HQ picks the strongest three and says why each was picked. The plans' numbers are never changed.
4. The owner forwards one with a code; the finance owner confirms or declines with a code.
5. The decision goes into the deciding department's memory and the finance department's.

## Guardrails that stay as the system grows

- **Agents propose; people approve.** When Finance sees room to spend more this month, it proposes a
  budget limit and the finance owner approves it by code; marketing agents then work inside that limit.
  Nothing raises spending, publishes, messages a customer or changes an ad on its own.
- **The manager drafts; the owner adopts.** Every AI tool that uses an assistant profile (Claude, ChatGPT,
  Gemini, staff accounts) sends its session log and suggested lessons to the HQ Manager. The manager files
  and groups them. A profile changes only after the owner adopts the change with a code, so one bad
  session can't rewrite an assistant.
- **The two businesses stay separate.** Zetaris analyzes salon and online data side by side without
  merging their databases. Joining salon customers with online customers needs a rule both businesses'
  owners agree on first.
- **Medical information is never used** to profile or target a customer.
- **Hosted model terms decide what data can be sent.** Real customer text goes only to a provider whose
  terms allow it, or to models run on the company's own hardware.

## Steps to production

1. **Profiles into Postgres.** Each assistant's skill, settings and adopted lessons become rows, read
   through the one MCP door by every AI tool; the HQ Manager is the only writer, and only after an adoption.
2. **One department at a time,** each with its own read-only data connections and its own tests:
   Finance first (money decisions are where checked numbers matter most), then Online, then Salon.
3. **Zetaris hosted,** with a read-only user per assistant instead of one administrator key.
4. **The assistants move into the company's existing internal platform** behind its sign-in and roles.
5. **Private models on owned hardware** for anything a hosted provider's terms don't allow.
