import {
  streamText,
  hasToolCall,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";
import type {
  AgentTool,
  Citation,
  CopilotArtifact,
  QueryRequest,
  SSEEvent,
  ToolMessage,
  Widget,
  WorkspaceState,
} from "../protocol/types";
import {
  citationCollection,
  executeAgentTool,
  getSkillContent,
  getWidgetData,
  getWidgetDataSsrm,
  messageChunk,
  promptSuggestions,
  reasoningStep,
  streamingMessageChunk,
  workspaceCommand,
} from "../protocol/events";
import { makeTextSink } from "./text-sink";
import { buildAllCitations, type CitedWidget } from "../protocol/citations";
import { applyParamOverrides, getSqlSchema, type TieredWidget } from "../widgets/tiers";
import { extractWidgetItems, type WidgetItem } from "../widgets/parse";
import { analyzeTable, sanitizeName, sanitizeRowKeys, type TableInfo } from "../sql/loader";
import { makeMcpTools, type McpToolsResult } from "../mcp/factory";
import { type McpCitation } from "../mcp/results";
import { readExtraState, COMPUTE_PERMANENTLY_UNAVAILABLE } from "../protocol/extra-state";
import { buildMessages } from "./messages";
import { injectFromReboot, injectWidgetData, type RoundTripContext } from "./round-trip";
import { getCachedRows } from "./row-cache";
import { setPendingTable } from "./pending-tables";
import {
  formatToolInputRejectedStatus,
  formatToolResultStatus,
  formatToolStartStatus,
  formatWidgetDataLoadedStatuses,
  formatWidgetDataRequestStatuses,
} from "./tool-status";
import { loadUploadedDocuments, buildDocumentsDecoration, type PendingDocument } from "./documents";
import { prefetchUrls, urlCitationId } from "./url-prefetch";
import { splitContext } from "./context";
import { makeSearchWidgetsTool } from "./tools/search-widgets";
import {
  makeWidgetDataTool,
  widgetDataSchema,
  type WidgetRequest,
} from "./tools/widget-data";
import { makeGetSkillContentTool, getSkillContentSchema } from "./tools/skills";
import { makeWorkspaceTools } from "./tools/workspace";
import {
  normalizeBridgeArgs,
  OPENBB_AI_SSE_BRIDGE_COMMANDS,
} from "../protocol/bridge-emit";
import { makeSqlTools } from "./tools/sql";
import { makeNativeTools } from "./tools/native";
import { makeSuggestionsTool } from "./tools/suggestions";
import { makeCreateAppTool } from "./tools/app-artifact";
import {
  flattenUsage,
  accumulateUsage,
  estimateCost,
} from "../lib/token-usage";
import { getLogger } from "../lib/logger";
import { PROVIDER_OPTIONS } from "../lib/providers";

const logger = getLogger(["app", "agent", "loop"]);

interface CachedWidget {
  items: WidgetItem[];
  timestamp: number;
}

const widgetDataCache = new Map<string, CachedWidget>();
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Cache key for the in-process widget data cache. Exported under the
 * `_` test-only convention so unit tests can pin the contract:
 * key-order-invariant on inputArgs, type-strict on values
 * (`"47" !== 47`), uuid-distinct.
 */
export function _widgetCacheKey(uuid: string, inputArgs?: Record<string, unknown>): string {
  const sortedArgs = inputArgs
    ? Object.keys(inputArgs).sort().reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = inputArgs[k];
        return acc;
      }, {})
    : {};
  return JSON.stringify({ uuid, args: sortedArgs });
}

const widgetCacheKey = _widgetCacheKey;

function getCachedItems(uuid: string, inputArgs?: Record<string, unknown>): WidgetItem[] | null {
  const key = widgetCacheKey(uuid, inputArgs);
  const cached = widgetDataCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
    widgetDataCache.delete(key);
    return null;
  }
  return cached.items;
}

function cacheWidgetItems(uuid: string, inputArgs: Record<string, unknown> | undefined, items: WidgetItem[]): void {
  const key = widgetCacheKey(uuid, inputArgs);
  widgetDataCache.set(key, { items, timestamp: Date.now() });
}

function artifactPayloads(events: SSEEvent[]): CopilotArtifact[] {
  return events
    .filter((event) => event.event === "copilotMessageArtifact")
    .map((event) => event.data as unknown as CopilotArtifact);
}

function shouldRenderDetailAsCode(details: string): boolean {
  return ["```sql\n", "```python\n", "```html\n", "```mermaid\n"].some((prefix) =>
    details.startsWith(prefix),
  );
}

type ResolvedWidgetFetch = {
  request: WidgetRequest;
  widget: Widget;
  cacheInputArgs: Record<string, unknown>;
  sql?: string;
};

function effectiveWidgetInputArgs(
  widget: Widget,
  inputArgs?: Record<string, unknown>,
): Record<string, unknown> {
  const resolved = inputArgs ? applyParamOverrides(widget, inputArgs) : widget;
  const args = Object.fromEntries(
    resolved.params.map((p) => [p.name, p.current_value ?? p.default_value]),
  );
  return {
    ...args,
    ...(inputArgs ?? {}),
  };
}

function buildDashboardNameByUuid(
  workspaceState: WorkspaceState | null,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const tab of workspaceState?.current_dashboard_info?.tabs ?? []) {
    for (const w of tab.widgets ?? []) {
      if (w.widget_uuid && w.name) map.set(w.widget_uuid, w.name);
    }
  }
  return map;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function enrichToolStatusInput(
  toolName: string,
  input: unknown,
  dashboardNameByUuid: Map<string, string>,
): unknown {
  if (toolName !== "update_widget_in_dashboard" || !isRecord(input)) return input;
  if (typeof input.widget_name === "string" && input.widget_name.trim()) return input;
  const widgetUuid = typeof input.widget_uuid === "string" ? input.widget_uuid : undefined;
  const widgetName = widgetUuid ? dashboardNameByUuid.get(widgetUuid) : undefined;
  return widgetName ? { ...input, widget_name: widgetName } : input;
}

function resolveWidgetFetches(
  requests: WidgetRequest[],
  allWidgets: Widget[],
  dashboardNameByUuid: Map<string, string>,
): { fetches: ResolvedWidgetFetch[]; unmatched: string[] } {
  const fetches: ResolvedWidgetFetch[] = [];
  const unmatched: string[] = [];

  for (const req of requests) {
    let widget: Widget | undefined = allWidgets.find(
      (w) => w.uuid === req.widget_uuid,
    );
    if (!widget) {
      // The prompt surfaces dashboard-cell widget_uuids from workspace_state,
      // which differ from the request.widgets ids (they share only the name).
      // When the model copies one, reconcile it to its request widget — but
      // only when the name resolves to exactly one widget; never guess.
      const dashboardName = dashboardNameByUuid.get(req.widget_uuid);
      if (dashboardName) {
        const byName = allWidgets.filter((w) => w.name === dashboardName);
        if (byName.length === 1) widget = byName[0];
      }
    }
    if (!widget) {
      unmatched.push(req.widget_uuid);
      continue;
    }

    const widgetUuid = widget.uuid ?? widget.widget_id;
    const inputArgs = req.input_args;
    const sqlQuery = inputArgs?.query as string | undefined;
    if (sqlQuery && getSqlSchema(widget)) {
      const cacheInputArgs = { query: sqlQuery };
      fetches.push({
        request: { widget_uuid: widgetUuid, input_args: cacheInputArgs },
        widget,
        cacheInputArgs,
        sql: sqlQuery,
      });
    } else {
      const baseWidget = inputArgs ? applyParamOverrides(widget, inputArgs) : widget;
      const knownParamNames = new Set(baseWidget.params.map((p) => p.name));
      const extraParams = inputArgs
        ? Object.entries(inputArgs)
            .filter(([name]) => !knownParamNames.has(name))
            .map(([name, value]) => ({
              name,
              type: typeof value,
              description: "",
              current_value: value,
            }))
        : [];
      const resolvedWidget = extraParams.length > 0
        ? { ...baseWidget, params: [...baseWidget.params, ...extraParams] }
        : baseWidget;
      const cacheInputArgs = effectiveWidgetInputArgs(widget, inputArgs);
      fetches.push({
        request: {
          widget_uuid: widgetUuid,
          ...(inputArgs ? { input_args: inputArgs } : {}),
        },
        widget: resolvedWidget,
        cacheInputArgs,
      });
    }
  }

  return { fetches, unmatched };
}

