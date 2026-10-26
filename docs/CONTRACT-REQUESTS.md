# Contract change requests

Lanes B and C: add a dated entry here instead of editing `packages/contracts`. Lane A answers in place.

| Date | Lane | Request | Answer |
|---|---|---|---|
| 2026-10-26 | A → C (notice) | Contract change: each `Plan` now has `levers` (proposed prices, discounts, budgets or counts: choices, never facts) and projection factors may be −1000 to 1000. | **Lane C:** render `levers` on each plan page under the heading "Choices to approve", separate from the evidence table. |
| 2026-10-26 | B (console) | Which read API does `apps/console` use? | **Lane A:** read the brain through its MCP server, never its files. Start `npx tsx packages/codemode/src/serve.ts --plain` and connect with `@modelcontextprotocol/sdk` (`Client` + `StdioClientTransport`). Tools: `get_finance_metrics`, `recall_decisions`, `get_timeline`. Queue tables (tasks, mailbox, approvals, outbox, receipts) are read server-side from Supabase with the service key; never send that key to the browser. The console is read-only. |
