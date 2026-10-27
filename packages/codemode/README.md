# @fahq/codemode

**Owner: lane A (Claude).** Cloudflare Code Mode: QuickJS sandbox executor, the Code Mode runner the
worker uses, and the brain MCP server.

- **`createCodeModeRunner`** (`src/runner.ts`): a model writes one JavaScript function against an
  assistant's typed read API; the sandbox runs it with only those tools; only the small result goes on.
  A run in which no tool returned data is refused (a script that read nothing has typed its own numbers);
  the result carries `toolOutputs`, what each tool returned, so the worker can check against it.
  `writeAnswer` and `traceNumbers` (`src/answer.ts`) turn the result into a short reply and check its numbers
  (digits only: a number written in words is objected to). `untracedResultNumbers` lists the numbers in a
  result that no tool returned: arithmetic or typed in, it cannot tell which, so it flags and never proves.
  `toolLoopAnswer` (`src/tool-loop.ts`) is the classic tool-calling baseline the savings are measured against.
- **The brain MCP door** (`src/brain-mcp.ts`, `src/serve.ts`, `src/door.ts`, `src/door-client.ts`): one door per
  assistant. With a door token (`FAHQ_DOOR_TOKEN` or `--token-file`) it reads the assistant's stored profile from
  Supabase through `door_profile` with the public anon key; `--local` serves the file profiles offline. It offers
  only the reads that profile lists and the door can serve, serves the profile's skill as the `skill` prompt
  (naming only those tools), and has one write: `file_work_report`, the end-of-work log and suggested lessons for
  the HQ Manager. See "Profiles in the database" in [docs/manager.md](../../docs/manager.md).

See [docs/architecture.md](../../docs/architecture.md) and [docs/LANES.md](../../docs/LANES.md). Other lanes: do not edit this folder.
