import { Hono } from "hono";
import { z } from "zod";
import { singleShotLlm } from "../../lib/llm";
import { getLogger } from "../../lib/logger";

const logger = getLogger(["app", "generate", "dashboard-title"]);

const DashboardTitleSchema = z.object({
  widgets: z.array(z.object({
    uuid: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    metadata: z.unknown().optional(),
  })).min(1),
  model: z.string().optional(),
});

export const dashboardTitleRouter = new Hono();

dashboardTitleRouter.post("/v1/generate/dashboard/title", async (c) => {
  const raw = await c.req.json();
  const parsed = DashboardTitleSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  const { widgets, model } = parsed.data;
  const names = widgets.map((w) => w.name).filter(Boolean).slice(0, 20);

  if (names.length === 0) return c.text("My Dashboard");

  const prompt =
    "Generate a short dashboard name (2-5 words) based on these widgets. " +
    "Return ONLY the name, no quotes, no JSON.\n\n" +
    `Widgets: ${names.join(", ")}`;

  try {
    const title = await singleShotLlm(prompt, { model, functionId: "generate.dashboard-title" });
    const cleaned = title.replace(/^["']|["']$/g, "");
    logger.info("dashboard/title generated", { title: cleaned });
    return c.text(cleaned);
  } catch (err) {
    logger.warn("dashboard/title failed", { error: err instanceof Error ? err.message : String(err) });
    return c.text("My Dashboard");
  }
});
