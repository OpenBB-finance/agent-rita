# Agent Rita

**Agent Rita** is a custom copilot agent for [OpenBB Workspace](https://pro.openbb.co). It searches the widgets on your dashboards, fetches their data, runs SQL over that data in-process, builds and edits dashboards, and streams back cited answers — on its own, with no other services required.

<div align="center">
  <img src="https://openbb-cms.directus.app/assets/b0781163-9d61-4f1e-b510-519fdf845244" alt="Logo" width="600">
</div>

An **optional companion MCP server** (in [`mcp-server/`](./mcp-server)) adds capabilities the agent doesn't need to function: web search, web-page fetch, Mermaid diagrams, Python execution, and document RAG. Run the agent by itself and everything in the first paragraph still works; add the MCP server when you want those extras.

Built on Bun + Hono + the Vercel AI SDK + the Model Context Protocol.

> **Who this is for:** developers who want to run, fork, or study a small, production-shaped financial copilot. You need an OpenBB Workspace account ([free at pro.openbb.co](https://pro.openbb.co)) plus one LLM provider key (or a local Ollama) to run the agent. The MCP server is independent — it also works on its own with any MCP client, such as Claude Desktop.

## Contents

- [Quickstart](#quickstart) — get it running
- [Philosophy](#philosophy) — the thin-harness idea
- [Architecture](#architecture) — what the agent owns, what the MCP server owns, repo layout
- [How it works](#how-it-works) — request flow, result protocol, decoration, citations
- [Extending Rita](#extending-rita) — adding a capability
- [Testing](#testing) — the three tiers
- [Configuration](#configuration) — environment variables and endpoints
- [FAQ](#faq) — model selection, Docker + Ollama, common startup errors

## Quickstart

### Prerequisites

- [Bun](https://bun.sh) v1.x
- An [OpenBB Workspace](https://pro.openbb.co) account (free) — needed to use the agent from the Workspace UI
- At least one LLM provider key: `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, or `GROQ_API_KEY` — or a local [Ollama](https://ollama.com) endpoint via `OLLAMA_BASE_URL`
- Optional, only for the companion MCP server: `TAKO_API_TOKEN` (full Tako toolset; search/answer/coverage work keyless on the free tier), `TAVILY_API_KEY` (web search fallback when Tako is disabled), `DAYTONA_API_KEY` (Python execution), `OPENAI_API_KEY` (document-RAG embeddings)

### Run it

```bash
bun install
cp .env.example .env          # fill in at least one LLM provider key

bun run dev:agent             # agent only, on :7777 (this is all you need)
# or, to also run the companion MCP server:
bun run dev:all               # both servers, prefixed/colored logs, --kill-others
bun run dev:mcp               # MCP server only, on :8787

bun run typecheck             # bunx tsc --noEmit — must be zero errors
bun run test                  # bun test tests/
```

`bun run dev:agent` is the whole product for widget search, data fetching, SQL analysis, dashboard editing, and skills. The MCP server is additive.

If you run the MCP server and want Mermaid diagrams, install the Chromium it renders with:

```bash
bunx playwright install chromium   # mermaid_diagram is disabled if this is missing
```

### Connect it to OpenBB Workspace

In the Workspace settings (the connections/agents area), add Rita as a custom agent:

- **Custom agent** → `http://localhost:7777`. The Workspace reads the descriptor at `/agents.json` and sends queries to `/v1/query`.
- **MCP server** (optional) → `http://localhost:8787/mcp`. The Workspace lists the tools on connect and forwards them to the agent in each request.

> Because that list is read **once, on connect**, restarting the MCP server drops it: the Workspace then sends the agent an empty tool list and the model behaves as if it has no data sources, usually by saying so and declining to answer. Reconnect the server in the Workspace after a restart — and after changing any tool's description, since the cached copy is what the model reads.

If you only want the MCP server with a different client (Claude Desktop, say), skip the agent and point that client at `http://localhost:8787/mcp`. See [Path A vs Path B](#path-a-vs-path-b).

### Run it in a container

The published image runs the **agent only** (`src/server.ts`) on port `7777`:

```bash
docker build --target rita -t agent-rita .
docker run --rm -p 7777:7777 --env-file .env agent-rita
```

Images are published on every push to `main`:

```text
ghcr.io/openbb-finance/agent-rita:latest
ghcr.io/openbb-finance/agent-rita:main
ghcr.io/openbb-finance/agent-rita:main-<short-sha>
```

## Philosophy

Rita follows the **thin harness** principle: the model drives decisions, the code provides capabilities. Like opencode, Claude Code, and Codex, the harness is a capability broker and safety rail — not an orchestrator.

Two ideas drive the codebase:

1. **The model picks tools, not the harness.** No `if data looks like X then path A else path B` heuristics. Every tool sits in front of the model with a clear description, and the model chains them as it sees fit. The only branching the harness does is by *where a tool runs* (in-process vs. SSE round-trip vs. MCP), never by inspecting tool content.
2. **Capabilities live in MCP servers.** The agent is deliberately lean — it owns only what needs the OpenBB Copilot protocol or local request state. Web search, fetch, diagrams, Python execution, and document RAG all live in the reference MCP server. Adding a stateless capability is one new tool file there; the agent code is untouched.

Why structure it this way:

- **Feature velocity.** A new stateless capability is a new file in `mcp-server/src/tools/` — no agent edits, no system-prompt regression risk, no SSE-handling regression risk.
- **A small system prompt.** With MCP, the tool description sent at registration *is* the instruction. The prompt stays short and focused instead of growing a section per feature.
- **Customer extensibility.** Anyone can write their own MCP server and register it with the Workspace; Rita treats it as one more tool in the list and ranks it for relevance the same way it ranks widgets.
- **Industry alignment.** Thin core, capabilities over a standard extension mechanism — the pattern every serious agent is converging on.

The core boundary, stated once: **core = anything that operates on data the agent already holds** (the widget list, `pendingTables`, the citation aggregator) **plus protocol mechanics** (SSE events, the vendored bridge contract). **Everything else goes to MCP** — stateless, heavy, cold-start, or third-party — with no exceptions made for convenience.

## Architecture

```
Workspace ──POST /v1/query──▶ Agent
   ▲   ▲                       │
   │   │                       │ streamText loop (MAX_LOOPS=3)
   │   │                       ▼
   │   │             ┌─ search_widgets        → executes locally → loop continues
   │   │             ├─ SQL family            → executes locally (closure) → loop continues
   │   │             ├─ get_widget_data       → SSE → workspace fetches widget data
   │   │             ├─ get_skill_content     → SSE → workspace loads skill
   │   │             ├─ workspace bridge op   → native SSE copilotFunctionCall {function, input_arguments} → terminal
   │   │             ├─ external MCP tool     → SSE execute_agent_tool → workspace dispatches
   │   │             └─ text                  → SSE message + citations (terminal)
   │   │
   │   └─ Workspace re-POSTs with role:"tool" message containing data
   │
   └─ Workspace ◀── MCP server ◀── workspace.callTool(server_id, tool_name, parameters + decoration)
```

### What the agent owns

This is the agent's irreducible scope — all of it runs without the MCP server:

- Widget tier classification + `search_widgets`
- `get_widget_data` round-trip (including SSRM / Snowflake widgets)
- Widget data parsing (CSV / JSON / images / PDFs) → table schema
- `get_skill_content` round-trip
- **SQL family** (`execute_sql`, `peek_table`, `peek_column_values`, `create_artifact`) — in-process `bun:sqlite`, a closure over `pendingTables`
- **Native helpers** (`enhance_prompt`, `_llm_think`, `create_table_from_text`, `create_html_artifact`, `create_app`) — local and state-bound to `artifactQueue` / `pendingTables`. `create_app` validates each `(origin, widget_id)` against the live widget catalog and emits an `app` artifact (an apps.json template) the Workspace renders with open-as-dashboard / save-to-apps actions
- **Workspace bridge tools** (16 ops: `manage_dashboard`, `create_widget`, `update_widget`, `delete_widget`, `update_dashboard_layout`, `manage_navigation_bar`, `add_generative_widget`, `navigate_workspace`, `manage_apps`, `manage_backends`, `assign_tasks_to_agents`, `get_workspace_snapshot`, `list_available_widgets`, `get_widget_schema`, `read_widget`, `get_params_options`) — declared from the vendored bridge contract, emit native `copilotFunctionCall` SSE, dispatched by the Workspace browser bridge
- `execute_agent_tool` round-trip + typed-result handler (the bridge for any external MCP tool)
- `extra_state` preservation across re-POSTs
- Citation aggregation (widgets + MCP web/document)
- System prompt builder

### What the optional MCP server owns

Stateless / heavy / cold-start capabilities, exposed over Streamable HTTP MCP. None of these are required for the agent to run; each is gated on its own key and simply isn't registered when the key is absent.

| Tool | Backend | Notes |
|---|---|---|
| `tako_search` | Tako hosted MCP | Live data graph + web search; every source becomes a citation and each result's series loads as a SQL table the agent can query and chart. Keyless free tier; `TAKO_ENABLED=false` disables |
| `tako_answer` | Tako hosted MCP | Grounded prose answer to one data question, with citations |
| `tako_available_data` | Tako hosted MCP | Free coverage lookup for one entity/metric before searching |
| `tako_contents` | Tako hosted MCP | Rows behind a result URL become a SQL-queryable table; registered only with `TAKO_API_TOKEN` |
| `web_search` | Tavily | Registered only when `TAKO_ENABLED=false`; returns text + web citations via `$rita_kind` |
| `fetch_webpage` | Turndown | HTML → markdown, capped at 20 000 chars |
| `mermaid_diagram` | mermaid-isomorphic (Playwright Chromium) | Renders Mermaid to SVG server-side, returns an `html` artifact; registered only when the Chromium binary is installed |
| `execute_code` | Daytona Python sandbox | Per-conversation; gated by `DAYTONA_API_KEY` |
| `query_documents` | OpenAI embeddings + in-memory/Redis store | RAG search over uploaded docs; gated by `OPENAI_API_KEY` |
| `list_documents` | same store | Inventory of docs loaded in the conversation |

The compute family is **stateful per conversation** — the sandbox persists across calls in the same chat, and the agent ships only delta tables on each call.

### Repo layout

```
src/                           # Agent (port 7777) — the standalone product
├── server.ts                  # Hono entry
├── routes/
│   ├── agents.ts              # GET /agents.json
│   ├── status.ts              # GET /status
│   ├── query.ts               # POST /v1/query
│   └── generate/              # Auxiliary single-shot LLM endpoints
├── agent/
│   ├── loop.ts                # Single agentic loop, step walker, decoration step
│   ├── messages.ts
│   ├── prompt.ts
│   ├── round-trip.ts          # Re-POST data injection
│   ├── context.ts             # request.context split (tables vs text blocks)
│   ├── documents.ts           # uploaded-doc decode + RAG decoration
│   ├── file-docs.ts           # file-widget → RAG document bridge
│   ├── row-cache.ts           # cross-request widget row cache
│   ├── url-prefetch.ts        # eager URL prefetch
│   └── tools/
│       ├── search-widgets.ts
│       ├── widget-data.ts
│       ├── skills.ts
│       ├── workspace.ts       # makeWorkspaceTools — 16 native bridge ops
│       ├── native.ts          # hub: enhance_prompt, _llm_think, create_table_from_text, create_html_artifact
│       ├── enhance-prompt.ts
│       ├── think.ts
│       ├── table-from-text.ts
│       ├── html-artifact.ts
│       └── sql/               # execute_sql, peek_table, peek_column_values, create_artifact (in-process)
├── widgets/                   # tiers, parse, parse-as
├── sql/                       # loader (analyzeTable — type inference only)
├── mcp/                       # factory, schema, results, retry
├── protocol/                  # types, events, stream, extra-state, citations, bridge-commands
└── lib/                       # providers, llm, token-usage, logger

mcp-server/                    # Optional companion MCP server (port 8787)
└── src/
    ├── server.ts              # @modelcontextprotocol/sdk + @hono/mcp
    ├── lib/                   # typed.ts (ContentItem helpers), redis.ts, logger.ts
    ├── bridge/                # Path B bridge protocol (singleton, routes, state, validators)
    ├── prompts/               # MCP prompt definitions
    ├── resources/             # MCP resources (app-builder guides, etc.)
    └── tools/
        ├── backend/
        │   ├── web-search.ts
        │   ├── fetch-webpage.ts
        │   ├── mermaid.ts
        │   ├── documents/     # query_documents, list_documents + extract/chunk/retrieve/store
        │   └── compute/       # execute_code + sandbox/data-bridge/rita-helper
        └── workspace/         # Path B (Claude Desktop) wrappers around the bridge — filtered out for Rita

tests/                         # Tiers 1 + 2 (every PR, mocked LLM)
├── unit/                      # Pure-function + per-tool tests, mirrors src/ and mcp-server/ layout
├── integration/agent-loop/    # Loop-level scenarios with mocked LLM
├── helpers/                   # mock-llm, sse-reader, clear-state
└── fixtures/

evals/                         # Tier 3 (nightly, real LLM)
├── runner.ts                  # Orchestrator + summary report
├── trace.ts                   # Single-shot agent loop capture
├── cases/                     # widget-selection, tool-routing, sql-analysis, intent,
│                              # workspace-context, locale, citations, file-widgets,
│                              # mcp-routing, native-tools, skills, url-context
├── graders/                   # toolCalled, widgetIdInTopN, argContains, llmJudge, noBadState, ...
└── runs/<date>/               # Per-trial trace JSONs (gitignored)
```

### Tech stack

| Layer | Choice |
|---|---|
| Runtime | Bun |
| Package manager | bun |
| HTTP | Hono |
| AI SDK | Vercel AI SDK v6 (OpenAI, OpenRouter, Groq, Ollama) |
| MCP SDK (server) | `@modelcontextprotocol/sdk` + `@hono/mcp` |
| Compute backend | Daytona (`@daytonaio/sdk`) |
| Validation | Zod (everywhere) |
| In-process SQL | `bun:sqlite` (per-call, on the agent) |
| HTML → Markdown | Turndown |
| Logging | LogTape |

## How it works

### The agent never opens an MCP connection

The OpenBB Workspace is the only thing that speaks MCP. The agent just emits SSE events that say "please call this tool" and waits for the Workspace to re-POST the result — the same protocol every other Workspace MCP integration uses. There are three SSE function-call shapes the agent emits:

| Function | Used for | Frontend dispatcher |
|---|---|---|
| `get_widget_data` / `get_skill_content` | Bespoke agent paths with widget-tier resolution / skill payload | bespoke |
| `<command>` (one of the 16 vendored bridge commands) | Native workspace ops: `manage_dashboard`, `create_widget`, … | `useWorkspaceBridgeCommandHandler` |
| `execute_agent_tool` | Any external MCP tool (web search, fetch, mermaid, code sandbox, third-party MCPs) | `useMcpExecutor` |

(`useMcpExecutor` and `useWorkspaceBridgeCommandHandler` live in the OpenBB Workspace frontend, not in this repo.)

The flow for **external MCP tools**:

1. The Workspace boots, lists tools from each configured MCP server, and caches the descriptors.
2. The user sends a message. The Workspace POSTs `/v1/query` with `body.tools = [all currently connected MCP tools]`. (When no MCP server is connected, this list is empty and the agent runs on its own tools.)
3. The agent filters out any user-supplied MCP wrapper whose name collides with an agent-owned tool (the SQL family + the 16 bridge commands).
4. The agent registers each remaining tool as a no-execute `tool({...})`. The model picks one. The agent emits `copilotFunctionCall { function: "execute_agent_tool", input_arguments: { server_id, tool_name, parameters } }`.
5. The Workspace dispatches `mcpConnection.callTool(...)` to the right server and gets the result back.
6. The Workspace re-POSTs with a `role: "tool"` message containing the MCP `content[]`.
7. The agent's `processMcpResult` parses each item, pushes artifacts/citations into the queue, injects text into context, and resumes the loop.

**Workspace bridge ops** skip the MCP detour entirely: the agent emits `copilotFunctionCall { function: <command>, input_arguments: <bridge shape> }` and the Workspace frontend runs the operation directly in the browser. Same SSE surface as `get_widget_data` / `get_skill_content`.

This means the agent is **offline with respect to MCP**: zero outbound connections to any MCP server, no third-party API keys ever in the agent, and nothing to invalidate when a user toggles a server on or off — the next request simply carries a different tool list.

### Typed MCP result protocol

Standard MCP only carries text/image/resource content. Rita extends this without breaking compatibility: each text content item is either plain text **or** a JSON object with a `$rita_kind` discriminator.

```json
{ "$rita_kind": "artifact",     "artifact": { ... } }
{ "$rita_kind": "citation",     "citation": { "type": "web", "url": "...", "title": "..." } }
{ "$rita_kind": "sqlite_table", "name": "...", "rows": [...] }
```

Helpers in [`mcp-server/src/lib/typed.ts`](./mcp-server/src/lib/typed.ts): `textItem()`, `artifactItem()`, `webCitationItem()`, `documentCitationItem()`, `sqliteTableItem()`. Plain text (no `$rita_kind`) is injected as a normal message. A per-item discriminator — rather than a fixed outer envelope — lets one result mix kinds (text + citations + an artifact + a table) and lets plain-text or third-party tools work without any conformance.

### Decoration (`x-agentrita-*`)

Some agent-side data has to ride along with an MCP call without the LLM seeing it. Two capabilities use it — `execute_code` (Daytona-backed) and the document-RAG tools (`query_documents` / `list_documents`):

- `x-agentrita-conversation-id` — the Workspace's `X-Trace-Id`; keys the per-chat Daytona sandbox and the per-chat document store
- `x-agentrita-tables` — `{ [name]: rows[] }`, delta only; names already shipped (tracked in `extra_state.compute_tables_shipped`) are skipped. If the sandbox is recreated after idle auto-stop, it's detected one call late via a silent `sandbox_meta` result item, the shipped set is cleared, and the next call full-ships
- `x-agentrita-documents` — the delta of uploaded-doc bytes shipped to the document tools for ingest

The agent injects these into `parameters` just before emitting the SSE event; the Workspace forwards `parameters` byte-for-byte; the MCP-side tool reads them. The model never sees them — `src/mcp/schema.ts` strips any `x-agentrita-*` key from the model-facing schema, so **any new internal-only key must start with that prefix.** The SQL family needs no decoration — it runs in-process and reads `pendingTables` directly through its tool factory's closure.

### Citations

Citations come from **two sources**: widgets (whenever widget data is loaded) and MCP tools (any tool that returns a `$rita_kind: "citation"` item). The agent aggregates them into a single `Citation[]` per request and emits one `copilotCitationCollection` SSE event at end-of-turn.

Across multi-step round-trips the in-flight set is serialized into `extra_state.intermediate_citations` and restored on the next re-POST — persistence happens at **every** round-trip emit point, because each POST starts with fresh request-scoped state. Dedup keys (`widget|<uuid>|<sortedArgs>` for widgets, `web|<link>` for web/document) make the aggregation idempotent across reruns. Widget IDs are deterministic — a SHA-1 hash of `(widget.uuid, sortedInputArgs)` — so the same widget with the same args always gets the same citation ID.

One nuance: the Workspace recognizes `source_info.type` of `widget`, `web`, `artifact`, `direct retrieval`, and `findb`. Anything else (including `document`) renders nothing, so document citations from MCP are mapped to `web`.

### Path A vs Path B

The same bridge commands are reachable two ways, both terminating in the same browser handler:

| Path | Consumer | Surface | Where it lives |
|---|---|---|---|
| Path A | Agent Rita | Native SSE `copilotFunctionCall { function: <command>, input_arguments }` | `src/agent/tools/workspace.ts` + `src/protocol/bridge-commands.ts` |
| Path B | Claude Desktop, other MCP clients | Standard MCP `tools/call` with `_json` string args | `mcp-server/src/tools/workspace/*` (18 wrappers) |

Rita's `body.tools` filter drops the Path-B wrappers whenever it sees a name matching a vendored bridge command, so the model only ever sees one surface per capability. The Path-B wrappers are gated behind `COMPANION_TOOLS_ENABLED` (off by default).

## Extending Rita

Decide by where the work needs to run:

1. **Stateless / heavy / cold-start** (web search, fetch, a renderer, a sandbox-backed tool): **write a new MCP tool** in `mcp-server/src/tools/`. Export `<name>Schema` / `<name>Description` / `<name>Handler`, register it in `mcp-server/src/server.ts`, and use the `typed.ts` helpers for artifacts/citations/tables. The agent picks it up automatically — no agent code changes.
2. **State-bound** (operates on `pendingTables`, `artifactQueue`, or other request-scoped agent state): **add an agent tool** under `src/agent/tools/` with an `execute` that closes over the context, following the `make<Name>Tool(ctx)` factory pattern.
3. **A new workspace bridge op:** extend `src/protocol/bridge-commands.ts` (Zod schema + description + the name in `WORKSPACE_BRIDGE_COMMANDS`). The factory and loop dispatch pick it up generically.

Every tool input is a Zod schema, validated with `.parse()` — never a cast. Use `.describe()` on every field; that description is what the LLM sees. After adding or removing a tool, update the tool tables in this README. 

## Testing

Three tiers. The first two run on every PR with a mocked LLM and are fully deterministic; the third scores real model behavior nightly.

| Tier | What | When | LLM |
|---|---|---|---|
| 1 — Unit | Pure functions, MCP tool handlers, parsers, schema converters | Every PR | none |
| 2 — Integration | Drives `src/agent/loop.ts` and real routes/handlers; only the LLM is mocked (`MockLanguageModelV2`) | Every PR | mocked |
| 3 — Evals | Drives the real agent loop against a live LLM, scored by deterministic graders + LLM-as-judge | Nightly + pre-release | real |

```bash
bun run test        # Tiers 1 + 2 — gates every PR
bun run typecheck   # bunx tsc --noEmit — zero errors required
bun run evals       # Tier 3 — nightly + manual
```

The guiding rule is **test the result, not the reasoning.** Modern models reach the same outcome by different paths, so we assert on outputs — function returns, mutated context, the SSE events the Workspace receives, the terminal citation collection — never on which tool fired first or in what order. Behavioral questions ("does the model pick the right widget?") live in `evals/` with pass-rate thresholds across N trials; `tests/` pins contracts that hold regardless of which model runs. The mock LLM is a fixture to drive the loop into an observable state, never the system under test.

## Configuration

### Environment variables

**Agent (`src/`):**

```
OPENAI_API_KEY        # OpenAI models
OPENROUTER_API_KEY    # OpenRouter (Claude, Gemini, DeepSeek, etc.)
GROQ_API_KEY          # Groq models
OLLAMA_BASE_URL       # Ollama endpoint (default http://localhost:11434/api)
DEFAULT_MODEL         # Fallback model when a request omits one (default openai:gpt-4o)
PORT                  # Agent port (default 7777)
```

**Companion MCP server (`mcp-server/`):**

```
TAKO_API_TOKEN          # Optional — full Tako toolset + account limits (keyless = anonymous free tier)
TAKO_ENABLED            # Optional — "false" disables Tako and restores Tavily web_search
TAKO_MCP_URL            # Optional — override the Tako MCP endpoint (default https://mcp.tako.com/mcp)
TAVILY_API_KEY          # Used only when TAKO_ENABLED=false
OPENAI_API_KEY          # Required for query_documents / list_documents (embeddings); both unregistered without it
DAYTONA_API_KEY         # Required for execute_code (otherwise execute_code is unregistered)
COMPANION_TOOLS_ENABLED # "true" registers the 18 Path-B workspace bridge tools + prompts + app-builder resources (default false)
DAYTONA_API_URL         # Optional Daytona overrides
DAYTONA_TARGET
REDIS_URL               # Optional — persists the document-RAG store across restarts (in-memory if unset)
RITA_EMBED_MODEL        # Optional — override the OpenAI embedding model used for document RAG
MCP_PUBLIC_BASE_URL     # Optional — public base URL advertised to the bridge
MCP_BRIDGE_COMMAND_TIMEOUT_MS  # Optional — Path B bridge command timeout (ms)
MCP_PORT                # MCP server port (default 8787)
```

### Endpoints

**Agent:**
- `GET /agents.json` — agent descriptor (name, features, supported models)
- `GET /status` — health check
- `POST /v1/query` — main query endpoint (SSE)
- `POST /generate/*` — single-shot helpers (chat title, dashboard title, enhance prompt, widget info, code)

**MCP server:**
- `GET /` — server descriptor
- `ALL /mcp` — Streamable HTTP MCP transport

## FAQ

**The Workspace keeps using a different model than my `DEFAULT_MODEL`. Why?**
The model is resolved as **Workspace settings-wheel picker → `DEFAULT_MODEL` → `openai:gpt-4o`**. If you've picked a model in the chat's settings (the wheel icon), the Workspace sends it per request as `workspace_options.model`, and that **overrides** your `DEFAULT_MODEL` env. `DEFAULT_MODEL` only applies when no model is picked. The agent logs the source on every request — look for `model=… (via workspace_options.model | env.DEFAULT_MODEL | hardcoded-default)`.

**I changed the model in settings but the Workspace still sends the old one.**
The picked model is bound to the chat. Change it in the settings wheel, then **start a new chat** — existing chats keep the model they were created with. The Workspace also caches its agent config, so if it stays stuck, hard-refresh the browser tab.

**I edited `DEFAULT_MODEL` in `.env` but nothing changed.**
`bun run dev:agent` runs with `--hot`, which reloads **code, not environment variables**. Restart the server after editing `.env`. (And remember the Workspace picker still wins over `DEFAULT_MODEL` — see above.)

**Ollama works locally but not from the Docker container (connection refused).**
Inside a container, `localhost` is the container itself, not your host machine. Point `OLLAMA_BASE_URL` at `http://host.docker.internal:11434/api` instead of `http://localhost:11434/api`.

**Ollama errors immediately — a `Model error` in chat / a 404 on `/api/chat`.**
The agent advertises Ollama ids like `ollama:gpt-oss:20b`, `ollama:qwen3.5:9b`, `ollama:gemma4:e4b` — but the tag after `ollama:` must be a model you've **actually pulled**, matching exactly. If it isn't, Ollama 404s the chat request and the agent surfaces a `Model error`. Check what's installed with `ollama list` and pull the one you want (`ollama pull qwen3.5:9b`).

**Do I need the companion MCP server?**
No. The agent runs fully standalone — widget search, data, SQL, dashboards, and skills all work with `bun run dev:agent` alone. The MCP server only adds web search, fetch, diagrams, Python execution, and document RAG.

**Why does document RAG need `OPENAI_API_KEY` even when I run chat on another provider?**
Document RAG (`query_documents` / `list_documents`) lives on the companion MCP server and embeds your uploaded docs with OpenAI's `text-embedding-3-small` to build the per-conversation vector store. Embeddings are a separate model call from chat, and the embedding provider is currently hard-wired to OpenAI — so even if your chat model is Groq / OpenRouter / Ollama, doc RAG still needs an OpenAI key (embeddings are cheap: ~$0.02 per 1M tokens). Without the key those two tools are simply **not registered**; everything else (the core agent plus the rest of the MCP server) keeps working. `RITA_EMBED_MODEL` only swaps the OpenAI model id, not the provider.

**"No AI providers configured" on startup.**
Set at least one of `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, or `GROQ_API_KEY`, or point `OLLAMA_BASE_URL` at a running Ollama.

**Where did web_search go?**
Tako replaced Tavily as the default search: `tako_search` / `tako_answer` / `tako_available_data` register by default and work keyless on Tako's anonymous free tier, which is rate-limited per IP. Set `TAKO_API_TOKEN` for your own account limits and the full toolset, or `TAKO_ENABLED=false` (plus `TAVILY_API_KEY`) to restore the Tavily `web_search` tool.

**Should I also add mcp.tako.com directly in the Workspace?**
Not while the companion server is running. Both advertise the same tool names, and the agent's MCP factory de-duplicates by appending a suffix rather than dropping either one, so the model ends up seeing two near-identical tools (`tako_search` and `tako_search_2`) that it cannot tell apart. Nothing breaks, but the choice is arbitrary and you pay for whichever it picks. Use the companion server's built-in Tako tools (they add citations and SQL tables that a direct registration cannot), or connect Tako directly only if you run the agent without the companion server.
