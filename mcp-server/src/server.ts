import "./lib/logger";
import { honoLogger, getLogger } from "./lib/logger";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import {
  webSearchSchema,
  webSearchHandler,
  webSearchDescription,
} from "./tools/backend/web-search";
import {
  takoSearchSchema,
  takoSearchHandler,
  takoSearchDescription,
} from "./tools/backend/tako/search";
import {
  takoAnswerSchema,
  takoAnswerHandler,
  takoAnswerDescription,
} from "./tools/backend/tako/answer";
import {
  takoAvailableDataSchema,
  takoAvailableDataHandler,
  takoAvailableDataDescription,
} from "./tools/backend/tako/available-data";
import {
  takoContentsSchema,
  takoContentsHandler,
  takoContentsDescription,
} from "./tools/backend/tako/contents";
import { isTakoEnabled, isTakoAuthed } from "./tools/backend/tako/client";
import {
  fetchWebpageSchema,
  fetchWebpageHandler,
  fetchWebpageDescription,
} from "./tools/backend/fetch-webpage";
import {
  mermaidSchema,
  mermaidHandler,
  mermaidDescription,
  mermaidRenderingAvailable,
} from "./tools/backend/mermaid";
import {
  executeCodeSchema,
  executeCodeHandler,
  executeCodeDescription,
} from "./tools/backend/compute/execute-code";
import {
  queryDocumentsSchema,
  queryDocumentsHandler,
  queryDocumentsDescription,
} from "./tools/backend/documents/query-documents";
import {
  listDocumentsSchema,
  listDocumentsHandler,
  listDocumentsDescription,
} from "./tools/backend/documents/list-documents";
import { mountBridgeRoutes } from "./bridge/routes";
import { bridgeManager } from "./bridge/singleton";
import { registerWorkspacePrompts } from "./prompts/workspace";
import { registerAppBuilderResources } from "./resources/app-builder";
import {
  getWorkspaceSnapshotSchema,
  getWorkspaceSnapshotHandler,
  getWorkspaceSnapshotDescription,
} from "./tools/workspace/get-workspace-snapshot";
import {
  listAvailableWidgetsSchema,
  listAvailableWidgetsHandler,
  listAvailableWidgetsDescription,
} from "./tools/workspace/list-available-widgets";
import {
  getWidgetSchemaSchema,
  getWidgetSchemaHandler,
  getWidgetSchemaDescription,
} from "./tools/workspace/get-widget-schema";
import {
  readWidgetSchema,
  readWidgetHandler,
  readWidgetDescription,
} from "./tools/workspace/read-widget";
import {
  deleteWidgetSchema,
  deleteWidgetHandler,
  deleteWidgetDescription,
} from "./tools/workspace/delete-widget";
import {
  manageDashboardSchema,
  manageDashboardHandler,
  manageDashboardDescription,
} from "./tools/workspace/manage-dashboard";
import {
  navigateWorkspaceSchema,
  navigateWorkspaceHandler,
  navigateWorkspaceDescription,
} from "./tools/workspace/navigate-workspace";
import {
  manageNavigationBarSchema,
  manageNavigationBarHandler,
  manageNavigationBarDescription,
} from "./tools/workspace/manage-navigation-bar";
import {
  createWidgetSchema,
  createWidgetHandler,
  createWidgetDescription,
} from "./tools/workspace/create-widget";
import {
  updateWidgetSchema,
  updateWidgetHandler,
  updateWidgetDescription,
} from "./tools/workspace/update-widget";
import {
  updateWidgetLayoutSchema,
  updateWidgetLayoutHandler,
  updateWidgetLayoutDescription,
} from "./tools/workspace/update-widget-layout";
import {
  addGenerativeWidgetSchema,
  addGenerativeWidgetHandler,
  addGenerativeWidgetDescription,
} from "./tools/workspace/add-generative-widget";
import {
  getWidgetDataSchema,
  getWidgetDataHandler,
  getWidgetDataDescription,
} from "./tools/workspace/get-widget-data";
import {
  getParamsOptionsSchema,
  getParamsOptionsHandler,
  getParamsOptionsDescription,
} from "./tools/workspace/get-params-options";
import {
  assignTasksToAgentsSchema,
  assignTasksToAgentsHandler,
  assignTasksToAgentsDescription,
} from "./tools/workspace/assign-tasks-to-agents";
import {
  getSkillContentSchema,
  getSkillContentHandler,
  getSkillContentDescription,
} from "./tools/workspace/get-skill-content";
import {
  manageBackendsSchema,
  manageBackendsHandler,
  manageBackendsDescription,
} from "./tools/workspace/manage-backends";
import {
  manageAppsSchema,
  manageAppsHandler,
  manageAppsDescription,
} from "./tools/workspace/manage-apps";

const mcp = new McpServer({
  name: "rita-tools",
  version: "1.0.0",
});

mcp.tool("fetch_webpage", fetchWebpageDescription, fetchWebpageSchema, fetchWebpageHandler);

