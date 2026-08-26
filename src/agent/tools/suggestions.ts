/**
 * `suggest_followups` — SPIKE tool (measure, don't migrate).
 *
 * Records the 2-3 follow-up suggestions the model proposes. Registered ONLY
 * when `suggestionsVia === "tool"` (default is "inline", which keeps the trained
 * `<suggestions>` block path untouched). When registered, the loop emits the
 * captured list as the existing `copilotPromptSuggestions` SSE at final
 * dispatch — zero frontend change. The point of the spike is to measure how
 * reliably real models CALL this vs. the always-on inline block, before
 * committing to a full migration (which would also have to handle the
 * silent-drop-on-round-trip and unclosed-block edges — see the plan's Part C).
 *
 * Local `execute`, no round-trip, no `stopWhen` — like `_llm_think`. Suggestions
 * are a TERMINAL event, not an ordered artifact, so this records into a request
 * closure (the loop emits at the end) rather than pushing onto `artifactQueue`.
 */

import { tool } from "ai";
import { z } from "zod";
import { getLogger } from "../../lib/logger";

const logger = getLogger(["app", "tools", "suggest_followups"]);

export const suggestFollowupsSchema = z.object({
  suggestions: z
    .array(z.string().min(1).max(80))
    .min(1)
    .max(3)
    .describe(
      "2-3 short follow-up questions the user might ask next, written in the USER's voice as their " +
        "next message. If your final answer ended by asking the user something or offering options, " +
        "these ARE the answers to that question, one per option. Each under 80 characters and " +
        "answerable using the widgets and data sources listed in context — never suggest " +
        "questions that need data you don't have.",
    ),
});

export const suggestFollowupsDescription =
  "Provide 2-3 short follow-up questions the user might want to ask next, phrased as the user would " +
  "type them. Call once, at the END of your response, after the final answer. If that answer ended " +
  "with a question or a choice for the user, the suggestions must answer it. " +
  "Each suggestion must be answerable with the available widgets/data sources.";

export type SuggestFollowupsArgs = z.infer<typeof suggestFollowupsSchema>;

export interface SuggestFollowupsContext {
  /** Record the proposed suggestions; the loop emits them at final dispatch. */
  setSuggestions: (suggestions: string[]) => void;
}

export function makeSuggestionsTool(ctx: SuggestFollowupsContext) {
  return tool({
    description: suggestFollowupsDescription,
    inputSchema: suggestFollowupsSchema,
    execute: async (args) => {
      const { suggestions } = args as SuggestFollowupsArgs;
      ctx.setSuggestions(suggestions);
      logger.info("suggest_followups captured", { count: suggestions.length });
      return `Recorded ${suggestions.length} follow-up suggestion(s).`;
    },
  });
}
