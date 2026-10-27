# @fahq/codemode

**Owner: lane A (Claude).** Cloudflare Code Mode: QuickJS sandbox executor, the Code Mode runner the
worker uses, and the brain MCP server.

- **`createCodeModeRunner`** (`src/runner.ts`): a model writes one JavaScript function against an
  assistant's typed read API; the sandbox runs it with only those tools; only the small result goes on.
  `writeAnswer` and `traceNumbers` (`src/answer.ts`) turn the result into a short reply and check its numbers.
  `toolLoopAnswer` (`src/tool-loop.ts`) is the classic tool-calling baseline the savings are measured against.
- **The brain MCP door** (`src/brain-mcp.ts`, `src/serve.ts`): one door per assistant profile
  (`--profile owner|finance|online|salon|manager`). It offers only what that profile may read and serves
  the profile's skill as the `skill` prompt.

See [docs/architecture.md](../../docs/architecture.md) and [docs/LANES.md](../../docs/LANES.md). Other lanes: do not edit this folder.
