import { Hono } from "hono";
import { z } from "zod";
import { singleShotLlm, parseJsonResponse } from "../../lib/llm";
import { getLogger } from "../../lib/logger";

const logger = getLogger(["app", "generate", "code"]);

const GenerateCodeSchema = z.object({
  widget_uuid: z.string(),
  user_prompt: z.string().min(1),
  current_code: z.string().nullish(),
  language: z.enum(["sql", "python"]),
  sql_schema: z.record(z.string(), z.unknown()).nullish(),
  data_sample: z.array(z.record(z.string(), z.unknown())).nullish(),
  model: z.string().optional(),
});

export const codeRouter = new Hono();

codeRouter.post("/v1/generate/code", async (c) => {
  const raw = await c.req.json();
  const parsed = GenerateCodeSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
  }

  const { user_prompt, language, current_code, sql_schema, data_sample, model } = parsed.data;

  let prompt =
    `Generate ${language} code based on the user's instruction. ` +
    "Return a JSON object:\n" +
    'On success: { "success": true, "generated_code": "..." }\n' +
    'On failure: { "success": false, "error_message": "..." }\n\n' +
    "Return ONLY valid JSON, no markdown fences.\n\n" +
    `Language: ${language}\n` +
    `Instruction: ${user_prompt}`;

  if (sql_schema) prompt += `\n\nSQL Schema:\n${JSON.stringify(sql_schema, null, 2)}`;
  if (data_sample && data_sample.length > 0) {
    prompt += `\n\nData sample (first ${Math.min(data_sample.length, 5)} rows):\n${JSON.stringify(data_sample.slice(0, 5), null, 2)}`;
  }
  if (current_code) prompt += `\n\nCurrent code to modify/improve:\n${current_code}`;

  const fallback = { success: false as const, error_message: "Code generation failed" };

  try {
    const text = await singleShotLlm(prompt, { model, maxTokens: 2048, functionId: "generate.code" });
    const result = parseJsonResponse(text, fallback);
    logger.info("code generated", { language, success: result.success });
    return c.json(result);
  } catch (err) {
    logger.warn("code generation failed", { error: err instanceof Error ? err.message : String(err) });
    return c.json(fallback);
  }
});
