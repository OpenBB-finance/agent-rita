import { z } from "zod";
import type { LanguageModelUsage } from "ai";
import type { SSEEvent } from "../protocol/types";

/**
 * Token counts for one or more model calls.
 *
 * `cachedInputTokens` and `cacheWriteTokens` are SUBSETS of `inputTokens`, not
 * additions to it — every provider reports prompt-cache reads as a slice of
 * the prompt it already billed. Treating them as separate would double-count
 * both the token total and the cost.
 */
export interface UsageCounts {
  inputTokens: number;
  /** Input tokens served from the provider's prompt cache (subset of `inputTokens`). */
  cachedInputTokens: number;
  /** Input tokens written INTO an explicit cache (Anthropic-style; subset of `inputTokens`). */
  cacheWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export const ZERO_USAGE_COUNTS: UsageCounts = Object.freeze({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
});

export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
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
  /**
   * Price for input tokens served from the prompt cache. Omitted where the
   * provider publishes no cache discount (Groq) — cost then falls back to the
   * full input rate, which OVER-reports rather than under-reports. That
   * direction is deliberate: a cost number that quietly understates the bill
   * is worse than one that is visibly pessimistic.
   */
  cachedInputPer1M?: number;
  /**
   * Price for tokens written into an explicit cache. Only Anthropic bills this
   * separately (at a premium over base input); everywhere else cache writes are
   * ordinary input tokens, so omitting this falls back to `inputPer1M`.
   */
  cacheWritePer1M?: number;
}

/**
 * NOTE ON RATES: the cached rates below are derived by applying each provider's
 * published cache discount to this table's own input price (OpenAI 4o 0.5x,
 * 4.1 0.25x, GPT-5 family 0.1x; Anthropic 0.1x read / 1.25x write; Gemini
 * 0.25x; DeepSeek 0.1x). Both the base and the cached numbers need an audit
 * against the provider pricing pages before anything user-facing is built on
 * them — this table drives log and telemetry estimates only.
 */
const MODEL_PRICING: Record<string, PricingEntry> = {
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10.0, cachedInputPer1M: 1.25 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6, cachedInputPer1M: 0.075 },
  "gpt-4.1": { inputPer1M: 2.0, outputPer1M: 8.0, cachedInputPer1M: 0.5 },
  "gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6, cachedInputPer1M: 0.1 },
  "gpt-4.1-nano": { inputPer1M: 0.1, outputPer1M: 0.4, cachedInputPer1M: 0.025 },
  "gpt-5": { inputPer1M: 2.0, outputPer1M: 8.0, cachedInputPer1M: 0.2 },
  "gpt-5-mini": { inputPer1M: 0.4, outputPer1M: 1.6, cachedInputPer1M: 0.04 },
  "gpt-5-nano": { inputPer1M: 0.1, outputPer1M: 0.4, cachedInputPer1M: 0.01 },
  "gpt-5.1": { inputPer1M: 2.0, outputPer1M: 8.0, cachedInputPer1M: 0.2 },
  "gpt-5.2": { inputPer1M: 2.0, outputPer1M: 8.0, cachedInputPer1M: 0.2 },
  "gpt-5.2-pro": { inputPer1M: 10.0, outputPer1M: 40.0, cachedInputPer1M: 1.0 },
  "gpt-5.4": { inputPer1M: 2.0, outputPer1M: 8.0, cachedInputPer1M: 0.2 },
  "gpt-5.4-mini": { inputPer1M: 0.4, outputPer1M: 1.6, cachedInputPer1M: 0.04 },
  "gpt-5.4-nano": { inputPer1M: 0.1, outputPer1M: 0.4, cachedInputPer1M: 0.01 },
  "gpt-5.4-pro": { inputPer1M: 10.0, outputPer1M: 40.0, cachedInputPer1M: 1.0 },
  "anthropic/claude-sonnet-4.6": {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cachedInputPer1M: 0.3,
    cacheWritePer1M: 3.75,
  },
  "google/gemini-3-flash-preview": {
    inputPer1M: 0.075,
    outputPer1M: 0.3,
    cachedInputPer1M: 0.01875,
  },
  "google/gemini-3.1-pro-preview": {
    inputPer1M: 1.25,
    outputPer1M: 10.0,
    cachedInputPer1M: 0.3125,
  },
  "deepseek/deepseek-v3.2": { inputPer1M: 0.27, outputPer1M: 1.1, cachedInputPer1M: 0.027 },
  // Groq publishes no prompt-cache discount — the omission of cachedInputPer1M
  // on these four is deliberate, not an oversight.
  "llama-3.3-70b-versatile": { inputPer1M: 0.59, outputPer1M: 0.79 },
  "llama-3.1-8b-instant": { inputPer1M: 0.05, outputPer1M: 0.08 },
  "meta-llama/llama-4-scout-17b-16e-instruct": { inputPer1M: 0.11, outputPer1M: 0.34 },
  "meta-llama/llama-4-maverick-17b-128e-instruct": { inputPer1M: 0.5, outputPer1M: 0.77 },
};

