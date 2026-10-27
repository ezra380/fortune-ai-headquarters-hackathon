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

Settings: `GUARD_MODEL` (default `nvidia/nemotron-3.5-content-safety`), `GUARD=off` turns the screen off.
It is not wired into the worker yet.

Live check on this key, 2026-10-26 evening: `nvidia/nemotron-3.5-content-safety` answered `User Safety: safe` / `unsafe` in
0.3 to 4.9 s and was read correctly (the unsafe sample came back without categories). `nvidia/llama-3.1-nemotron-safety-guard-8b-v3`
did not answer within 20 to 60 s in four tries and so failed closed; set `GUARD_MODEL` to the content-safety model until it answers again.
