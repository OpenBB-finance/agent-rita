import { Hono } from "hono";
import { z } from "zod";
import { singleShotLlm, truncate } from "../../lib/llm";
import { getLogger } from "../../lib/logger";

const logger = getLogger(["app", "generate", "chat-title"]);

const ChatTitleSchema = z.object({
  messages: z.array(z.unknown()).min(1),
  model: z.string().optional(),
});

export const chatTitleRouter = new Hono();

chatTitleRouter.post("/v1/generate/chat/title", async (c) => {
  const raw = await c.req.json();
  const parsed = ChatTitleSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  const { messages, model } = parsed.data;

  const userMessages = (messages as Array<{ role?: string; content?: string }>)
    .filter((m) => m.role === "human" && typeof m.content === "string")
    .slice(-5)
    .map((m) => truncate(m.content as string, 500));

  if (userMessages.length === 0) return c.json("New Chat");

  const prompt =
    "Generate a short chat title (3-6 words) that summarizes this conversation. " +
    "Return ONLY the title text, no quotes, no JSON, no explanation.\n\n" +
    "User messages:\n" +
    userMessages.map((m, i) => `${i + 1}. ${m}`).join("\n");

  try {
    const title = await singleShotLlm(prompt, { model, functionId: "generate.chat-title" });
    const cleaned = title.replace(/^["']|["']$/g, "");
    logger.info("chat/title generated", { title: cleaned });
    return c.json(cleaned);
  } catch (err) {
    logger.warn("chat/title failed", { error: err instanceof Error ? err.message : String(err) });
    return c.json("New Chat");
  }
});