function logUnmatchedWidgets(
  unmatched: string[],
  allWidgets: Widget[],
): void {
  if (unmatched.length === 0) return;
  const sampleWidgetIds = allWidgets.slice(0, 5).map((w) => w.widget_id).join(", ");
  const fileWidgetNames = allWidgets
    .filter((w) => w.widget_id.startsWith("file-"))
    .map((w) => w.name);
  logger.warn(
    `Widget identifiers did not match any connected widget unmatched=[${unmatched.join(", ")}] totalAvailable=${allWidgets.length} fileWidgetNames=[${fileWidgetNames.join(" | ")}] sampleWidgetIds=[${sampleWidgetIds}]`,
    {
      unmatched,
      totalAvailable: allWidgets.length,
      fileWidgetNames,
      sampleWidgetIds: allWidgets.slice(0, 5).map((w) => w.widget_id),
    },
  );
}

function buildLoadedTablesInventory(
  pendingTables: Map<string, Record<string, unknown>[]>,
  allWidgets: Widget[] = [],
): string | null {
  if (pendingTables.size === 0) return null;
  const lines = [
    "## Already Loaded Queryable Tables",
    "These tables are already loaded for this conversation. Use `execute_sql`, `peek_table`, or `create_artifact` with these exact table names instead of calling `get_widget_data` again, unless required fields are missing. The listed columns and loaded-row coverage are authoritative; never invent columns or assume dates outside the loaded range. Alias exact columns when you need semantic names. Use display names, not queryable table names, in final answers.",
  ];
  const widgetDisplayByTableBase = allWidgets
    .map((widget) => ({ tableBase: sanitizeName(widget.name) || "data", displayName: widget.name }))
    .sort((a, b) => b.tableBase.length - a.tableBase.length);
  for (const [tableName, rows] of pendingTables) {
    if (rows.length === 0) continue;
    const table = analyzeTable(tableName, rows);
    const displayName = widgetDisplayByTableBase.find(
      (entry) => table.tableName === entry.tableBase || table.tableName.startsWith(`${entry.tableBase}_`),
    )?.displayName;
    const cols = table.columns
      .slice(0, 16)
      .map((col) => `"${col.name}" (${col.type})`)
      .join(", ");
    const more = table.columns.length > 16 ? `, ... ${table.columns.length - 16} more` : "";
    const coverage = loadedTableCoverage(rows, table.columns);
    lines.push(
      `- "${table.tableName}" (${displayName ? `display name: "${displayName}"; ` : ""}${table.rowCount} loaded rows${coverage ? `; loaded-row coverage: ${coverage}` : ""}): ${cols}${more}`,
    );
  }
  return lines.length > 2 ? lines.join("\n") : null;
}

function loadedTableCoverage(
  rows: Record<string, unknown>[],
  columns: { name: string; originalName: string; type: string }[],
): string | null {
  const temporalColumn =
    columns.find((column) => /^(date|datetime|timestamp|period)$/i.test(column.name)) ??
    columns.find((column) => /^year$/i.test(column.name));
  if (!temporalColumn) return null;

  const values = rows
    .map((row) => row[temporalColumn.originalName])
    .filter((value): value is string | number =>
      typeof value === "string" || typeof value === "number",
    )
    .map((value) => String(value).trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (values.length === 0) return null;

  return `"${temporalColumn.name}" ${values[0]} to ${values[values.length - 1]}`;
}

function buildLoadedSkillsInventory(loadedSkillSlugs: Set<string>): string | null {
  if (loadedSkillSlugs.size === 0) return null;
  return [
    "## Already Loaded Skills",
    "These skill instructions are already loaded for this conversation.",
    ...[...loadedSkillSlugs].sort().map((slug) => `- ${slug}`),
  ].join("\n");
}

/**
 * Test-only: clear the module-level widget data cache. Underscore-prefixed
 * to discourage prod use; mirrors `_resetSandboxState` in the compute MCP.
 */
export function _resetWidgetDataCache(): void {
  widgetDataCache.clear();
}

export interface AgentRunOptions {
  request: QueryRequest;
  rawModelId: string;
  model: LanguageModel;
  allWidgets: Widget[];
  /**
   * Widgets paired with their source tier (primary/secondary/extra). When omitted,
   * each widget in `allWidgets` is treated as `extra`. Production callers in
   * `routes/query.ts` always pass this; tests that don't exercise search_widgets
   * tier ordering can omit it.
   */
  tieredWidgets?: TieredWidget[];
  workspaceState: WorkspaceState | null;
  generativeUiEnabled: boolean;
  /**
   * Per-chat identifier from the workspace's X-Trace-Id header. Threaded
   * into compute MCP calls (via decoration) so the rita-tools MCP server
   * keeps a single Daytona sandbox per chat.
   */
  conversationId: string;
  promptSuggestionsEnabled?: boolean;
  /**
   * How follow-up suggestions are produced (default "inline" = trained
   * `<suggestions>` block; "tool" = the suggest_followups spike). Prod is
   * "inline"; the "tool" path is exercised by the call-rate eval only.
   */
  suggestionsVia?: "inline" | "tool";
}

// MCP tools that consume widget data via the x-agentrita-tables decoration.
// SQL family is now in-process on the agent (no decoration needed); only
// `execute_code` (Daytona-backed) still rides the decoration path. Workspace
// prefixes tool names with a server slug (e.g. "agentritamcp_execute_code"),
// so we suffix-match.
const CODE_TOOL_CANONICAL = ["execute_code"] as const;

function isCodeTool(toolName: string): boolean {
  return CODE_TOOL_CANONICAL.some(
    (canon) => toolName === canon || toolName.endsWith(`_${canon}`),
  );
}

// Document RAG tools — `query_documents` and `list_documents` consume the
// `x-agentrita-documents` decoration carrying any uploaded docs not yet
// shipped to the MCP server's per-conversation store.
const DOCUMENT_TOOL_CANONICAL = ["query_documents", "list_documents"] as const;

function isDocumentTool(toolName: string): boolean {
  return DOCUMENT_TOOL_CANONICAL.some(
    (canon) => toolName === canon || toolName.endsWith(`_${canon}`),
  );
}

/**
 * Cap on how many times the loop can re-enter the model call within a single
 * /v1/query request. Exists only so cache-resolved widget re-fetches can
 * resume without an HTTP round-trip; not a general orchestration knob.
 */
export const MAX_LOOPS = 3;

/**
 * Hard backstop on a single streaming model call (which may run up to
 * `stepCountIs(15)` internal tool steps). Live streaming means the user sees
 * progress long before this fires; it exists only to convert a genuine
 * provider stall into a surfaced error instead of an infinite spinner.
 * Env-overridable for slow self-hosted models.
 */
export const LLM_STREAM_TIMEOUT_MS = Number(process.env.LLM_STREAM_TIMEOUT_MS) || 240_000;
const MAX_VISIBLE_MODEL_ERROR_CHARS = 1_000;
const LIVE_DEBUG_TRACES_LEVEL = Number(process.env.LIVE_DEBUG_TRACES ?? 0);

function debugModelIo(payload: Record<string, unknown>): void {
  if (LIVE_DEBUG_TRACES_LEVEL < 2) return;
  // Intentionally stdout/stderr-style instead of LogTape: this is an
  // explicit local debugging tap for prompt/response inspection.
  console.error(
    "\n[LIVE_DEBUG_TRACES:model_io]\n" +
      JSON.stringify(payload, null, 2) +
      "\n[/LIVE_DEBUG_TRACES:model_io]\n",
  );
}

function debugMessageContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== "object") return part;
      const record = part as Record<string, unknown>;
      if (record.type === "image" || record.type === "file") {
        return {
          ...record,
          data: typeof record.data === "string"
            ? `[${record.data.length} base64 chars omitted]`
            : record.data,
        };
      }
      return record;
    });
  }
  return content;
}

function debugMessages(messages: ModelMessage[]): unknown[] {
  return messages.map((m) => ({
    role: m.role,
    content: debugMessageContent((m as { content?: unknown }).content),
  }));
}

function toolErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export async function* runAgentLoop(options: AgentRunOptions): AsyncGenerator<SSEEvent> {
  const {
    request,
    rawModelId,
    model,
    allWidgets,
    workspaceState,
    generativeUiEnabled,
    promptSuggestionsEnabled = false,
    suggestionsVia = "inline",
    conversationId,
  } = options;
  const tieredWidgets: TieredWidget[] =
    options.tieredWidgets ?? allWidgets.map((w) => ({ widget: w, tier: "extra" as const }));

  const lastMessage = request.messages.at(-1);
  const isRebootToolTurn = lastMessage?.role === "tool";
  const hasWidgets = allWidgets.length > 0;
  const dashboardNameByUuid = buildDashboardNameByUuid(workspaceState);
  const agentTools = (request.tools ?? []) as AgentTool[];
  const mcpToolsResult: McpToolsResult | null = agentTools.length > 0 ? makeMcpTools(agentTools) : null;
  const hasCodeTool = mcpToolsResult?.entries.some((entry) =>
    isCodeTool(entry.sanitizedName) || isCodeTool(entry.toolName)
  ) ?? false;
  const codeBlockedBeforeFirstCall =
    !conversationId ||
    request.messages.some(
      (m) =>
        "content" in m &&
        typeof m.content === "string" &&
        m.content.includes(COMPUTE_PERMANENTLY_UNAVAILABLE),
    );
  const initialCodeExecutionAvailable = hasCodeTool && !codeBlockedBeforeFirstCall;

  // Request-scoped state. SQL execution lives in the compute MCP server now;
  // the agent only carries table metadata + raw rows, ships them on demand,
  // and queues artifacts/citations as they come back via the typed result.
  const artifactQueue: SSEEvent[] = [];
  // Monotonic drain cursor into artifactQueue, request-scoped so each artifact
  // is yielded exactly once across all MAX_LOOPS iterations. (A per-iteration
  // reset would re-emit earlier artifacts whenever the loop `continue`s, e.g.
  // the all-widgets-resolved-from-cache path.)
  let artifactIdx = 0;
  const tables: TableInfo[] = [];
  const citedWidgets = new Map<string, CitedWidget>();
  const mcpCitations: McpCitation[] = [];
  const intermediateCitations: Citation[] = [];
  // Seed from the cross-request row cache so a follow-up user message in
  // the same chat can call execute_sql / execute_code without first round-
  // tripping back through get_widget_data. Fresh widget data later in the
  // request still overwrites these (latest-write-wins per tableName).
  const pendingTables = new Map<string, Record<string, unknown>[]>(
    getCachedRows(conversationId, allWidgets),
  );
  if (pendingTables.size > 0) {
    logger.info("Seeded pendingTables from chat row cache", {
      conversationId,
      seedCount: pendingTables.size,
      seedNames: [...pendingTables.keys()],
    });
  }
  const tablesShipped = new Set<string>();
  const documentsShipped = new Set<string>();
  // Daytona sandbox identity from the prior execute_code result (if any).
  // The reboot path below restores this from extra_state and may clear
  // `tablesShipped` when the sandbox has been recreated since.
  let lastSandboxId: string | undefined = undefined;
  const rebootExtra = isRebootToolTurn ? readExtraState(lastMessage as ToolMessage) : {};
  const loadedSkillSlugs = new Set<string>(
    (request.selected_skills ?? []).map((skill) => skill.slug),
  );
  if (isRebootToolTurn) {
    for (const slug of rebootExtra.loaded_skill_slugs ?? []) loadedSkillSlugs.add(slug);
    if (lastMessage.function === "get_skill_content") {
      const slug = lastMessage.input_arguments?.slug;
      if (typeof slug === "string" && slug) loadedSkillSlugs.add(slug);
    }
    // Restore delta-ship state BEFORE any pendingTables writes (context-table
    // seed, injectFromReboot) so setPendingTable's invalidation always acts on
    // the restored set, never on a transiently-empty one.
    for (const t of rebootExtra.compute_tables_shipped ?? []) tablesShipped.add(t);
    for (const d of rebootExtra.documents_shipped ?? []) documentsShipped.add(d);
    if (rebootExtra.compute_sandbox_id) lastSandboxId = rebootExtra.compute_sandbox_id;
  }
  // Decode/fetch uploaded documents once per request. Bytes live only for
  // the lifetime of this generator; the MCP server holds the parsed/embedded
  // form per conversation.
  const pendingDocuments: Map<string, PendingDocument> = await loadUploadedDocuments(
    request.documents,
  );
  if ((request.documents?.length ?? 0) > 0) {
    logger.warn(
      "request.documents is deprecated — workspace should upload files as file-* widgets in widgets.primary; the agent now ingests them via the get_widget_data round-trip.",
      { count: request.documents!.length },
    );
  }

  try {
    const messages = buildMessages(request, {
      generativeUiEnabled,
      promptSuggestionsEnabled,
      suggestionsVia,
      workspaceState,
      codeExecutionAvailable: initialCodeExecutionAvailable,
      mcpToolEntries: mcpToolsResult?.entries,
    });

    // Eager URL prefetch (workspace caps to 4). Failures are swallowed per-URL
    // by `prefetchUrls`. Results are stitched into a user message so the
    // model sees them before its first tool decision, and a web citation is
    // registered per successful fetch.
    const prefetched = await prefetchUrls(request.urls);
    for (const r of prefetched) {
      const id = await urlCitationId(r.url);
      mcpCitations.push({ id, type: "web", url: r.url, title: r.title });
    }

    // Split `request.context` into structured tables (queryable via SQL)
    // and unstructured text blocks (injected into the system context).
    const ctxSplit = splitContext(request.context);
    for (const t of ctxSplit.tables) {
      setPendingTable(t.name, t.rows, pendingTables, tablesShipped);
    }

    const contextSections: string[] = [];
    if (prefetched.length > 0) {
      contextSections.push("## Fetched URLs\n");
      for (const r of prefetched) {
        contextSections.push(
          `### ${r.title} — ${r.url}\n\n${r.markdown}`,
        );
      }
    }
    if (ctxSplit.textBlocks.length > 0) {
      contextSections.push("\n## Conversation context (text)\n");
      for (const tb of ctxSplit.textBlocks) {
        const sub = tb.description ? ` — ${tb.description}` : "";
        contextSections.push(`### ${tb.name}${sub}\n\n${tb.text}`);
      }
    }
    if (ctxSplit.tables.length > 0) {
      contextSections.push("\n## Conversation context (tables loaded)\n");
      for (const t of ctxSplit.tables) {
        contextSections.push(
          `- ${t.name} (${t.rows.length} rows) — query with execute_sql`,
        );
      }
    }
    const loadedTablesInventory = buildLoadedTablesInventory(pendingTables, allWidgets);
    if (loadedTablesInventory) {
      contextSections.push(`\n${loadedTablesInventory}`);
    }
    const loadedSkillsInventory = buildLoadedSkillsInventory(loadedSkillSlugs);
    if (loadedSkillsInventory) {
      contextSections.push(`\n${loadedSkillsInventory}`);
    }
    if (contextSections.length > 0) {
      messages.push({
        role: "user" as const,
        content: contextSections.join("\n\n"),
      });
    }

    const ctx: RoundTripContext = {
      tables, messages, allWidgets,
      citedWidgets, mcpCitations, artifactQueue, intermediateCitations,
      pendingTables,
      tablesShipped,
      conversationId,
      pendingDocuments,
      codeExecutionAvailable: initialCodeExecutionAvailable,
    };

    // Continuation state that must ride on EVERY round-trip emission
    // (get_widget_data, get_skill_content, execute_agent_tool). The workspace
    // echoes extra_state back on the re-POST and the loop restores from the
    // LAST tool message only — any key omitted here is lost for the rest of
    // the turn (e.g. a widget fetch between two execute_code calls would
    // otherwise wipe the delta-ship state and force a full re-ship).
    async function buildContinuationExtraState(): Promise<Record<string, unknown>> {
      const cits = await buildAllCitations(citedWidgets, mcpCitations, intermediateCitations);
      const extraState: Record<string, unknown> = {};
      if (cits.length > 0) extraState.intermediate_citations = cits;
      if (tablesShipped.size > 0) extraState.compute_tables_shipped = [...tablesShipped];
      if (lastSandboxId !== undefined) extraState.compute_sandbox_id = lastSandboxId;
      if (documentsShipped.size > 0) extraState.documents_shipped = [...documentsShipped];
      if (loadedSkillSlugs.size > 0) extraState.loaded_skill_slugs = [...loadedSkillSlugs];
      return extraState;
    }

    async function* emitNextWidgetFetch(
      fetches: ResolvedWidgetFetch[],
    ): AsyncGenerator<SSEEvent, boolean, unknown> {
      if (fetches.length === 0) return false;

      // Plain widgets all load in one get_widget_data round-trip — the bridge
      // fetches every data_source in a single call. SSRM widgets each carry
      // their own SQL, so they stay one-per-round-trip; defer the rest via
      // pending_widget_data_requests. This keeps the common multi-widget case
      // to a single re-POST while still giving each widget its own status.
      const regular = fetches.filter((fetch) => !fetch.sql);
      const sql = fetches.filter((fetch) => fetch.sql);

      const extraState = await buildContinuationExtraState();

      if (regular.length > 0) {
        if (sql.length > 0) {
          extraState.pending_widget_data_requests = sql.map((fetch) => fetch.request);
        }
        for (const status of formatWidgetDataRequestStatuses(regular.map((fetch) => fetch.widget))) {
          yield reasoningStep(status.message, status.eventType ?? "INFO", status.details, status.artifacts);
        }
        yield* emitPendingArtifactsBeforeExit();
        yield getWidgetData(regular.map((fetch) => fetch.widget), extraState);
        return true;
      }

      const [next, ...remaining] = sql;
      if (!next?.sql) return false;
      if (remaining.length > 0) {
        extraState.pending_widget_data_requests = remaining.map((fetch) => fetch.request);
      }
      const status = formatWidgetDataRequestStatuses([next.widget], { sql: next.sql })[0];
      if (status) {
        yield reasoningStep(status.message, status.eventType ?? "INFO", status.details, status.artifacts);
      }
      yield* emitPendingArtifactsBeforeExit();
      yield getWidgetDataSsrm(next.widget, next.sql, undefined, extraState);
      return true;
    }

    let answerArtifactEmitted = false;
    // Message artifacts (copilotMessageArtifact) are deferred so the final-
    // answer path can weave them into the text. Declared BEFORE the reboot
    // block: injectFromReboot can queue artifacts, and any mid-turn exit
    // (round-trip emission, terminal bridge call) must drain + flush them —
    // the artifactQueue is request-scoped and dies at the re-POST.
    const deferredAnswerArtifactEvents: SSEEvent[] = [];
    function* flushDeferredAnswerArtifacts(): Generator<SSEEvent> {
      while (deferredAnswerArtifactEvents.length > 0) {
        const queued = deferredAnswerArtifactEvents.shift()!;
        answerArtifactEmitted = true;
        yield queued;
      }
    }
    // Drain the queue: artifact events → deferred, everything else → out.
    function* drainQueueToDeferred(): Generator<SSEEvent> {
      while (artifactIdx < artifactQueue.length) {
        const queued = artifactQueue[artifactIdx++];
        if (queued.event === "copilotMessageArtifact") {
          deferredAnswerArtifactEvents.push(queued);
        } else {
          yield queued;
        }
      }
    }
    // Drain + flush. Call before every yield that pauses the turn for a
    // re-POST, so artifacts queued this request reach the message stream.
    function* emitPendingArtifactsBeforeExit(): Generator<SSEEvent> {
      yield* drainQueueToDeferred();
      yield* flushDeferredAnswerArtifacts();
    }

    let suppressWidgetDataToolForEmptyWidgetRetry = false;
    let suppressWidgetDiscoveryToolsForEmptyWidgetRetry = false;

    if (isRebootToolTurn) {
      // (tablesShipped / documentsShipped / lastSandboxId were restored from
      // rebootExtra before the context-table seed, near their declarations.)
      const rebootOut = yield* injectFromReboot(lastMessage as ToolMessage, ctx);
      const hasQueuedContinuation =
        (rebootExtra.pending_widget_data_requests?.length ?? 0) > 0 ||
        (rebootExtra.pending_bridge_calls?.length ?? 0) > 0;
      if (rebootOut.terminal && !hasQueuedContinuation) {
        yield* emitPendingArtifactsBeforeExit();
        if (rebootOut.terminalMessage) {
          yield messageChunk(rebootOut.terminalMessage);
        }
        return;
      }
      suppressWidgetDataToolForEmptyWidgetRetry = rebootOut.suppressWidgetDataTool === true;
      suppressWidgetDiscoveryToolsForEmptyWidgetRetry =
        rebootOut.suppressWidgetDiscoveryTools === true;
      // Sandbox-id guard: only fires when the re-POST tool was execute_code.
      // - new id != stored id → sandbox was recreated; old tables are gone.
      //   Clear so the next call full-ships. (Recreation is detected one
      //   round-trip late by design: the call that just ran against the fresh
      //   sandbox saw missing tables and failed; the model gets the Python
      //   error and retries.)
      // - new id, no prior id → first sighting. With no prior id on record,
      //   the restored tablesShipped can only have come from the extra_state
      //   of the very call that returned this sandbox_id — i.e. it describes
      //   exactly the payload prepareCompute loaded into THIS sandbox. Record
      //   without clearing.
      // - id absent (old MCP server) → no way to verify identity; conservative
      //   clear so the next call full-ships.
      const rebootToolName = (lastMessage as ToolMessage).input_arguments?.tool_name;
      const wasExecuteCodeReboot =
        typeof rebootToolName === "string" && isCodeTool(rebootToolName);
      if (wasExecuteCodeReboot) {
        if (rebootOut.sandboxId !== undefined) {
          if (lastSandboxId !== undefined && rebootOut.sandboxId !== lastSandboxId) {
            logger.info("Sandbox id changed — clearing tablesShipped", {
              conversationId,
              prev: lastSandboxId,
              next: rebootOut.sandboxId,
            });
            tablesShipped.clear();
          }
          lastSandboxId = rebootOut.sandboxId;
        } else {
          logger.info("No sandbox_id in execute_code result — clearing tablesShipped (conservative)", {
            conversationId,
          });
          tablesShipped.clear();
          lastSandboxId = undefined;
        }
      }
      const pendingWidgetRequests = rebootExtra.pending_widget_data_requests ?? [];
      if (pendingWidgetRequests.length > 0) {
        const { fetches, unmatched } = resolveWidgetFetches(
          pendingWidgetRequests,
          allWidgets,
          dashboardNameByUuid,
        );
        logUnmatchedWidgets(unmatched, allWidgets);
        if (yield* emitNextWidgetFetch(fetches)) return;
      }

      // Drain queued bridge commands one per re-POST (only ONE
      // copilotFunctionCall may be in flight per turn). The browser already
      // executed the prior emission and re-POSTed its result (injected above
      // via injectFromReboot); emit the next queued call and carry the
      // remainder forward. Runs BEFORE the model so the model is not consulted
      // mid-drain — it composes the final answer only once the queue is empty.
      // Re-validate function names: pending_bridge_calls round-trips through the
      // browser (extra_state echo), so treat it as untrusted input — keep only
      // real bridge commands, same filter as the emission side.
      const queuedBridgeCalls = (rebootExtra.pending_bridge_calls ?? []).filter((c) =>
        OPENBB_AI_SSE_BRIDGE_COMMANDS.has(c.function),
      );
      if (queuedBridgeCalls.length > 0 && !generativeUiEnabled) {
        // Toggle flipped off mid-drain: respect it (stop mutating the
        // dashboard) but log so the stranded queue is traceable, not silent.
        logger.warn("Queued bridge calls stranded — generative UI disabled mid-drain", {
          stranded: queuedBridgeCalls.map((c) => c.function),
        });
      }
      const pendingBridgeCalls = generativeUiEnabled ? queuedBridgeCalls : [];
      if (pendingBridgeCalls.length > 0) {
        const [next, ...remaining] = pendingBridgeCalls;
        const drainExtraState = await buildContinuationExtraState();
        if (remaining.length > 0) drainExtraState.pending_bridge_calls = remaining;
        logger.info("Draining queued bridge call", {
          emitting: next.function,
          remaining: remaining.map((c) => c.function),
        });
        yield* emitPendingArtifactsBeforeExit();
        yield workspaceCommand(
          next.function,
          normalizeBridgeArgs(next.function, next.input_arguments ?? {}),
          drainExtraState,
        );
        return;
      }
    }

    const mcpToolNames = mcpToolsResult ? new Set(mcpToolsResult.entries.map((e) => e.sanitizedName)) : null;
    const mcpEntryBySanitized = mcpToolsResult
      ? new Map(mcpToolsResult.entries.map((entry) => [entry.sanitizedName, entry]))
      : null;
    let createArtifactReasoningEmitted = false;
    // The streaming text sink owns ALL stateful answer-text handling: the
    // incremental tag-strip, the <suggestions> hold/extract, the mermaid-fence
    // hold, the artifact weave, and the textEmitted flag. It is the sole
    // sanitizer on the streaming path — text-delta → sink.pushDelta → emit. It
    // weaves the deferred answer artifacts at a paragraph break (or via the
    // splitForArtifactInsertion fallback on flush) and flips answerArtifactEmitted.
    const sink = makeTextSink({
      deferredAnswerArtifactEvents,
      onArtifactEmitted: () => {
        answerArtifactEmitted = true;
      },
    });
    // suggest_followups spike (suggestionsVia === "tool"): the tool's execute
    // records here; the final-answer dispatch emits it as promptSuggestions.
    // Must live OUTSIDE the MAX_LOOPS loop (the tools object is rebuilt each
    // iteration) so a capture survives to the emit. Unused in "inline" mode.
    let capturedSuggestions: string[] = [];
    function visibleModelFailureMessage(errorText: string, isTimeout = false): string {
      const conciseError = errorText.length <= MAX_VISIBLE_MODEL_ERROR_CHARS
        ? errorText
        : `${errorText.slice(0, MAX_VISIBLE_MODEL_ERROR_CHARS)}...`;
      return isTimeout
        ? "I couldn't finish the response because the model timed out. Try a narrower request."
        : `I couldn't finish the response because the model returned an error: ${conciseError}`;
    }
    let cumulativeUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let totalStepCount = 0;
    let loopCount = 0;
    let suppressWidgetDataToolForCachedRetry = false;
    const searchTool = makeSearchWidgetsTool(tieredWidgets);
    const createAppTool = makeCreateAppTool({ allWidgets, artifactQueue });

    for (let loopIdx = 0; loopIdx < MAX_LOOPS; loopIdx++) {
      // Artifacts queued before the stream (injectFromReboot processing the
      // re-POSTed MCP result) move to the deferred set now, so the in-stream
      // tool-result drain can't mis-attach them to an unrelated tool's status.
      // They surface woven into the final answer, or via the pre-exit flush.
      yield* drainQueueToDeferred();
      const hasSkillsCatalog = (request.skills_catalog ?? []).length > 0;

      // Suppress only execute_code (Daytona-backed) when we have no
      // conversationId or when a prior call in this chat returned the
      // permanently-unavailable marker. The SQL family is in-process on the
      // MCP server (no sandbox), so it never needs suppression.
      const codeTerminallyDown =
        !conversationId ||
        ctx.messages.some(
          (m) =>
            typeof m.content === "string" &&
            m.content.includes(COMPUTE_PERMANENTLY_UNAVAILABLE),
        );
      ctx.codeExecutionAvailable = hasCodeTool && !codeTerminallyDown;
      const filteredMcpToolSet = mcpToolsResult && codeTerminallyDown
        ? Object.fromEntries(
            Object.entries(mcpToolsResult.toolSet).filter(([name]) => !isCodeTool(name)),
          )
        : mcpToolsResult?.toolSet;
      if (mcpToolsResult && codeTerminallyDown && loopIdx === 0) {
        logger.warn(
          `execute_code suppressed for this turn (conversationId=${conversationId || "MISSING"}); SQL family unaffected`,
        );
      }

      const workspaceToolSet =
        generativeUiEnabled && !suppressWidgetDiscoveryToolsForEmptyWidgetRetry
          ? makeWorkspaceTools(OPENBB_AI_SSE_BRIDGE_COMMANDS)
          : null;
      const sqlToolSet = makeSqlTools({
        pendingTables,
        artifactQueue,
        codeExecutionAvailable: ctx.codeExecutionAvailable,
      });
      const nativeToolSet = makeNativeTools({
        pendingTables,
        tablesShipped,
        artifactQueue,
        tables,
        conversationId,
      });
      const widgetDataToolEnabled =
        hasWidgets &&
        !suppressWidgetDataToolForCachedRetry &&
        !suppressWidgetDataToolForEmptyWidgetRetry &&
        !suppressWidgetDiscoveryToolsForEmptyWidgetRetry;
      const widgetDiscoveryToolsEnabled = !suppressWidgetDiscoveryToolsForEmptyWidgetRetry;
      if (suppressWidgetDataToolForCachedRetry) {
        logger.info("Suppressing get_widget_data after cache-resolved injection", { loopIdx });
      }
      if (suppressWidgetDataToolForEmptyWidgetRetry) {
        logger.info("Suppressing get_widget_data after empty widget-data result", { loopIdx });
      }
      if (suppressWidgetDiscoveryToolsForEmptyWidgetRetry) {
        logger.info("Suppressing widget discovery tools after empty widget-data result", { loopIdx });
      }
      suppressWidgetDataToolForCachedRetry = false;
      suppressWidgetDataToolForEmptyWidgetRetry = false;
      suppressWidgetDiscoveryToolsForEmptyWidgetRetry = false;

      const tools: ToolSet = {
        ...(widgetDiscoveryToolsEnabled && { search_widgets: searchTool }),
        ...(widgetDiscoveryToolsEnabled && { create_app: createAppTool }),
        ...sqlToolSet,
        ...nativeToolSet,
        ...(widgetDataToolEnabled && { get_widget_data: makeWidgetDataTool() }),
        ...(hasSkillsCatalog && { get_skill_content: makeGetSkillContentTool() }),
        ...(suggestionsVia === "tool" &&
          promptSuggestionsEnabled && {
            suggest_followups: makeSuggestionsTool({
              setSuggestions: (s) => {
                capturedSuggestions = s;
              },
            }),
          }),
        ...(filteredMcpToolSet && filteredMcpToolSet),
        ...(workspaceToolSet ?? {}),
      };

      if (loopIdx === 0) {
        logger.info("Tools available", { tools: Object.keys(tools), mcpCount: agentTools.length });
      }
      const result = streamText({
        model,
        messages,
        tools,
        stopWhen: [
          ...(widgetDataToolEnabled ? [hasToolCall("get_widget_data")] : []),
          hasToolCall("get_skill_content"),
          ...(workspaceToolSet
            ? Array.from(OPENBB_AI_SSE_BRIDGE_COMMANDS).map((name) => hasToolCall(name))
            : []),
          ...(mcpToolsResult ? [mcpToolsResult.stopCondition] : []),
          stepCountIs(15),
        ],
        providerOptions: PROVIDER_OPTIONS,
        abortSignal: AbortSignal.timeout(LLM_STREAM_TIMEOUT_MS),
        onError: ({ error }) => logger.error("streamText error part", { loopIdx, error }),
      });

      // Live emission. We consume `fullStream` so in-process tool chains
      // (search_widgets → SQL → create_artifact, none of which round-trip)
      // surface progress AS THEY HAPPEN instead of going silent until the
      // whole multi-step model call returns. Per stream part:
      //  - tool-call → a reasoning step carrying structured {tool_name, input}
      //    so the eval trace runner can attribute in-process calls (execute_sql,
      //    create_artifact, search_widgets) that never round-trip via SSE.
      //  - in-process tool `execute` pushes onto artifactQueue mid-stream.
      //    Non-answer artifacts still drain immediately. Answer artifacts from
      //    create_artifact are attached to the tool status right away, then
      //    emitted as answer artifacts only after follow-up tool work finishes.
      //  - text is buffered until the model turn is understood. If the model
      //    emits prose before a tool call, that prose is progress chatter, not
      //    the final answer, so the next tool-call clears it. Only text after
      //    the last tool call is eligible to become a message chunk.
      // Reasoning blocks accumulate per id and surface as one status each on
      // reasoning-end. Per-stream (reset each loop iteration).
      const reasoningByBlock = new Map<string, string>();
      let lastReasoningEmitted = "";
      let aborted = false;
      const invalidToolCallIds = new Set<string>();
      // Observability for the streaming trade-off: live text can no longer be
      // retracted, so any visible prose followed by a tool-call this stream is
      // exactly what the old buffer-and-discard path suppressed. The prompt
      // nudge (prompt.ts) is the only mitigation; this logs when it fails so the
      // leak is visible in prod between eval runs. One warn per stream.
      let visibleTextStreamed = false;
      let preToolProseWarned = false;
      function* emitVisibleModelFailure(errorText: string, isTimeout = false): Generator<SSEEvent> {
        yield* drainQueueToDeferred();
        // Any partial answer already streamed live; flush whatever the sink
        // still holds (tail text + un-woven artifacts), then append the
        // fallback. Gate purely on sink.textEmitted — never reconstruct text
        // from buffers (there is no buffer now), which would double-emit.
        for (const ev of sink.flushTail()) yield ev;
        const fallback = visibleModelFailureMessage(errorText, isTimeout);
        yield messageChunk(sink.textEmitted ? `\n\n${fallback}` : fallback);
      }
      try {
        for await (const part of result.fullStream) {
          switch (part.type) {
            case "text-delta":
              // Stream live. The sink is the sole sanitizer; pre-tool prose is
              // no longer suppressed (decision: stream it, nudge the prompt to
              // keep intent in _llm_think / display_summary instead).
              for (const ev of sink.pushDelta(part.text)) yield ev;
              if (sink.textEmitted) visibleTextStreamed = true;
              break;
            case "reasoning-delta":
              reasoningByBlock.set(part.id, (reasoningByBlock.get(part.id) ?? "") + part.text);
              break;
            case "reasoning-end": {
              const text = (reasoningByBlock.get(part.id) ?? "").trim();
              reasoningByBlock.delete(part.id);
              // One status per block; skip trivially short or duplicate blocks
              // so the thinking lane does not stack on the per-tool display_summary.
              if (text.length >= 15 && text !== lastReasoningEmitted) {
                lastReasoningEmitted = text;
                yield reasoningStep(text, "INFO");
              }
              break;
            }
            case "tool-call": {
              if (visibleTextStreamed && !preToolProseWarned) {
                preToolProseWarned = true;
                logger.warn("Pre-tool prose streamed live (not retractable)", {
                  loopIdx,
                  conversationId,
                });
              }
              if (part.invalid) {
                invalidToolCallIds.add(part.toolCallId);
                const errorText = toolErrorText(part.error);
                logger.warn("Tool input rejected by schema", {
                  loopIdx,
                  toolName: part.toolName,
                  toolCallId: part.toolCallId,
                  input: part.input,
                  error: errorText,
                });
                const status = formatToolInputRejectedStatus(part.toolName, part.input, errorText);
                yield reasoningStep(status.message, status.eventType ?? "WARNING", status.details);
                break;
              }
              if (part.toolName === "get_widget_data" || part.toolName === "_llm_think") {
                // Bridge calls and _llm_think have dedicated user-facing
                // statuses with resolved labels / planning details, so do
                // not show the raw model payload too.
                break;
              }
              const isMcp = mcpToolNames?.has(part.toolName) ?? false;
              const mcpEntry = isMcp ? mcpEntryBySanitized?.get(part.toolName) : undefined;
              const statusInput = enrichToolStatusInput(part.toolName, part.input, dashboardNameByUuid);
              const status = formatToolStartStatus(part.toolName, statusInput, {
                isMcp,
                actualToolName: mcpEntry?.toolName,
              });
              // Carry structured tool-call attribution outside of display
              // details so the reasoning UI can render code/details cleanly
              // while the eval trace runner still sees in-process calls.
              const displayDetail: Record<string, unknown> | string | undefined =
                status.details && typeof status.details === "object" && !Array.isArray(status.details)
                  ? "detail" in status.details
                    ? { detail: status.details.detail }
                    : status.details
                  : typeof status.details === "string"
                    ? shouldRenderDetailAsCode(status.details)
                      ? status.details
                      : { detail: status.details }
                    : undefined;
              const event = reasoningStep(
                status.message,
                status.eventType ?? "INFO",
                displayDetail,
                status.artifacts,
              );
              event.data.tool_call = { tool_name: part.toolName, input: part.input };
              yield event;
              break;
            }
            case "tool-result": {
              // Tools such as create_artifact can enqueue renderable artifacts
              // during execution. Attach those artifacts to the tool status
              // immediately, but defer answer-stream artifact events until the
              // model has finished any follow-up reasoning/tool work.
              const queuedArtifactEvents: SSEEvent[] = [];
              while (artifactIdx < artifactQueue.length) {
                const queued = artifactQueue[artifactIdx++];
                if (queued.event === "copilotMessageArtifact") {
                  queuedArtifactEvents.push(queued);
                } else {
                  yield queued;
                }
              }
              if (part.toolName === "_llm_think") {
                for (const queued of queuedArtifactEvents) {
                  answerArtifactEmitted = true;
                  yield queued;
                }
                break;
              }
              const isMcp = mcpToolNames?.has(part.toolName) ?? false;
              const mcpEntry = isMcp ? mcpEntryBySanitized?.get(part.toolName) : undefined;
              const status = formatToolResultStatus(part.toolName, part.input, part.output, {
                isMcp,
                actualToolName: mcpEntry?.toolName,
              });
              const statusArtifacts = status.artifacts ?? [];
              const artifacts = [
                ...statusArtifacts,
                ...artifactPayloads(queuedArtifactEvents),
              ];
              if (part.toolName === "create_artifact" && artifacts.length > 0) {
                createArtifactReasoningEmitted = true;
              }
              if (!status.generic || artifacts.length > 0) {
                yield reasoningStep(
                  status.message,
                  status.eventType ?? "INFO",
                  artifacts.length > 0 ? undefined : status.details,
                  artifacts,
                );
              }
              if (part.toolName === "create_artifact") {
                deferredAnswerArtifactEvents.push(...queuedArtifactEvents);
              } else {
                for (const queued of queuedArtifactEvents) {
                  answerArtifactEmitted = true;
                  yield queued;
                }
              }
              break;
            }
            case "tool-error": {
              if (invalidToolCallIds.has(part.toolCallId)) break;
              const errorText = toolErrorText(part.error);
              logger.warn("Tool execution failed", {
                loopIdx,
                toolName: part.toolName,
                toolCallId: part.toolCallId,
                input: part.input,
                error: errorText,
              });
              yield reasoningStep("Tool execution failed", "WARNING", {
                phase: "output",
                category: "tool_output",
                tool_name: part.toolName,
                input_params: part.input,
                output_preview: errorText,
              });
              break;
            }
            case "error": {
              const errorText = toolErrorText(part.error);
              logger.error("streamText error part", { loopIdx, error: errorText });
              yield reasoningStep(`Model error: ${errorText}`, "ERROR");
              yield* emitVisibleModelFailure(errorText);
              return;
            }
            case "abort":
              aborted = true;
              break;
          }
          while (
            artifactIdx < artifactQueue.length &&
            artifactQueue[artifactIdx].event !== "copilotMessageArtifact"
          ) {
            yield artifactQueue[artifactIdx++];
          }
        }
      } catch (err) {
        const isAbort =
          err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
        logger.error("streamText consumption failed", {
          loopIdx,
          isAbort,
          error: err instanceof Error ? err.message : String(err),
        });
        yield reasoningStep(
          isAbort
            ? `Model timed out after ${Math.round(LLM_STREAM_TIMEOUT_MS / 1000)}s. Try a narrower request.`
            : `Model error: ${err instanceof Error ? err.message : String(err)}`,
          "ERROR",
        );
        yield* emitVisibleModelFailure(
          err instanceof Error ? err.message : String(err),
          isAbort,
        );
        return;
      }
      if (aborted) {
        logger.warn("streamText aborted (timeout)", { loopIdx, timeoutMs: LLM_STREAM_TIMEOUT_MS });
        yield reasoningStep(
          `Model timed out after ${Math.round(LLM_STREAM_TIMEOUT_MS / 1000)}s. Try a narrower request.`,
          "ERROR",
        );
        yield* emitVisibleModelFailure(
          `Model timed out after ${Math.round(LLM_STREAM_TIMEOUT_MS / 1000)}s.`,
          true,
        );
        return;
      }

      // Stream fully drained — resolve final metadata from the buffered result.
      const steps = await result.steps;
      const totalUsage = await result.totalUsage;
      const finalText = await result.text;
      const debugStepRecords = steps as unknown as Array<Record<string, unknown>>;
      debugModelIo({
        loopIdx,
        modelId: rawModelId,
        messages: debugMessages(messages),
        toolCalls: steps.flatMap((step) =>
          step.toolCalls.map((tc) => ({
            toolName: tc.toolName,
            input: tc.input,
          })),
        ),
        finalText,
        reasoning: debugStepRecords
          .map((step, idx) => ({
            step: idx,
            reasoningText: step.reasoningText ?? null,
            reasoning: step.reasoning ?? null,
          }))
          .filter((step) => step.reasoningText != null || step.reasoning != null),
        usage: totalUsage,
      });

      const loopUsage = flattenUsage(totalUsage);
      cumulativeUsage = accumulateUsage(cumulativeUsage, loopUsage);
      totalStepCount += steps.length;
      loopCount++;

      logger.info("Loop complete", { loopIdx, steps: steps.length, ...loopUsage });

      const lastStep = steps.at(-1);
      const completedToolNames = Array.from(
        new Set(steps.flatMap((step) => step.toolCalls.map((tc) => tc.toolName))),
      );

      // Usage/cost is logged server-side only — never emitted to the
      // workspace. Usage resolves after the stream drains, so any SSE (even a
      // hidden one) lands after the message text and the workspace renders it
      // as a trailing "Agent Rita" reasoning block below the answer.
      const estimatedCostUsd = estimateCost(rawModelId, cumulativeUsage);
      logger.info("Token usage", {
        modelId: rawModelId,
        ...cumulativeUsage,
        estimatedCostUsd,
        loopCount,
        stepCount: totalStepCount,
      });

      // Final safety drain: an artifact could land between the last stream
      // part and here (e.g. a tool-result that resolved at stream close).
      while (artifactIdx < artifactQueue.length) {
        const queued = artifactQueue[artifactIdx++];
        if (queued.event === "copilotMessageArtifact") {
          deferredAnswerArtifactEvents.push(queued);
        } else {
          yield queued;
        }
      }

      // --- MCP tool round-trip ---
      const mcpToolCall = mcpToolsResult
        ? lastStep?.toolCalls.find((tc) => mcpToolNames!.has(tc.toolName))
        : undefined;

      if (mcpToolCall) {
        const entry = mcpToolsResult!.entries.find((e) => e.sanitizedName === mcpToolCall.toolName)!;
        const params = { ...((mcpToolCall.input ?? {}) as Record<string, unknown>) };
        delete params.display_summary;

        // Decoration: ship pendingTables delta to `execute_code` (Daytona-
        // backed). The SQL family runs in-process on the agent now, so it
        // reads `pendingTables` directly through the tool factory's closure
        // — no decoration, no x-agentrita-tables on the wire.
        //
        // Delta-ship: `tablesShipped` tracks what the sandbox already has.
        // It's restored on re-POST from `extra_state.compute_tables_shipped`
        // and invalidated entry-by-entry by `setPendingTable` whenever
        // pendingTables is overwritten (widget re-fetch, follow-up
        // sqlite_table). The sandbox-id guard in the re-POST block above
        // clears the whole set when the Daytona sandbox is recreated.
        if (isCodeTool(entry.toolName)) {
          if (!conversationId) {
            logger.warn(
              `execute_code ${entry.toolName} called without X-Trace-Id — sandbox keying will fail`,
            );
          }
          params["x-agentrita-conversation-id"] = conversationId;
          const toShip: Record<string, Record<string, unknown>[]> = {};
          for (const [name, rows] of pendingTables.entries()) {
            if (rows.length === 0) continue;
            if (tablesShipped.has(name)) continue;
            // Ship sanitized keys: the model only knows the sanitized column
            // names (inventory, execute_sql), so the sandbox schema must match.
            toShip[name] = sanitizeRowKeys(name, rows);
          }
          if (Object.keys(toShip).length > 0) {
            params["x-agentrita-tables"] = toShip;
            for (const name of Object.keys(toShip)) tablesShipped.add(name);
          }
          logger.info(
            `Decoration tool=${entry.toolName} pending=${pendingTables.size} shipping=${Object.keys(toShip).length} alreadyShipped=${tablesShipped.size - Object.keys(toShip).length}`,
            {
              tool: entry.toolName,
              conversationId,
              pendingTableNames: [...pendingTables.keys()],
              shippingNames: Object.keys(toShip),
            },
          );
        }

        // Document RAG decoration. Ship the delta of uploaded docs not yet
        // in the MCP server's per-conversation store. After the call,
        // every shipped id is recorded so subsequent calls in this chat
        // skip re-shipping. The MCP server keys its store by
        // conversationId + doc id (sha-stable), so re-shipping is harmless
        // but wasteful.
        if (isDocumentTool(entry.toolName)) {
          if (!conversationId) {
            logger.warn(
              `${entry.toolName} called without X-Trace-Id — doc store keying will fail`,
            );
          }
          params["x-agentrita-conversation-id"] = conversationId;
          const docDelta = buildDocumentsDecoration(pendingDocuments, documentsShipped);
          if (docDelta) {
            params["x-agentrita-documents"] = docDelta;
            for (const d of docDelta) documentsShipped.add(d.id);
          }
          logger.info(
            `Doc decoration tool=${entry.toolName} pending=${pendingDocuments.size} shipping=${docDelta?.length ?? 0} alreadyShipped=${documentsShipped.size - (docDelta?.length ?? 0)}`,
            {
              tool: entry.toolName,
              conversationId,
              pendingDocCount: pendingDocuments.size,
              shippingIds: docDelta?.map((d) => d.id) ?? [],
            },
          );
        }

        const extraState = await buildContinuationExtraState();

        // Log the outbound emission. We compute payload bytes by serializing
        // params once here (cheap relative to the network/SSE cost). This is
        // the only place agent-side code can see what's actually leaving for
        // the workspace → MCP wire, so it's worth a log line per call.
        const paramsBytes = Buffer.byteLength(JSON.stringify(params), "utf-8");
        const tablesParam = params["x-agentrita-tables"];
        const decoratedTables = tablesParam && typeof tablesParam === "object"
          ? Object.keys(tablesParam as Record<string, unknown>)
          : [];
        logger.info("Emitting executeAgentTool", {
          conversationId,
          tool: entry.toolName,
          serverId: entry.serverId,
          paramsKeys: Object.keys(params),
          paramsBytes,
          decoratedTables,
          tablesShippedTotal: tablesShipped.size,
          extraStateKeys: Object.keys(extraState),
        });

        for (const ev of sink.flushTail()) yield ev;
        yield* emitPendingArtifactsBeforeExit();
        yield executeAgentTool(entry.serverId, entry.toolName, params, extraState);
        return;
      }

      // --- Native workspace bridge calls (round-trip) ---
      // Only dispatch when bridge tools were actually registered for this
      // turn. Otherwise a stray match against the bridge command name set
      // would leak a native SSE for a tool the model couldn't legitimately
      // have picked.
      const bridgeCalls =
        workspaceToolSet
          ? (lastStep?.toolCalls.filter((tc) =>
              OPENBB_AI_SSE_BRIDGE_COMMANDS.has(tc.toolName),
            ) ?? [])
          : [];
      if (bridgeCalls.length > 0) {
        for (const ev of sink.flushTail()) yield ev;
        yield* emitPendingArtifactsBeforeExit();
        // One bridge command per round-trip: the browser executes each
        // copilotFunctionCall and re-POSTs immediately, so a second emission
        // in the same turn would fork the conversation into duplicate
        // continuations (and duplicate widget mutations). Emit the first now
        // and QUEUE the rest in extra_state — the loop drains them one per
        // re-POST (see the pending_bridge_calls block above). Dropping them
        // would lose model-decided mutations: when the model fires several
        // calls up front it does not re-issue the remainder after seeing one
        // result.
        const [bridgeCall, ...deferred] = bridgeCalls;
        const bridgeExtraState = await buildContinuationExtraState();
        if (deferred.length > 0) {
          bridgeExtraState.pending_bridge_calls = deferred.map((tc) => ({
            function: tc.toolName,
            input_arguments: (tc.input ?? {}) as Record<string, unknown>,
          }));
          logger.info("Queueing extra bridge calls for sequential drain", {
            emitted: bridgeCall.toolName,
            queued: deferred.map((tc) => tc.toolName),
          });
        }
        yield workspaceCommand(
          bridgeCall.toolName,
          normalizeBridgeArgs(
            bridgeCall.toolName,
            (bridgeCall.input ?? {}) as Record<string, unknown>,
          ),
          bridgeExtraState,
        );
        return;
      }

      // --- Skill round-trip ---
      const skillCall = lastStep?.toolCalls.find((tc) => tc.toolName === "get_skill_content");
      if (skillCall) {
        const skillParsed = getSkillContentSchema.safeParse(skillCall.input);
        if (!skillParsed.success) {
          const issue = skillParsed.error.issues[0];
          const issuePath = issue.path.join(".") || "(root)";
          const errMsg = `get_skill_content arguments invalid at ${issuePath}: ${issue.message}. Expected shape: { slug: string, reason?: string }.`;
          logger.warn(`get_skill_content input rejected by schema: ${errMsg}`);
          const status = formatToolInputRejectedStatus("get_skill_content", skillCall.input, issue.message);
          yield reasoningStep(status.message, status.eventType ?? "WARNING", status.details);
          yield messageChunk(errMsg);
          return;
        }
        const { slug, reason } = skillParsed.data;
        loadedSkillSlugs.add(slug);
        for (const ev of sink.flushTail()) yield ev;
        yield* emitPendingArtifactsBeforeExit();
        yield getSkillContent(slug, reason, await buildContinuationExtraState());
        return;
      }

      // --- Widget data round-trip ---
      const widgetCall = lastStep?.toolCalls.find((tc) => tc.toolName === "get_widget_data");
      if (!widgetCall) {
        // No round-trip — final answer. Text already streamed live; flush the
        // held tail + any un-woven artifact, then extract the <suggestions>
        // block the sink held back.
        for (const ev of sink.flushTail()) yield ev;
        const { cleanTail, suggestions } = sink.takeSuggestions();
        if (cleanTail) yield streamingMessageChunk(cleanTail);
        const terminalToolStop =
          !sink.textEmitted &&
          cleanTail.length === 0 &&
          !answerArtifactEmitted &&
          !createArtifactReasoningEmitted &&
          completedToolNames.length > 0;
        if (terminalToolStop) {
          const toolNames = completedToolNames;
          logger.warn("Model stopped after tool calls without final text or round-trip", {
            loopIdx,
            toolNames,
          });
          yield messageChunk(
            `I ran ${toolNames.map((name) => `\`${name}\``).join(", ")}, but the model stopped before composing a final answer.`,
          );
          yield reasoningStep(
            "Model stopped after tool output without a follow-up action.",
            "WARNING",
            { tool_calls: toolNames },
          );
        }
        const all = await buildAllCitations(citedWidgets, mcpCitations, intermediateCitations);
        const shouldEmitCitations = all.length > 0 && !terminalToolStop;
        logger.info(
          `Citations emission citedWidgets=${citedWidgets.size} mcp=${mcpCitations.length} intermediate=${intermediateCitations.length} totalAfterDedup=${all.length} willEmit=${shouldEmitCitations}`,
          {
            citedWidgetsSize: citedWidgets.size,
            mcpCitsCount: mcpCitations.length,
            intermediateCount: intermediateCitations.length,
            totalAfterDedup: all.length,
            suppressedForTerminalToolStop: terminalToolStop,
          },
        );
        if (shouldEmitCitations) yield citationCollection({ citations: all });
        // Spike sources from the tool capture; prod ("inline") from the parsed
        // <suggestions> block. Same SSE either way — zero frontend change.
        const finalSuggestions = suggestionsVia === "tool" ? capturedSuggestions : suggestions;
        if (promptSuggestionsEnabled && finalSuggestions.length > 0) {
          yield promptSuggestions(finalSuggestions);
        }
        return;
      }

      const parsed = widgetDataSchema.safeParse(widgetCall.input);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const issuePath = issue.path.join(".") || "(root)";
        const errMsg = `get_widget_data arguments invalid at ${issuePath}: ${issue.message}. Expected shape: { widgets: [{ widget_uuid: string, input_args?: object }] }.`;
        const statusMsg = `${issuePath}: ${issue.message}`;
        logger.warn(`get_widget_data input rejected by schema: ${errMsg}`);
        const status = formatToolInputRejectedStatus("get_widget_data", widgetCall.input, statusMsg);
        yield reasoningStep(status.message, status.eventType ?? "WARNING", status.details);
        yield messageChunk(errMsg);
        return;
      }
      const { widgets: widgetRequests } = parsed.data;
      const requestedUuidsStr = widgetRequests.map((r) => r.widget_uuid).join(", ");
      logger.info(
        `Widget data requested count=${widgetRequests.length} uuids=[${requestedUuidsStr}]`,
        { count: widgetRequests.length, requestedUuids: widgetRequests.map((r) => r.widget_uuid) },
      );

      const cachedItems: WidgetItem[] = [];
      const uncachedFetches: ResolvedWidgetFetch[] = [];
      const { fetches, unmatched } = resolveWidgetFetches(
        widgetRequests,
        allWidgets,
        dashboardNameByUuid,
      );
      logUnmatchedWidgets(unmatched, allWidgets);

      const seenFetchKeys = new Set<string>();
      for (const fetch of fetches) {
        const key = widgetCacheKey(fetch.request.widget_uuid, fetch.cacheInputArgs);
        if (seenFetchKeys.has(key)) continue;
        seenFetchKeys.add(key);
        const cached = getCachedItems(fetch.request.widget_uuid, fetch.cacheInputArgs);
        if (cached) {
          cachedItems.push(...cached);
        } else {
          uncachedFetches.push(fetch);
        }
      }

      if (cachedItems.length > 0) {
        const knownTables = new Set(tables.map((table) => table.tableName));
        injectWidgetData(cachedItems, ctx);
        const newTables = tables.filter((table) => !knownTables.has(table.tableName));
        const statuses = formatWidgetDataLoadedStatuses(cachedItems, newTables, {
          cached: true,
          tableRows: ctx.pendingTables,
        });
        for (const status of statuses) {
          yield reasoningStep(status.message, status.eventType ?? "INFO", status.details, status.artifacts);
        }
      }

      if (uncachedFetches.length > 0) {
        for (const ev of sink.flushTail()) yield ev;
        if (yield* emitNextWidgetFetch(uncachedFetches)) return;
        continue;
      }

      if (fetches.length === 0) {
        logger.warn("No matching widgets found for request");
        for (const ev of sink.flushTail()) yield ev;
        if (!sink.textEmitted) yield messageChunk("I couldn't find the requested widgets.");
        return;
      }

      // All cached — re-loop with injected data
      logger.info("All widgets resolved from cache", { count: widgetRequests.length });
      messages.push({
        role: "user" as const,
        content:
          "The requested widget data is already loaded and has been injected above. " +
          "Do not call get_widget_data again for the same widgets. Use execute_sql, peek_table, create_artifact, or answer from the loaded tables now.",
      });
      suppressWidgetDataToolForCachedRetry = true;
      continue;
    }

    logger.warn("Agent loop exhausted without producing a final answer", {
      loopCount,
      totalStepCount,
    });
    yield reasoningStep(
      "Stopped after repeated tool planning without a final answer.",
      "WARNING",
      { loop_count: loopCount, step_count: totalStepCount },
    );
    yield messageChunk(
      "I loaded the available data, but the model kept requesting widget data instead of composing an answer.",
    );

  } finally {
    // No request-scoped resources to release: in-process SQLite is gone
    // (compute lives in the MCP server's per-conversation Daytona sandbox).
  }
}

// Cache widget items extracted during a re-POST so they can be reused without round-tripping
export async function cacheWidgetItemsFromReboot(
  toolMsg: ToolMessage,
  allWidgets: Widget[],
): Promise<WidgetItem[]> {
  const items = await extractWidgetItems(toolMsg, allWidgets);
  const queries = (toolMsg.input_arguments?.data_sources as Array<{
    widget_uuid: string;
    input_args?: Record<string, unknown>;
    ssm_request?: { query?: string };
  }>) ?? [];
  for (let i = 0; i < items.length; i++) {
    const query = queries[i];
    const widget = items[i].widget ?? allWidgets.find((w) => w.uuid === items[i].uuid);
    const inputArgs =
      typeof query?.ssm_request?.query === "string"
        ? { query: query.ssm_request.query }
        : widget
          ? effectiveWidgetInputArgs(widget, query?.input_args)
          : query?.input_args;
    cacheWidgetItems(items[i].uuid, inputArgs, [items[i]]);
  }
  return items;
}
