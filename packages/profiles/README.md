# @fahq/profiles

**Owner: lane A (Claude).** The assistants as data: one profile per assistant (what it may read, which
model does which job, its memory folder) and one skill file per assistant in
[`skills/<id>/SKILL.md`](skills), in Claude Code skill format.

- Every assistant is **read-only**. Its reads are a fixed list of tool names; proposals and work reports
  are fixed worker code paths, never tools.
- The skill text is the same rules for every way in: it opens the Code Mode system prompt in the worker,
  and the MCP door serves it as the `skill` prompt to Claude Code, Cursor and Codex.
- `pickTools(all, profile)` hands a script exactly the profile's tools and throws on a missing name.

See [docs/architecture.md](../../docs/architecture.md) and [docs/LANES.md](../../docs/LANES.md).
