import { Hono } from "hono";
import { z } from "zod";
import type { QueryRequest, ToolMessage, WorkspaceState } from "../protocol/types";
import { sseResponse } from "../protocol/stream";
import { getTieredWidgets } from "../widgets/tiers";
import { resolveModel } from "../lib/providers";
import { getLogger } from "../lib/logger";
import { runAgentLoop, cacheWidgetItemsFromReboot } from "../agent/loop";
import { WORKSPACE_BRIDGE_COMMAND_NAMES } from "../protocol/bridge-commands";

const logger = getLogger(["app", "routes", "query"]);

const QueryRequestSchema = z.object({
  messages: z.array(z.unknown()).min(1),
  model: z.string().optional(),
  widgets: z
    .object({
      primary: z.array(z.unknown()).optional(),
      secondary: z.array(z.unknown()).optional(),
      extra: z.array(z.unknown()).optional(),
    })
    .optional(),
  context: z.unknown().optional(),
  urls: z.array(z.string()).optional(),
  timezone: z.string().optional(),
  workspace_state: z.unknown().optional(),
  workspace_options: z.record(z.string(), z.union([z.boolean(), z.string()])).optional(),
  skills_catalog: z
    .array(z.object({ slug: z.string(), description: z.string(), updatedAt: z.string().optional() }))
    .optional(),
  selected_skills: z
    .array(z.object({
      slug: z.string(),
      description: z.string(),
      contentMarkdown: z.string(),
      source: z.enum(["forced_slash", "model_selected"]),
    }))
    .optional(),
  tools: z
    .array(z.object({
      name: z.string(),
      server_id: z.string(),
      url: z.string(),
      description: z.string().optional(),
      input_schema: z.object({
        properties: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
        required: z.array(z.string()).optional(),
      }).optional(),
    }))
    .optional(),
  documents: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        format: z.enum(["pdf", "docx", "txt", "md", "html"]),
        content_b64: z.string().optional(),
        url: z.string().optional(),
      }).refine((d) => !!d.content_b64 || !!d.url, {
        message: "Document must have either content_b64 or url",
      }),
    )
    .optional(),
});

const WorkspaceStateSchema = z.object({
  current_page_context: z.string(),
  current_dashboard_uuid: z.string().optional(),
  current_dashboard_info: z.object({
    id: z.string(),
    name: z.string().optional(),
    current_tab_id: z.string(),
    tabs: z.array(z.object({
      tab_id: z.string(),
      widgets: z.array(z.object({
        widget_uuid: z.string(),
        name: z.string().optional(),
      })).optional(),
    })).optional(),
  }).nullish(),
  action_history: z.array(z.string()).optional(),
  extra_widgets_slim: z.boolean().optional(),
}).passthrough();

function parseWorkspaceState(raw: unknown): WorkspaceState | null {
  const result = WorkspaceStateSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export const queryRouter = new Hono();

queryRouter.post("/v1/query", async (c) => {
  const raw = await c.req.json();
  const parsed = QueryRequestSchema.safeParse(raw);
  if (!parsed.success) {
    logger.error("Invalid request", { issues: parsed.error.issues });
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }
  const body = raw as QueryRequest;

  const lastMessage = body.messages.at(-1);
  const tieredWidgets = getTieredWidgets(body);
  const allWidgets = tieredWidgets.map((t) => t.widget);
  const opts = (raw.workspace_options ?? {}) as Record<string, boolean | string>;
  const hasOption = (key: string): boolean => Boolean(opts[key]);
  const getOption = (key: string): string | undefined => {
    const v = opts[key];
    return typeof v === "string" ? v : undefined;
  };

  const rawModelId = getOption("model") || process.env.DEFAULT_MODEL || "openai:gpt-4o";
  const model = resolveModel(rawModelId);
  const workspaceState = parseWorkspaceState(body.workspace_state);
  const generativeUiEnabled = hasOption("generative-ui")
    && workspaceState?.current_page_context === "dashboard";
  const clientSqlEnabled = hasOption("client-sql");
  // Set by the workspace only when the agent declares widget-global-search AND
  // the user has the toggle on — i.e. the agent may reach connected widgets that
  // are not on the current dashboard.
  const globalSearchEnabled = hasOption("widget-global-search");
  logger.info("workspace_options flags", {
    clientSqlEnabled,
    globalSearchEnabled,
    generativeUiEnabled: hasOption("generative-ui"),
    optionKeys: Object.keys(opts),
  });

  // Pre-cache widget data from re-POST so the agent can re-fetch from cache if needed
  if (lastMessage?.role === "tool") {
    const toolMsg = lastMessage as ToolMessage;
    if (
      toolMsg.function !== "get_skill_content" &&
      toolMsg.function !== "execute_agent_tool" &&
      toolMsg.function !== "get_params_options" &&
      toolMsg.function !== "execute_client_sql" &&
      !WORKSPACE_BRIDGE_COMMAND_NAMES.has(toolMsg.function)
    ) {
      await cacheWidgetItemsFromReboot(toolMsg, allWidgets);
    }
  }

  // X-Trace-Id is the workspace-managed per-chat identifier (set in
  // useGetCopilotRequestHeaders.tsx). We use it as conversation_id for
  // compute-MCP sandbox keying. Stable across re-POSTs in the same chat.
  // Header lookups are case-insensitive in Hono — try both casings to be safe.
  const conversationId =
    c.req.header("X-Trace-Id") ?? c.req.header("x-trace-id") ?? "";

  // Snapshot the inbound header keys once so we can confirm what the workspace
  // is actually sending. Helpful when X-Trace-Id arrives under a name we
  // didn't expect.
  const headerKeys = Object.keys(c.req.header() ?? {});
  const roles = body.messages.map((m) => m.role);
  // Surface where the model came from: body.model (workspace picker) wins over
  // DEFAULT_MODEL (server fallback) over the hardcoded default. Makes "why this
  // model" answerable from one log line.
  const optionsModel = getOption("model");
  const modelSource = optionsModel
    ? "workspace_options.model"
    : process.env.DEFAULT_MODEL
      ? "env.DEFAULT_MODEL"
      : "hardcoded-default";
  logger.info(
    `Query received conversationId=${conversationId || "(MISSING)"} model=${rawModelId} (via ${modelSource}; workspace_options.model=${optionsModel ?? "(none)"} env.DEFAULT_MODEL=${process.env.DEFAULT_MODEL ?? "(none)"}) widgets=${allWidgets.length} mcpTools=${(body.tools ?? []).length}`,
    {
      model: rawModelId,
      modelSource,
      optionsModel: optionsModel ?? null,
      defaultModelEnv: process.env.DEFAULT_MODEL ?? null,
      roles,
      widgetCount: allWidgets.length,
      mcpToolCount: (body.tools ?? []).length,
      conversationId: conversationId || "(missing)",
      headerKeys,
    },
  );

  const promptSuggestionsEnabled = hasOption("prompt-suggestions");

  return sseResponse(
    runAgentLoop({
      request: body,
      rawModelId,
      model,
      allWidgets,
      tieredWidgets,
      workspaceState,
      generativeUiEnabled,
      clientSqlEnabled,
      globalSearchEnabled,
      promptSuggestionsEnabled,
      conversationId,
    }),
  );
});
