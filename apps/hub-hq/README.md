# Fortune HQ board (the owner's view inside the operations hub)

This is the **Fortune HQ** tab shown in the demo video. It runs inside the owner's private operations hub (a React + Vite
app on Netlify), so the files here are a copy of exactly the board's part of that app, not a runnable app on their own.
Addresses are replaced with `example.com`; the hub's own sign-in and helpers (`_lib/auth.js` and the like) are not copied.

- `netlify/functions/hq-board.js` and `_lib/hqBoard*.js`: the server side. It answers only the signed-in owner (the hub's
  session, an admin, and an allowlist `HQ_BOARD_USERS`), reads this repository's Supabase database through
  `FORTUNE_HQ_DB_URL` in one READ ONLY transaction, blanks six-digit codes, and never selects tokens or code hashes.
- The database login it uses is a dedicated role, `hq_board_reader`: read-only by default, `select` on the board's
  tables only, row-level-security policies for that role only, and no access to `door_tokens`, `inbound_texts`,
  `approvals.code_hash` or `session_reports.token_id` (refused live, 2026-10-27).
- `src/pages/FortuneHQ.jsx`, `src/components/hq/*`, `src/fortune-hq.css`: the board. One tab per desk (Joey, George,
  Georgette, Cindy, the HQ Manager, the Legal Team): the manager's profile, work running now, every worker's latest
  report with its last seven days, the weekly report, what is about to go out, what went out, memory and the mailbox.
  It refreshes every 20 seconds.
- `docs/fortune-hq-board.md`: the contract between the two. `test/`: the hub's tests for the gate and the page.

Next, as planned: a login per division, so each head sees only their own desk (the server's division filter is one
parameter away).