// Compute tools — Daytona-backed Python + DuckDB sandbox per conversation.
// Registered only when DAYTONA_API_KEY is present; otherwise the agent
// surfaces a clear "compute unavailable" path.
const logger = getLogger(["mcp", "server"]);

// Tako — live financial/macro/traffic data + web search via Tako's hosted
// MCP endpoint. Keyless connections ride the anonymous free tier;
// TAKO_API_TOKEN unlocks account limits + tako_contents. Because the free
// tier makes Tako always available, Tavily web_search registers only when
// Tako is explicitly disabled (TAKO_ENABLED=false) — a config-level
// registration conditional, not content routing.
const takoEnabled = isTakoEnabled();
const takoAuthed = isTakoAuthed();
if (takoEnabled) {
  mcp.tool("tako_search", takoSearchDescription, takoSearchSchema, takoSearchHandler);
  mcp.tool("tako_answer", takoAnswerDescription, takoAnswerSchema, takoAnswerHandler);
  mcp.tool(
    "tako_available_data",
    takoAvailableDataDescription,
    takoAvailableDataSchema,
    takoAvailableDataHandler,
  );
  if (takoAuthed) {
    mcp.tool("tako_contents", takoContentsDescription, takoContentsSchema, takoContentsHandler);
  } else {
    logger.info("TAKO_API_TOKEN not set — tako_contents disabled, free tier active");
  }
} else {
  mcp.tool("web_search", webSearchDescription, webSearchSchema, webSearchHandler);
  logger.warn("TAKO_ENABLED=false — Tako tools disabled, Tavily web_search registered instead");
}

// Mermaid — rendered server-side to SVG via Playwright Chromium. Registered
// only when the browser binary is installed; otherwise the tool would fail
// on every call and must not be advertised to the model.
const mermaidEnabled = mermaidRenderingAvailable();
if (mermaidEnabled) {
  mcp.tool("mermaid_diagram", mermaidDescription, mermaidSchema, mermaidHandler);
} else {
  logger.warn(
    "Playwright Chromium not installed — mermaid_diagram disabled (run `bunx playwright install chromium`)",
  );
}

// Read-widget-data SQL family lives in the agent now (in-process,
// closure on pendingTables). It's no longer registered here.

// Code execution — Daytona Python sandbox per conversation. Slow first
// call (sandbox cold start + pip install). Only used when the model needs
// Python (statistics, scipy/numpy, plotly, custom transformations).
const codeExecEnabled = !!process.env.DAYTONA_API_KEY;
if (codeExecEnabled) {
  mcp.tool("execute_code", executeCodeDescription, executeCodeSchema, executeCodeHandler);
} else {
  logger.warn("DAYTONA_API_KEY not set — execute_code disabled (SQL family still works)");
}

// Document RAG — uploaded PDF/DOCX/TXT/MD search via per-conversation
// vector store. Requires OPENAI_API_KEY for embeddings (text-embedding-3-
// small by default). Tools register unconditionally; first call without a
// key surfaces a clear error from the embedding API.
const docRagEnabled = !!process.env.OPENAI_API_KEY;
if (docRagEnabled) {
  mcp.tool(
    "query_documents",
    queryDocumentsDescription,
    queryDocumentsSchema,
    queryDocumentsHandler,
  );
  mcp.tool(
    "list_documents",
    listDocumentsDescription,
    listDocumentsSchema,
    listDocumentsHandler,
  );
} else {
  logger.warn(
    "OPENAI_API_KEY not set — query_documents/list_documents disabled (embeddings unavailable)",
  );
}

