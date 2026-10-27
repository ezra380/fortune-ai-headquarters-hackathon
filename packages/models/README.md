# @fahq/models

**Owner: lane A (Claude).** NVIDIA Nemotron and optional xAI clients with caps and receipts (ModelPort).

See [docs/architecture.md](../../docs/architecture.md) and [docs/LANES.md](../../docs/LANES.md). Other lanes: do not edit this folder.

## Safety screen (`src/guard.ts`)

`screenText({ model, guardModel, text, timeoutMs? })` asks a small NVIDIA safety model whether a text is safe. It sends the
text alone (no system message, `noSystem: true`), at most 1,600 characters per call, 100 answer tokens, temperature 0, no
thinking switch, and reads either reply shape: `{"User Safety": "unsafe", "Safety Categories": "..."}` or `User Safety: unsafe`.

Text longer than 1,600 characters is read to its end, never cut: it goes out in overlapping 1,600-character windows (200
characters of overlap, so a phrase on an edge is whole in one window), up to five windows (7,200 characters), asked at the
same time. The text is safe only if **every** window comes back safe. Text over 7,200 characters is refused with the
reason "the text is too long to screen" and no model call; the caller must split it or decide what to do. A window of only
whitespace is not sent, and a text of only whitespace is safe without a call.

It **fails closed**: an HTTP error, a timeout (default 8 s per call), a refused budget, an unreadable reply, or a "safe" reply that
also names harm categories all come back as `safe: false` with the reason "the safety check could not run". It never throws.

Settings: `GUARD_MODEL` (default `nvidia/nemotron-3.5-content-safety`), `GUARD=off` turns the screen off,
`GUARD_PROVIDER` (`nvidia` or `meterless`; default: the same as `MODEL_PROVIDER`) chooses who serves the safety model.
The worker screens every free text with it (`apps/worker/src/screen.ts`).

## Through Nightshift (`MODEL_PROVIDER=meterless`)

Every call goes to the Meterless Runtime that Nightshift serves, which calls NVIDIA with the key set up inside it:
`METERLESS_BASE_URL` (default `127.0.0.1:8088`) and `METERLESS_TOKEN` or `METERLESS_TOKEN_FILE` (the runtime's
`proxy-token`). Live check 2026-10-27, from WSL: the router and plan models answered through it
(`nvidia/nemotron-3.5-lightning-30b-a3b` about 2 s, `nvidia/nemotron-3-ultra-550b-a55b` about 5 s); a wrong token gets 401.

- **The safety model is not served by it** (`model_not_found`: it serves only the models enabled in it), and the screen
  fails closed, so set `GUARD_PROVIDER=nvidia` (needs `NEMOTRON_API_KEY`): the screen then asks NVIDIA directly and every
  other call still goes through Nightshift. Measured the same day: safe and flagged samples read correctly in 1 to 1.6 s.
- **WSL cannot reach Windows loopback**, and Nightshift's hotspot mode opens only its phone desk (port 8089), not the API.
  `scripts/nightshift-bridge.mjs`, run with Windows' node, relays the WSL-facing adapter (`172.23.224.1:18088`) to
  `127.0.0.1:8088`; it binds that adapter only, never `0.0.0.0`, and the runtime's token is still required. Then
  `METERLESS_BASE_URL=172.23.224.1:18088`. Check with `npx tsx scripts/check-nightshift.ts`.

Live check on this key, 2026-10-26 evening: `nvidia/nemotron-3.5-content-safety` answered `User Safety: safe` / `unsafe` in
0.3 to 4.9 s and was read correctly (the unsafe sample came back without categories). `nvidia/llama-3.1-nemotron-safety-guard-8b-v3`
did not answer within 20 to 60 s in four tries and so failed closed; set `GUARD_MODEL` to the content-safety model until it answers again.
