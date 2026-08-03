import type { CitationCollection, CopilotArtifact, SSEEvent, Widget } from "./types";

// Defensive strip of placeholder-tag patterns the model could hallucinate
// from training data. Rita's protocol does not use inline artifact tags
// (artifacts ride alongside on the SSE stream), so anything matching here
// is a leak — either a hallucinated tag or a future regression that
// introduces a placeholder protocol without sanitizing. Pattern is
// intentionally narrow (artifact/citation placeholders plus inline image tags)
// so prose like "the artifact" still passes through. Open and close tags both
// stripped where applicable.
// Three patterns: XML-style `<artifact>`, pipe-delimited marker pairs like
// `<|start_artifact_id|>uuid<|end_artifact_id|>`, and standalone pipe tags.
// (GPT models hallucinate the latter format). The tag-name lists are exported
// as the single source of truth: the streaming text sink (`text-sink.ts`)
// builds its incremental withhold-to-terminator detectors from the SAME names,
// so a new placeholder kind is added here once and both the bulk strip and the
// streaming strip pick it up.
export const PLACEHOLDER_TAG_NAMES = [
  "artifact_id", "artifact", "copilot_table", "rita_artifact",
  "citation_id", "citation", "chart", "suggestions", "suggestion",
] as const;
export const PAIRED_PIPE_PLACEHOLDER_NAMES = [
  "artifact_id", "artifact", "copilot_table", "citation_id", "citation",
] as const;

const PLACEHOLDER_TAG_PATTERN = new RegExp(
  `<\\/?(${PLACEHOLDER_TAG_NAMES.join("|")})\\b[^>]*>`,
  "gi",
);
const PAIRED_PIPE_PLACEHOLDER_PATTERN = new RegExp(
  `<\\|start_(${PAIRED_PIPE_PLACEHOLDER_NAMES.join("|")})\\|>[\\s\\S]*?<\\|end_\\1\\|>`,
  "gi",
);
const PIPE_PLACEHOLDER_PATTERN = new RegExp(
  `<\\|(start|end)_(${PAIRED_PIPE_PLACEHOLDER_NAMES.join("|")})\\|>`,
  "gi",
);
const DANGLING_SUGGESTION_TAG_FRAGMENT_PATTERN = /(?:suggestions?)+>/gi;
const INLINE_IMAGE_TAG_PATTERN = /<img\b[^>]*>/gi;
const MARKDOWN_DATA_IMAGE_PATTERN = /!\[[^\]]*]\(data:image\/[^)]*\)/gi;

export function stripPlaceholderTags(text: string): string {
  return text
    .replace(PAIRED_PIPE_PLACEHOLDER_PATTERN, "")
    .replace(PLACEHOLDER_TAG_PATTERN, "")
    .replace(PIPE_PLACEHOLDER_PATTERN, "")
    .replace(DANGLING_SUGGESTION_TAG_FRAGMENT_PATTERN, "")
    .replace(INLINE_IMAGE_TAG_PATTERN, "")
    .replace(MARKDOWN_DATA_IMAGE_PATTERN, "");
}

export function messageChunk(delta: string): SSEEvent {
  return {
    event: "copilotMessageChunk",
    data: { delta: stripPlaceholderTags(delta) },
  };
}

/**
 * Non-stripping message chunk for the streaming text sink. The sink is the
 * SOLE sanitizer on the streaming path: it has already run the placeholder
 * strip incrementally and extracted any `<suggestions>` block, so re-running
 * `stripPlaceholderTags` here would be wrong — the `(?:suggestions?)+>` dangling
 * pattern is not `<`-anchored and would delete legitimate prose mid-stream.
 * Static fallback strings keep `messageChunk`, which strips.
 */
export function streamingMessageChunk(delta: string): SSEEvent {
  return {
    event: "copilotMessageChunk",
    data: { delta },
  };
}