// Workspace bridge (companion) tools — require an OpenBB Workspace browser
// tab connected to /bridge/ws. Behind COMPANION_TOOLS_ENABLED (default off)
// so a plain backend-tools deployment doesn't advertise 18 tools that need
// a connected browser. Prompts and app-builder resources only describe
// these tools, so they're gated together.
const companionToolsEnabled = process.env.COMPANION_TOOLS_ENABLED === "true";
if (companionToolsEnabled) {
  mcp.tool(
    "get_workspace_snapshot",
    getWorkspaceSnapshotDescription,
    getWorkspaceSnapshotSchema,
    getWorkspaceSnapshotHandler,
  );
  mcp.tool(
    "list_available_widgets",
    listAvailableWidgetsDescription,
    listAvailableWidgetsSchema,
    listAvailableWidgetsHandler,
  );
  mcp.tool(
    "get_widget_schema",
    getWidgetSchemaDescription,
    getWidgetSchemaSchema,
    getWidgetSchemaHandler,
  );
  mcp.tool("read_widget", readWidgetDescription, readWidgetSchema, readWidgetHandler);
  mcp.tool("delete_widget", deleteWidgetDescription, deleteWidgetSchema, deleteWidgetHandler);
  mcp.tool(
    "manage_dashboard",
    manageDashboardDescription,
    manageDashboardSchema,
    manageDashboardHandler,
  );
  mcp.tool(
    "navigate_workspace",
    navigateWorkspaceDescription,
    navigateWorkspaceSchema,
    navigateWorkspaceHandler,
  );
  mcp.tool(
    "manage_navigation_bar",
    manageNavigationBarDescription,
    manageNavigationBarSchema,
    manageNavigationBarHandler,
  );
  mcp.tool(
    "create_widget",
    createWidgetDescription,
    createWidgetSchema,
    createWidgetHandler,
  );
  mcp.tool(
    "update_widget",
    updateWidgetDescription,
    updateWidgetSchema,
    updateWidgetHandler,
  );
  mcp.tool(
    "update_widget_layout",
    updateWidgetLayoutDescription,
    updateWidgetLayoutSchema,
    updateWidgetLayoutHandler,
  );
  mcp.tool(
    "add_generative_widget",
    addGenerativeWidgetDescription,
    addGenerativeWidgetSchema,
    addGenerativeWidgetHandler,
  );
  mcp.tool(
    "get_widget_data",
    getWidgetDataDescription,
    getWidgetDataSchema,
    getWidgetDataHandler,
  );
  mcp.tool(
    "get_params_options",
    getParamsOptionsDescription,
    getParamsOptionsSchema,
    getParamsOptionsHandler,
  );
  mcp.tool(
    "assign_tasks_to_agents",
    assignTasksToAgentsDescription,
    assignTasksToAgentsSchema,
    assignTasksToAgentsHandler,
  );
  mcp.tool(
    "get_skill_content",
    getSkillContentDescription,
    getSkillContentSchema,
    getSkillContentHandler,
  );
  mcp.tool(
    "manage_backends",
    manageBackendsDescription,
    manageBackendsSchema,
    manageBackendsHandler,
  );
  mcp.tool(
    "manage_apps",
    manageAppsDescription,
    manageAppsSchema,
    manageAppsHandler,
  );

  // Workspace MCP prompts (workspace_tool_usage + workspace_session_context).
  registerWorkspacePrompts(mcp);

  // App-builder MCP resources (16 markdown documents under openbb://workspace/*).
  await registerAppBuilderResources(mcp);
} else {
  logger.warn(
    "COMPANION_TOOLS_ENABLED not set to 'true' — workspace bridge tools, prompts, and app-builder resources disabled",
  );
}

const app = new Hono();

app.use("*", honoLogger);

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Accept",
      "Authorization",
      "mcp-session-id",
      "mcp-protocol-version",
      "last-event-id",
      "x-openbb-user",
    ],
    exposeHeaders: ["mcp-session-id"],
  }),
);

const transport = new StreamableHTTPTransport();
await mcp.connect(transport);

app.all("/mcp", (c) => transport.handleRequest(c));

const { websocket } = mountBridgeRoutes(app, bridgeManager);

app.get("/", (c) =>
  c.json({
    name: "rita-mcp-tools",
    version: "1.0.0",
    endpoint: "/mcp",
    bridge_endpoints: {
      session_start: "/bridge/session/start",
      websocket: "/bridge/ws",
      health: "/bridge/health",
    },
    tools: {
      backend: [
        ...(takoEnabled
          ? [
              "tako_search",
              "tako_answer",
              "tako_available_data",
              ...(takoAuthed ? ["tako_contents"] : []),
            ]
          : ["web_search"]),
        "fetch_webpage",
        ...(mermaidEnabled ? ["mermaid_diagram"] : []),
        ...(codeExecEnabled ? ["execute_code"] : []),
        ...(docRagEnabled ? ["query_documents", "list_documents"] : []),
      ],
      workspace: companionToolsEnabled
        ? [
            "get_workspace_snapshot",
            "list_available_widgets",
            "get_widget_schema",
            "read_widget",
            "delete_widget",
            "manage_dashboard",
            "navigate_workspace",
            "manage_navigation_bar",
            "create_widget",
            "update_widget",
            "update_widget_layout",
            "add_generative_widget",
            "get_widget_data",
            "get_params_options",
            "assign_tasks_to_agents",
            "get_skill_content",
            "manage_backends",
            "manage_apps",
          ]
        : [],
    },
    code_execution_enabled: codeExecEnabled,
    companion_tools_enabled: companionToolsEnabled,
    prompts: companionToolsEnabled
      ? ["workspace_tool_usage", "workspace_session_context"]
      : [],
    resources: companionToolsEnabled
      ? { app_builder: { count: 16, uri_prefix: "openbb://workspace/" } }
      : {},
  }),
);

const PORT = Number(process.env.MCP_PORT ?? 8787);

export default {
  fetch: app.fetch,
  port: PORT,
  idleTimeout: 255,
  websocket,
};

logger.info(
  `MCP server starting port=${PORT} codeExecEnabled=${codeExecEnabled} takoEnabled=${takoEnabled} takoAuthed=${takoAuthed} docRagEnabled=${docRagEnabled} mermaidEnabled=${mermaidEnabled} companionToolsEnabled=${companionToolsEnabled} bridgeMounted=true`,
);