/**
 * Normalize one call's usage into `UsageCounts`.
 *
 * Cache reads come from `inputTokenDetails.cacheReadTokens`, falling back to
 * the deprecated flat `cachedInputTokens` so a provider adapter that has not
 * moved to the detailed shape still reports hits instead of silent zeros.
 *
 * Both cache figures are clamped into `inputTokens`. A provider reporting more
 * cached tokens than prompt tokens is a bug on their side, but left unclamped
 * it produces a hit rate above 100% and a negative uncached cost term.
 */
export function flattenUsage(usage: LanguageModelUsage): UsageCounts {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const details = usage.inputTokenDetails;
  const rawRead = details?.cacheReadTokens ?? usage.cachedInputTokens ?? 0;
  const rawWrite = details?.cacheWriteTokens ?? 0;
  const cachedInputTokens = Math.max(0, Math.min(rawRead, input));
  const cacheWriteTokens = Math.max(0, Math.min(rawWrite, input - cachedInputTokens));
  return {
    inputTokens: input,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens: output,
    totalTokens: input + output,
  };
}

export function accumulateUsage(acc: UsageCounts, next: UsageCounts): UsageCounts {
  return {
    inputTokens: acc.inputTokens + next.inputTokens,
    cachedInputTokens: acc.cachedInputTokens + next.cachedInputTokens,
    cacheWriteTokens: acc.cacheWriteTokens + next.cacheWriteTokens,
    outputTokens: acc.outputTokens + next.outputTokens,
    totalTokens: acc.totalTokens + next.totalTokens,
  };
}

/**
 * Share of input tokens served from the prompt cache, 0..1.
 *
 * This is the number that says whether the system-prompt prefix is holding: a
 * multi-step turn re-sends the same system-prompt-plus-tools prefix on every
 * step and every re-POST, so a healthy turn trends toward 1 as it goes. A rate
 * that collapses mid-turn means something in `buildSystemPrompt` changed
 * between calls and invalidated the prefix.
 *
 * Returns 0 rather than NaN for a turn with no input tokens, so the value is
 * always safe to hand to a span attribute.
 */
export function cacheHitRate(usage: {
  inputTokens: number;
  cachedInputTokens: number;
}): number {
  if (usage.inputTokens <= 0) return 0;
  return Number((usage.cachedInputTokens / usage.inputTokens).toFixed(4));
}

/**
 * Token usage for a whole logical turn — i.e. summed across every re-POST the
 * round-trip protocol produced, not just the current request. Rides
 * `extra_state.turn_usage` so it survives the browser hop.
 *
 * Input tokens grow on each re-POST because `buildMessages` re-renders the
 * conversation (including earlier tool results) every time. The turn total is
 * therefore the sum of a growing series, which is what you actually pay and
 * what per-request logging structurally hides. Cached input is what makes that
 * growth affordable, so it rides along: the raw turn total reads far more
 * alarming than the invoice once a warm cache is serving most of the prefix.
 */
export interface TurnUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
  postCount: number;
}

export const ZERO_TURN_USAGE: TurnUsage = Object.freeze({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  postCount: 0,
});

/**
 * Cache fields default to 0 rather than being required: a turn already in
 * flight when this deploy lands echoes the older four-field shape, and
 * rejecting it would zero a running turn's counter mid-conversation.
 */
const TurnUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
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

/**
 * Cost in USD, billing cached reads and cache writes at their own rates.
 *
 * Cached and written tokens are carved OUT of the uncached input term because
 * the provider counts them inside `inputTokens`. Charging the full input rate
 * across the board — which this did before cache accounting existed —
 * overstates a cache-warm multi-step turn by roughly the discount, which on
 * the GPT-5 family is most of the bill.
 */
export function estimateCost(
  modelId: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
  },
): number | null {
  const bare = modelId.includes(":") ? modelId.split(":").slice(1).join(":") : modelId;
  const pricing = MODEL_PRICING[bare];
  if (!pricing) return null;

  const cachedTokens = Math.max(0, Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens));
  const writtenTokens = Math.max(
    0,
    Math.min(usage.cacheWriteTokens ?? 0, usage.inputTokens - cachedTokens),
  );
  const uncachedTokens = usage.inputTokens - cachedTokens - writtenTokens;

  const cachedRate = pricing.cachedInputPer1M ?? pricing.inputPer1M;
  const writeRate = pricing.cacheWritePer1M ?? pricing.inputPer1M;

  const cost =
    (uncachedTokens / 1_000_000) * pricing.inputPer1M +
    (cachedTokens / 1_000_000) * cachedRate +
    (writtenTokens / 1_000_000) * writeRate +
    (usage.outputTokens / 1_000_000) * pricing.outputPer1M;
  return Number(cost.toFixed(6));
}

export function usageHiddenEvent(usage: TokenUsage): SSEEvent {
  const hitRate = cacheHitRate(usage);
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
        { label: "Cached input tokens", value: usage.cachedInputTokens },
        { label: "Cache hit rate", value: `${(hitRate * 100).toFixed(1)}%` },
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
