import { Hono } from "hono";
import { z } from "zod";
import { singleShotLlm, truncate } from "../../lib/llm";
import { getLogger } from "../../lib/logger";

const logger = getLogger(["app", "generate", "enhance-prompt"]);

const EnhancePromptSchema = z.object({
  messages: z.array(z.unknown()).min(1),
  widgets: z.unknown().optional(),
  context: z.unknown().optional(),
  urls: z.array(z.string()).optional(),
  workspace_state: z.unknown().optional(),
  workspace_options: z.record(z.string(), z.union([z.boolean(), z.string()])).optional(),
  timezone: z.string().optional(),
  tools: z.array(z.unknown()).optional(),
  model: z.string().optional(),
});

function extractWidgetNames(widgets: unknown): string[] {
  if (!widgets || typeof widgets !== "object") return [];
  const w = widgets as Record<string, unknown>;
  const names: string[] = [];
  for (const tier of ["primary", "secondary", "extra"]) {
    const arr = w[tier];
    if (Array.isArray(arr)) {
      for (const widget of arr) {
        if (widget && typeof widget === "object" && "name" in widget && typeof widget.name === "string") {
          names.push(widget.name);
        }
      }
    }
  }
  return names.slice(0, 30);
}

export const enhancePromptRouter = new Hono();

enhancePromptRouter.post("/v1/enhance_prompt", async (c) => {
  const raw = await c.req.json();
  const parsed = EnhancePromptSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  const { messages, widgets, model } = parsed.data;

  const lastHuman = (messages as Array<{ role?: string; content?: string }>)
    .filter((m) => m.role === "human" && typeof m.content === "string")
    .at(-1);

  if (!lastHuman?.content) return c.text("");

  const widgetNames = extractWidgetNames(widgets);
  const contextLine = widgetNames.length > 0
    ? `\nAvailable data sources: ${widgetNames.join(", ")}`
    : "";

  const prompt =
    "You are enhancing a query for a financial AI assistant. " +
    "Rewrite the query below to be more specific and actionable. " +
    "Do NOT change the user's intent. Return ONLY the enhanced prompt text, nothing else.\n" +
    contextLine +
    `\n\nOriginal query: ${lastHuman.content}`;

  try {
    const enhanced = await singleShotLlm(prompt, { model, functionId: "generate.enhance-prompt" });
    const cleaned = enhanced.replace(/^["']|["']$/g, "");
    logger.info("enhance_prompt done", { original: truncate(lastHuman.content, 100), enhanced: truncate(cleaned, 100) });
    return c.text(cleaned);
  } catch (err) {
    logger.warn("enhance_prompt failed", { error: err instanceof Error ? err.message : String(err) });
    return c.text(lastHuman.content);
  }
});