export function reasoningStep(
  message: string,
  eventType: "INFO" | "WARNING" | "ERROR" = "INFO",
  details?: Record<string, unknown> | Array<Record<string, unknown>> | string,
  artifacts?: CopilotArtifact[],
): SSEEvent {
  return {
    event: "copilotStatusUpdate",
    data: {
      eventType,
      message,
      group: "reasoning",
      ...(details != null ? { details: Array.isArray(details) ? details : [details] } : {}),
      ...(artifacts && artifacts.length > 0 ? { artifacts } : {}),
    },
  };
}

export function planningStep(
  message: string,
  eventType: "INFO" | "WARNING" | "ERROR" = "INFO",
  details?: Record<string, unknown> | Array<Record<string, unknown>> | string,
): SSEEvent {
  return {
    event: "copilotStatusUpdate",
    data: {
      eventType,
      message,
      group: "planning",
      ...(details != null ? { details: Array.isArray(details) ? details : [details] } : {}),
    },
  };
}

export function messageArtifact(artifact: CopilotArtifact): SSEEvent {
  return {
    event: "copilotMessageArtifact",
    data: artifact as unknown as Record<string, unknown>,
  };
}

export function getSkillContent(
  slug: string,
  reason?: string,
  extraState?: Record<string, unknown>,
): SSEEvent {
  return {
    event: "copilotFunctionCall",
    data: {
      function: "get_skill_content",
      input_arguments: { slug, ...(reason && { reason }) },
      ...(extraState && Object.keys(extraState).length > 0 ? { extra_state: extraState } : {}),
    },
  };
}

export function executeAgentTool(
  serverId: string,
  toolName: string,
  parameters: Record<string, unknown>,
  extraState?: Record<string, unknown>,
): SSEEvent {
  return {
    event: "copilotFunctionCall",
    data: {
      function: "execute_agent_tool",
      input_arguments: {
        server_id: serverId,
        tool_name: toolName,
        parameters,
      },
      ...(extraState && Object.keys(extraState).length > 0 ? { extra_state: extraState } : {}),
    },
  };
}

export function promptSuggestions(suggestions: string[]): SSEEvent {
  return {
    event: "copilotPromptSuggestions",
    data: { suggestions },
  };
}

/**
 * Extract follow-up suggestions from the model's final text and return the
 * cleaned text plus the parsed suggestions array. Non-greedy match so nested
 * tags don't confuse the parser. Returns the original text unchanged when no
 * suggestions block is found.
 */
export function parseSuggestions(text: string): { cleanText: string; suggestions: string[] } {
  const openMatch = /<suggestions\b[^>]*>/i.exec(text);
  if (!openMatch) return { cleanText: text, suggestions: [] };

  const blockStart = openMatch.index + openMatch[0].length;
  const rest = text.slice(blockStart);
  const closeMatch = /<\/suggestions>/i.exec(rest);
  const block = closeMatch ? rest.slice(0, closeMatch.index) : rest;
  const afterBlock = closeMatch ? rest.slice(closeMatch.index + closeMatch[0].length) : "";
  const cleanText = `${text.slice(0, openMatch.index)}${afterBlock}`.trimEnd();

  // If the enclosing block is malformed, fail closed: remove the whole
  // suggestions tail from visible text, but do not emit possibly-corrupted
  // prompt suggestions.
  if (!closeMatch) return { cleanText, suggestions: [] };

  const suggestions: string[] = [];
  const suggestionOpenCount = [...block.matchAll(/<suggestion\b[^>]*>/gi)].length;
  const suggestionCloseCount = [...block.matchAll(/<\/suggestion>/gi)].length;
  if (suggestionOpenCount !== suggestionCloseCount) {
    return { cleanText, suggestions: [] };
  }
  const consumed = block.replace(/<suggestion\b[^>]*>([\s\S]*?)<\/suggestion>/gi, (_full, body) => {
    const trimmed = String(body).trim();
    if (trimmed) suggestions.push(trimmed);
    return "";
  });
  if (consumed.trim()) {
    return { cleanText, suggestions: [] };
  }
  return { cleanText, suggestions };
}

export function citationCollection(collection: CitationCollection): SSEEvent {
  return {
    event: "copilotCitationCollection",
    data: collection as unknown as Record<string, unknown>,
  };
}

