/**
 * `enhance_prompt` — refines a vague user query into a more specific,
 * answerable one. Wraps the standalone `/v1/enhance_prompt` route's logic in a
 * loop-callable tool so the model can decide mid-conversation that it needs a
 * sharper question before searching widgets or fetching data.
 *
 * State-free aside from the closed-over LLM helper; counts as cheap +
 * local-execute per CLAUDE.md rules.
 */

import { tool } from "ai";
import { z } from "zod";
import { singleShotLlm } from "../../lib/llm";
import { getLogger } from "../../lib/logger";

const logger = getLogger(["app", "tools", "enhance_prompt"]);

export const enhancePromptSchema = z.object({
  reasoning: z
    .string()
    .describe(
      "Why the original query needs sharpening (missing entity, vague scope, ambiguous metric, etc.)",
    ),
  query: z
    .string()
    .describe("The raw user query to enhance."),
});

export const enhancePromptDescription =
  "Refine a vague or under-specified user query into a more precise question that is easier to answer. " +
  "Call this only when the original wording is genuinely ambiguous — DO NOT use it to paraphrase a clear question. " +
  "Returns the enhanced query as plain text for you to act on.";

export type EnhancePromptArgs = z.infer<typeof enhancePromptSchema>;

export async function runEnhancePrompt(args: EnhancePromptArgs): Promise<string> {
  const startedAt = Date.now();
  logger.info("enhance_prompt entry", {
    reasoning: args.reasoning.slice(0, 200),
    queryLength: args.query.length,
  });
  const prompt =
    "You are a query-rewriting helper for a financial assistant. " +
    "Rewrite the user's query into a clearer, more specific version that retains their intent. " +
    "Do not invent entities, dates, or constraints the user did not provide. " +
    "Return ONLY the rewritten query, no commentary.\n\n" +
    `Original query: ${args.query}\n` +
    `Why it needs sharpening: ${args.reasoning}\n\n` +
    "Enhanced query:";
  const enhanced = await singleShotLlm(prompt, { maxTokens: 256, functionId: "tool.enhance-prompt" });
  logger.info("enhance_prompt exit", {
    ms: Date.now() - startedAt,
    chars: enhanced.length,
  });
  return enhanced;
}

export function makeEnhancePromptTool() {
  return tool({
    description: enhancePromptDescription,
    inputSchema: enhancePromptSchema,
    execute: async (args) => runEnhancePrompt(args as EnhancePromptArgs),
  });
}
