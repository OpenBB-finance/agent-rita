import { z } from "zod";
import type { LanguageModelUsage } from "ai";
import type { SSEEvent } from "../protocol/types";

export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative().nullable(),
  modelId: z.string(),
  loopCount: z.number().int().nonnegative(),
  stepCount: z.number().int().nonnegative(),
});

export type TokenUsage = z.infer<typeof TokenUsageSchema>;

interface PricingEntry {
  inputPer1M: number;
  outputPer1M: number;
}

const MODEL_PRICING: Record<string, PricingEntry> = {
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10.0 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4.1": { inputPer1M: 2.0, outputPer1M: 8.0 },
  "gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6 },
  "gpt-4.1-nano": { inputPer1M: 0.1, outputPer1M: 0.4 },
  "gpt-5": { inputPer1M: 2.0, outputPer1M: 8.0 },
  "gpt-5-mini": { inputPer1M: 0.4, outputPer1M: 1.6 },
  "gpt-5-nano": { inputPer1M: 0.1, outputPer1M: 0.4 },
  "gpt-5.1": { inputPer1M: 2.0, outputPer1M: 8.0 },
  "gpt-5.2": { inputPer1M: 2.0, outputPer1M: 8.0 },
  "gpt-5.2-pro": { inputPer1M: 10.0, outputPer1M: 40.0 },
  "gpt-5.4": { inputPer1M: 2.0, outputPer1M: 8.0 },
  "gpt-5.4-mini": { inputPer1M: 0.4, outputPer1M: 1.6 },
  "gpt-5.4-nano": { inputPer1M: 0.1, outputPer1M: 0.4 },
  "gpt-5.4-pro": { inputPer1M: 10.0, outputPer1M: 40.0 },
  "anthropic/claude-sonnet-4.6": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "google/gemini-3-flash-preview": { inputPer1M: 0.075, outputPer1M: 0.3 },
  "google/gemini-3.1-pro-preview": { inputPer1M: 1.25, outputPer1M: 10.0 },
  "deepseek/deepseek-v3.2": { inputPer1M: 0.27, outputPer1M: 1.1 },
  "llama-3.3-70b-versatile": { inputPer1M: 0.59, outputPer1M: 0.79 },
  "llama-3.1-8b-instant": { inputPer1M: 0.05, outputPer1M: 0.08 },
  "meta-llama/llama-4-scout-17b-16e-instruct": { inputPer1M: 0.11, outputPer1M: 0.34 },
  "meta-llama/llama-4-maverick-17b-128e-instruct": { inputPer1M: 0.5, outputPer1M: 0.77 },
};

export function flattenUsage(usage: LanguageModelUsage): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  return { inputTokens: input, outputTokens: output, totalTokens: input + output };
}

export function accumulateUsage(
  acc: { inputTokens: number; outputTokens: number; totalTokens: number },
  next: { inputTokens: number; outputTokens: number; totalTokens: number },
) {
  return {
    inputTokens: acc.inputTokens + next.inputTokens,
    outputTokens: acc.outputTokens + next.outputTokens,
    totalTokens: acc.totalTokens + next.totalTokens,
  };
}

/**
 * Token usage for a whole logical turn — i.e. summed across every re-POST the
 * round-trip protocol produced, not just the current request. Rides
 * `extra_state.turn_usage` so it survives the browser hop.
 *
 * Input tokens grow on each re-POST because `buildMessages` re-renders the
 * conversation (including earlier tool results) every time. The turn total is
 * therefore the sum of a growing series, which is what you actually pay and
 * what per-request logging structurally hides.
 */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  postCount: number;
}

export const ZERO_TURN_USAGE: TurnUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  postCount: 0,
});

const TurnUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  postCount: z.number().int().nonnegative(),
});

/**
 * Read the echoed turn total. Untrusted (browser-echoed) input: anything
 * malformed resets to zero rather than throwing, because a bad counter must
 * never cost the user their turn.
 */
export function readTurnUsage(raw: unknown): TurnUsage {
  const parsed = TurnUsageSchema.safeParse(raw);
  return parsed.success ? parsed.data : { ...ZERO_TURN_USAGE };
}

export function estimateCost(
  modelId: string,
  usage: { inputTokens: number; outputTokens: number },
): number | null {
  const bare = modelId.includes(":") ? modelId.split(":").slice(1).join(":") : modelId;
  const pricing = MODEL_PRICING[bare];
  if (!pricing) return null;
  const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputPer1M;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputPer1M;
  return Number((inputCost + outputCost).toFixed(6));
}

export function usageHiddenEvent(usage: TokenUsage): SSEEvent {
  return {
    event: "copilotStatusUpdate",
    data: {
      eventType: "INFO",
      message: "token_usage",
      group: "reasoning",
      hidden: true,
      details: [
        { label: "Model", value: usage.modelId },
        { label: "Input tokens", value: usage.inputTokens },
        { label: "Output tokens", value: usage.outputTokens },
        { label: "Total tokens", value: usage.totalTokens },
        { label: "Est. cost (USD)", value: usage.estimatedCostUsd != null ? `$${usage.estimatedCostUsd.toFixed(4)}` : "unknown" },
        { label: "Loop count", value: usage.loopCount },
        { label: "Step count", value: usage.stepCount },
      ],
    },
  };
}

export function usageVisibleEvent(usage: TokenUsage): SSEEvent {
  const costStr = usage.estimatedCostUsd != null ? ` (~$${usage.estimatedCostUsd.toFixed(4)})` : "";
  return {
    event: "copilotStatusUpdate",
    data: {
      eventType: "INFO",
      message: `Used ${usage.totalTokens.toLocaleString()} tokens${costStr}`,
      group: "reasoning",
    },
  };
}
