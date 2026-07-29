import { join } from "node:path";
import { Hono } from "hono";
import { allModels } from "../lib/providers";
import { getLogger } from "../lib/logger";

const logger = getLogger(["app", "routes", "agents"]);

export const agentsRouter = new Hono();

agentsRouter.get("/", (c) => {
  return c.text("Agent Rita");
});

agentsRouter.get("/rita.png", () => {
  const file = Bun.file(join(import.meta.dir, "../assets/AgentRitaAvatar.png"));
  return new Response(file, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
    },
  });
});

agentsRouter.get("/agents.json", (c) => {
  logger.debug("Agent descriptor requested");

  const models = allModels();
  const defaultModel = process.env.DEFAULT_MODEL || models[0]?.id || "openai:gpt-4o";

  return c.json({
    openbb_agent_rita: {
      name: "Agent Rita",
      description:
        "An open-source, model-agnostic agent for the OpenBB Workspace",
      image: "/rita.png",
      endpoints: { query: "/v1/query" },
      features: {
        streaming: true,
        "widget-dashboard-select": true,
        "widget-dashboard-search": true,
        "widget-global-search": true,
        "mcp-tools": true,
        "generative-ui": true,
        "file-upload": true,
        "prompt-suggestions": {
          label: "Follow-up Suggestions",
          default: true,
          description: "Show follow-up prompt suggestions after each response.",
        },
        "client-sql": {
          label: "Client-side SQL",
          default: true,
          description:
            "Query widget data with DuckDB in your browser instead of sending every row to the agent. With Global data on, also loads connected widgets on demand.",
        },
        "model": {
          label: "Model",
          type: "select",
          default: defaultModel,
          description: "Select the LLM model to use.",
          options: models.map((m) => ({ label: m.name, value: m.id })),
        },
      },
    },
  });
});
