# Lanes: who builds what, in parallel, in one repository

Three agents build at the same time. Each lane owns its own directories and its own branch, so nobody
overwrites anybody. **Never edit a directory owned by another lane, and never edit `packages/contracts`
unless you are lane A.** If you need a contract change, append it to `docs/CONTRACT-REQUESTS.md` and keep
going against the current contract.

Base branch: **`hq/foundation`**. Every lane branches from it and is merged back into it by lane A after
review (the builder never approves its own work).

| Lane | Agent | Branch | Runs where | Owns (may edit) |
|---|---|---|---|---|
| **A: Foundation** | Claude Code | `hq/foundation` | WSL, main checkout `~/fortune-ai-headquarters-hackathon` | `packages/contracts`, `packages/brain`, `packages/models`, `packages/codemode`, `packages/profiles`, `packages/delivery`, `apps/worker`, `supabase/`, `scripts/`, `docs/` (except `docs/research` written for A by D), root config |
| **B: Admin console** | Cursor (optional) | `hq/cursor-console` | WSL worktree `~/fahq-cursor` | `apps/console` only |
| **D: Reader** | Gemini CLI | none | WSL, read-only | writes only `docs/research/*.md` when asked by lane A |

*Oct 26: the Codex lane (C) was dropped; lane A took over `packages/delivery` and `docs/submission`.
Later the same evening lane A also took `packages/data` (Zetaris); Cursor keeps only the console.
Oct 26–27: lane A ran its own build lanes in WSL worktrees (`~/fahq-l1` … `~/fahq-pb1`), each a builder, a senior
review and one fix round, merged into `hq/foundation` by lane A.*

**Coordination:** Claude and Cursor talk through `~/fahq-shared/coordination.md`, an append-only log
outside both checkouts. Cursor posts READY-FOR-REVIEW with a commit hash after each green step; Claude
answers with REVIEW (GREEN / GREEN-WITH-NOTES / RED) and answers QUESTION and CONTRACT entries.

## Rules for every lane

- **Contracts are the API between lanes.** Import from `@fahq/contracts`. Never redefine a type that
  exists there.
- **Dependencies:** add them only to your own package's `package.json` (`npm install <pkg> -w
  packages/<yours>`). Never hand-edit `package-lock.json`. If it conflicts on merge, take the base version
  and run `npm install`.
- **Tests:** `npm test` must stay green; your package's tests live in `<package>/test/*.test.ts`. A mock is
  named `*.mock.ts` and labeled as a mock.
- **Commits:** small, often, with clear messages. Use WIP commits, never `git stash` (worktrees share one
  stash).
- **Never:** secrets in code or logs, real customer data, the live business systems, `git push --force`
  on `hq/foundation`, or edits outside your lane.

## Definition of done per lane

- **A:**
  - schema + RLS + `claim_task` + the `inbound` Edge Function, tested on the local Supabase;
  - brain wrappers (World Model events, H-MEM per assistant, promotion and conflict check);
  - Nemotron clients with caps and receipts;
  - the Code Mode executor + brain MCP server + `code` tool;
  - the worker: claim loop, front door, owner and finance handlers, approvals;
  - one end-to-end run on synthetic data.
- **B:**
  - `packages/data` implements `DataPort` from `@fahq/contracts`;
  - a synthetic generator for the salon book, online orders, marketing spend and email revenue;
  - a local read-only JSON API server for them;
  - idempotent Zetaris setup scripts (one Lightning database per source, REST tables, views, a Virtual
    Data Mart, `fortune_demo_finance_mart`, one data-quality rule);
  - an adapter that returns `Metric[]` with stable IDs and a query hash;
  - tests;
  - then `apps/console`: the owner-only **Admin console**, with one sub-tab per assistant department
    (see `docs/architecture.md` §8).
- **A (also):**
  - `packages/delivery` implements `DeliveryPort`: proposal PDF (pdf-lib), PrintNode printing (dry-run
    unless configured), and a Twilio SMS sender that refuses unregistered recipients and is idempotent per
    outbox item;
  - `docs/submission/`: write-up and deck outline following the event's rules 6.1–6.4.
