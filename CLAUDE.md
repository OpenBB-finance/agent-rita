Copilot agent for [OpenBB Workspace](https://pro.openbb.co). Hono + Bun + Vercel AI SDK + MCP.

For architecture, tool inventory, file layout, env vars, request flow, the MCP and citation protocols, and the test strategy, read [README.md](./README.md). This file is rules, conventions, and gotchas only.

## Commands

```bash
bun run dev:agent     # agent on :7777
bun run dev:mcp       # MCP server on :8787
bun run typecheck     # bunx tsc --noEmit — must be zero errors
bun run test          # bun test tests/ — must be all green before merge
```

Prefer `bun`

## Hard rules — thin harness

The agent owns: protocol round-trips, widget tier/parse, citation aggregation, system prompt, **state-bound capabilities** (SQL family on `pendingTables` + `artifactQueue`, workspace bridge ops on the vendored bridge contract). Stateless / heavy / cold-start capabilities live in the MCP server. New capability needs in-process state the workspace can't reach → it's an agent tool; otherwise add it to `mcp-server/`.

- **No content-based routing in the harness.** No `isStructured()`, no `if data looks like X then path A else path B`. Surface tools, let the model pick. Generic dispatch by tool source (in-process vs SSE round-trip vs MCP) is structural, not content-based.
- **Never open MCP connections from the agent.** The workspace owns MCP. The agent emits `executeAgentTool` SSE for external MCP tools, native `copilotFunctionCall { function: <command> }` for the 16 vendored workspace bridge ops, or runs locally (`search_widgets`, SQL family).
- **One `streamText` per iteration.** The outer `MAX_LOOPS=3` exists only for cache-resolved widget re-fetches without an HTTP round-trip — not for orchestration. (`streamText`, not `generateText`: the loop consumes `fullStream` so in-process tool chains stream progress live; a stalled call is bounded by `LLM_STREAM_TIMEOUT_MS`.)
- **Tools have `execute` only when the work is local + cheap, *or* state-bound to in-process data.** Today that's `search_widgets` (closure on `tieredWidgets` — primary/secondary/extra preserved for ranking) and the SQL family (closure on `pendingTables` + `artifactQueue`). Everything else (widget data, skill, workspace bridge ops, MCP-registered) has no `execute`.
- **Prepare, don't prescribe.** Ship widget rows into `pendingTables`; the model decides whether to call SQL, compute, or answer directly.

The only acceptable harness branching is `lastMessage.role === "tool"` dispatched by `toolMsg.function` (`get_widget_data` default, `get_skill_content`, `execute_agent_tool`).

## TypeScript

- `strict: true`, zero errors at all times. CI gates on this.
- No `any` unless unavoidable, and justify with a comment. Prefer `unknown` + type guards.
- `interface` for object shapes, `type` for unions/intersections.
- Wire types live in `src/protocol/types.ts`; MCP-result types in `src/mcp/results.ts`; ContentItem helpers in `mcp-server/src/lib/typed.ts`.

## Zod is the source of truth

- Every tool input is a Zod schema. Validate with `.parse()` — **never `as`**.
- Use `.describe()` on every field; the description is what the LLM sees.
- The MCP schema layer (`src/mcp/schema.ts`) handles `enum`, `anyOf`, `oneOf`, `null`, nested `object`, `array.items`, `nullable`, `const`. Extend it rather than collapsing into `z.unknown()`.

## Vercel AI SDK patterns

```ts
// Auto-execute tool — local + cheap, or state-bound to in-process data
const t = tool({ description, inputSchema, execute: async (args) => { ... } });

// Round-trip tool: omit execute → loop stops, harness emits SSE
const rt = tool({ description, inputSchema });
```

`stopWhen` includes one `hasToolCall(name)` per round-trip tool — `get_widget_data`, `get_skill_content`, every workspace bridge command name (when `generativeUiEnabled`), plus `mcpToolsResult.stopCondition` for external MCP tools, plus `stepCountIs(15)`.

Consume `result.fullStream` and emit live as parts arrive (`src/agent/loop.ts`):
- `text-delta` → buffer; flush+`messageChunk` on `text-end` (whole-segment, so `stripPlaceholderTags` can't be defeated by a tag split across deltas — token-level text streaming is intentionally deferred)
- `tool-call` → `reasoningStep` per call, carrying `{ tool_name, input }` (the eval trace runner reads this to attribute in-process calls)
- drain `artifactQueue` after every part (SQL family pushes synchronously from `execute`; MCP results push from `processMcpResult` on the next re-POST) — artifacts land right after the tool that produced them
- `abort`/`error` (or a thrown stream error) → ERROR `reasoningStep` + return
- after the stream drains, `await result.steps` / `result.totalUsage` / `result.text` for the round-trip dispatch (reads `lastStep` / `finalText`)

Tools never yield SSE directly. The `artifactQueue` is the single ordered side-channel.

## Decoration (`x-agentrita-*`)

Some data must ride along with an MCP call without the LLM seeing it. Two capabilities use this path: `execute_code` (`x-agentrita-conversation-id`, `x-agentrita-tables`) and the document-RAG tools `query_documents` / `list_documents` (`x-agentrita-conversation-id`, `x-agentrita-documents`). Three rules:

1. Inject into `parameters` in `src/agent/loop.ts` right before yielding `executeAgentTool`.
2. Read on the MCP side from the tool's args object.
3. **Any new internal-only key must start with `x-agentrita-`** — `src/mcp/schema.ts` strips that prefix from the model-facing schema. Without the prefix the model will see and hallucinate the field.

`execute_code` ships only the delta: `tablesShipped` tracks names already in the sandbox, persisted as `extra_state.compute_tables_shipped` and invalidated per-name by `setPendingTable` (`src/agent/pending-tables.ts`) whenever a `pendingTables` entry is overwritten. Daytona sandbox recreation (idle auto-stop) is detected one call late via the silent `sandbox_meta` result item: id mismatch → `tablesShipped` cleared → next call full-ships. The one failed call in between is expected — the model sees the Python error and retries. Every round-trip emission must carry the continuation `extra_state` (`buildContinuationExtraState` in `src/agent/loop.ts`); an emission that drops those keys silently wipes the delta state mid-turn.

The SQL family lives in-process on the agent and reads `pendingTables` directly — no decoration, no wire payload.

## Conventions

- AsyncGenerators for SSE — every response path yields `SSEEvent` objects, never writes directly.
- LogTape: agent uses `["app", ...]`, MCP server uses `["mcp", ...]`. A single grep on `conversationId` traces a request across both processes.
- No classes. Pure functions and interfaces only.
- Request-scoped state goes in tool factories: `makeSearchWidgetsTool(allWidgets)`, `makeSqlTools({pendingTables, artifactQueue})`, `makeMcpTools(agentTools)`, `makeRetryTracker()`. Stateless tool factories (`makeWidgetDataTool`, `makeGetSkillContentTool`, `makeWorkspaceTools`) follow the same convention for consistency and testability.
- MCP server tool files export `<name>Schema`, `<name>Description`, `<name>Handler` and register in `mcp-server/src/server.ts`.
- Use the existing `singleShotLlm` (`src/lib/llm.ts`) for any new `/generate/*` route — don't hand-roll a new `generateText` wrapper.

## Gotchas

- **`X-Trace-Id` is the conversation key.** Workspace sets it per chat; the agent threads it as `conversationId` into `execute_code` decoration. Missing → loop suppresses `execute_code` for that turn (SQL family is in-process and unaffected). Any code that needs per-chat state should derive from this, not invent its own ID.
- **MCP `content[]` arrives flattened.** Workspace's `useMcpExecutor.ts` JSON-stringifies the whole array into a single text item. `processMcpResult` recurses into array elements — preserve that when adding new typed-result kinds.
- **The model must see tool outcomes.** Artifacts ride the SSE side-channel, so `dispatchTyped` injects a delivery-ack line into the LLM message, and `buildMessages` renders every *earlier* `execute_agent_tool` result via `renderToolResultForHistory` (pure — no queue pushes, no `rememberRows`); the last tool message stays with `injectFromReboot`. When adding a typed-result kind, extend BOTH `dispatchTyped` and `renderToolResultForHistory`, or the model goes amnesiac about that kind and re-runs finished work.
- **`COMPUTE_PERMANENTLY_UNAVAILABLE`** in any prior message disables `execute_code` for the rest of the chat. Don't surface that string anywhere except the genuine "missing conversation id" path in `execute-code.ts`.
- **Workspace bridge ops are round-trips, one per turn.** The agent emits exactly ONE `copilotFunctionCall` SSE per turn — the first bridge call of the step (the browser executes each emission and re-POSTs immediately, so a second emission in the same turn would fork the conversation into duplicate continuations). When the model fires several bridge calls in one step, the remainder are QUEUED in `extra_state.pending_bridge_calls` and the loop drains them one-per-re-POST (before re-running the model) — NOT re-issued by the model, which it does not reliably do after firing them up front (2026-06-11: 19 `update_widget` calls, 1 executed, rest dropped, "I updated the widget" hallucinated). Mirror of `pending_widget_data_requests`; rides the same `extra_state` echo (FE `functionCallSchema` keeps it via `z.any()`). `buildMessages` renders EARLIER bridge results into history (like `execute_agent_tool`) so the final turn knows every queued mutation landed. Command names go over the wire verbatim — no legacy renames (the `update_widget` → `update_widget_in_dashboard` remap is gone; `round-trip.ts` still canonicalizes the old name when reading saved chat history). The browser runs the op via `useWorkspaceBridgeCommandHandler` (shared with the WS companion bridge) and re-POSTs a `{status, message, data}` tool result. Because they round-trip, bridge emissions MUST carry `buildContinuationExtraState` like every other round-trip. (The 16 ops are listed in `src/protocol/bridge-commands.ts`.)
- **SQL family runs in-process.** Tools have `execute` and read `pendingTables` from the factory closure. `create_artifact` pushes the artifact directly onto `artifactQueue` (loop drains after `generateText`). Don't try to ship `x-agentrita-tables` for these — that path is `execute_code`-only now.
- **SSRM widgets** (those with `metadata.schema`) take inline SQL via `input_args.query`. Don't try to pre-load their data into `pendingTables`; the round-trip handles it.
- **MCP factory filter.** `src/mcp/factory.ts` drops user-supplied MCP wrappers whose name collides with an agent-owned tool (SQL family + native helpers `enhance_prompt`/`_llm_think`/`create_table_from_text`/`create_html_artifact`/`create_app` + 16 bridge commands + bridge-mount extras `update_widget_layout`/`get_widget_data`/`get_skill_content` from `BRIDGE_MOUNT_EXTRA_NAMES`). If you add a new agent-owned tool, add its name to the filter so Path-B duplicates don't double-register.
- **A turn spans N POSTs, and telemetry has to follow it.** `extra_state.traceparent` (span context of the turn's FIRST request, echoed forward verbatim — never rewritten per-hop) and `extra_state.turn_usage` (token total across all requests) ride `buildContinuationExtraState` like every other continuation key. Drop them from an emission and the turn splits into disconnected traces with unrecoverable cost. Both are browser-echoed, so both are parsed defensively (`parseTraceparent`, `readTurnUsage` — null/zero, never throw). The turn span is ended in the loop's `finally`, because every round-trip exits through a `return`. Telemetry is a no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set; keep it that way — don't add span creation inside tool implementations, the AI SDK already emits `ai.toolCall` spans.
- **The prompt advertises only registered MCP tools.** `buildSystemPrompt` takes `mcpToolEntries` (the post-filter `makeMcpTools(...).entries`) — never list raw `request.tools` in the prompt. A prompt/registration mismatch makes the model call ghost tools (it sees a name+description with no schema, invents args, gets `NoSuchToolError`, and may then hallucinate success).

## When adding a capability

1. **Stateless / heavy / cold-start (web search, fetch, mermaid, sandbox-backed): write a new MCP tool** in `mcp-server/src/tools/`. Export `Schema`/`Description`/`Handler`, register in `server.ts`. Use `typed.ts` helpers for artifacts/citations/tables.
2. **State-bound (operates on `pendingTables`, `artifactQueue`, or other request-scoped agent state): add an agent tool** under `src/agent/tools/` with an `execute` that closes over the context. Match the `make<Name>Tool(ctx)` factory pattern.
3. **New workspace bridge op:** extend `src/protocol/bridge-commands.ts` (Zod schema + description + name in `WORKSPACE_BRIDGE_COMMANDS`). The factory + loop dispatch picks it up generically.
4. Update [README.md](./README.md) tool table when adding/removing tools.