const SSRM_DEFAULTS = {
  startRow: 0,
  endRow: 10000,
  rowGroupCols: [],
  valueCols: [],
  pivotCols: [],
  pivotMode: false,
  groupKeys: [],
  filterModel: {},
  sortModel: [],
};

/**
 * Emit execute_client_sql for browser DuckDB-WASM execution.
 * `queries` shape matches the tool schema and terminalpro handler.
 */
export function executeClientSql(
  queries: Array<{
    sql: string;
    widget_uuids: string[];
    row_limit?: number;
  }>,
  extraState?: Record<string, unknown>,
): SSEEvent {
  return {
    event: "copilotFunctionCall",
    data: {
      function: "execute_client_sql",
      input_arguments: { queries },
      extra_state: {
        copilot_function_call_arguments: {
          summary: `Run ${queries.length} client SQL quer${queries.length === 1 ? "y" : "ies"}`,
        },
        ...(extraState ?? {}),
      },
    },
  };
}

/**
 * Emit prepare_client_sql_tables — workspace fetches the widgets, registers them
 * in DuckDB, and returns the resulting table schemas.
 */
export function prepareClientSqlTables(
  widgets: Array<{
    widget_uuid?: string;
    widget_id?: string;
    origin?: string;
    input_args?: Record<string, unknown>;
  }>,
  extraState?: Record<string, unknown>,
): SSEEvent {
  return {
    event: "copilotFunctionCall",
    data: {
      function: "prepare_client_sql_tables",
      input_arguments: { widgets },
      extra_state: {
        copilot_function_call_arguments: {
          summary: `Load ${widgets.length} widget${widgets.length === 1 ? "" : "s"} into DuckDB`,
        },
        ...(extraState ?? {}),
      },
    },
  };
}

export function getWidgetDataSsrm(
  widget: Widget,
  sql: string,
  artifactUuid?: string,
  extraState?: Record<string, unknown>,
): SSEEvent {
  return {
    event: "copilotFunctionCall",
    data: {
      function: "get_widget_data",
      input_arguments: {
        data_sources: [
          {
            widget_uuid: widget.uuid,
            origin: widget.origin,
            id: widget.widget_id,
            input_args: {},
            ssm_request: { ...SSRM_DEFAULTS, query: sql },
          },
        ],
      },
      extra_state: {
        copilot_function_call_arguments: {
          widget_queries: [{ widget_uuid: widget.uuid }],
        },
        sql_query: sql,
        ...(artifactUuid && { sql_artifact_uuid: artifactUuid }),
        ...(extraState ?? {}),
      },
    },
  };
}

export function getWidgetData(widgets: Widget[], extraState?: Record<string, unknown>): SSEEvent {
  return {
    event: "copilotFunctionCall",
    data: {
      function: "get_widget_data",
      input_arguments: {
        data_sources: widgets.map((w) => ({
          widget_uuid: w.uuid,
          origin: w.origin,
          id: w.widget_id,
          input_args: Object.fromEntries(
            w.params.map((p) => [p.name, p.current_value ?? p.default_value]),
          ),
        })),
      },
      extra_state: {
        copilot_function_call_arguments: {
          widget_queries: widgets.map((w) => ({ widget_uuid: w.uuid })),
        },
        ...(extraState ?? {}),
      },
    },
  };
}

/**
 * Generic native workspace-bridge function call, emitted verbatim: the
 * frontend routes `function` + `input_arguments` to its
 * `useWorkspaceBridgeCommandHandler`, which consumes the bridge command
 * shape directly (no per-command legacy renames).
 *
 * Mirrors the `copilot_function_call_arguments` echo the previous per-tool
 * helpers used so the frontend's existing `extra_state` reader keeps
 * working unchanged. Bridge ops round-trip — the browser re-POSTs the
 * command result — so `extraState` must carry the continuation keys from
 * `buildContinuationExtraState`.
 */
export function workspaceCommand(
  name: string,
  args: Record<string, unknown>,
  extraState?: Record<string, unknown>,
): SSEEvent {
  return {
    event: "copilotFunctionCall",
    data: {
      function: name,
      input_arguments: args,
      extra_state: {
        copilot_function_call_arguments: args,
        ...(extraState ?? {}),
      },
    },
  };
}
