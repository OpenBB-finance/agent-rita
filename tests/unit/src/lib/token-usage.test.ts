import { describe, it, expect } from "bun:test";
import {
  flattenUsage,
  accumulateUsage,
  estimateCost,
  TokenUsageSchema,
  usageHiddenEvent,
  usageVisibleEvent,
  readTurnUsage,
  ZERO_TURN_USAGE,
} from "../../../../src/lib/token-usage";
import type { LanguageModelUsage } from "ai";

describe("flattenUsage", () => {
  it("treats missing fields as 0 and computes total", () => {
    const out = flattenUsage({} as LanguageModelUsage);
    expect(out).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it("sums input + output regardless of provider's totalTokens", () => {
    const out = flattenUsage({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 999,
    } as LanguageModelUsage);
    expect(out).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  });
});

describe("accumulateUsage", () => {
  it("adds across both inputs", () => {
    expect(
      accumulateUsage(
        { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      ),
    ).toEqual({ inputTokens: 11, outputTokens: 22, totalTokens: 33 });
  });
});

describe("estimateCost", () => {
  it("returns null for unknown models", () => {
    expect(estimateCost("unknown", { inputTokens: 1000, outputTokens: 1000 })).toBeNull();
  });

  it("strips a provider prefix (everything before the first colon)", () => {
    expect(estimateCost("openai:gpt-4o-mini", { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(0.15);
  });

  it("computes (input/1M)*price + (output/1M)*price", () => {
    expect(
      estimateCost("gpt-4o", { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toBeCloseTo(2.5 + 10);
  });

  it("rounds to 6 decimal places", () => {
    const v = estimateCost("gpt-4o-mini", { inputTokens: 1, outputTokens: 1 });
    expect(typeof v).toBe("number");
    expect(String(v).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(6);
  });
});

describe("TokenUsageSchema", () => {
  it("rejects negative token counts", () => {
    expect(() =>
      TokenUsageSchema.parse({
        inputTokens: -1,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
        modelId: "x",
        loopCount: 0,
        stepCount: 0,
      }),
    ).toThrow();
  });

  it("accepts null estimatedCostUsd (unknown model)", () => {
    expect(
      TokenUsageSchema.parse({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: null,
        modelId: "unknown",
        loopCount: 1,
        stepCount: 2,
      }).estimatedCostUsd,
    ).toBeNull();
  });
});

describe("readTurnUsage", () => {
  it("returns zeros when absent (first POST of a turn)", () => {
    expect(readTurnUsage(undefined)).toEqual(ZERO_TURN_USAGE);
  });

  it("reads a well-formed echoed value", () => {
    expect(
      readTurnUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15, postCount: 2 }),
    ).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15, postCount: 2 });
  });

  // extra_state round-trips through the browser — every one of these is
  // reachable from the wire, and a throw here would kill the whole turn.
  it.each([
    ["null", null],
    ["a string", "12"],
    ["an array", [1, 2, 3]],
    ["a negative count", { inputTokens: -1, outputTokens: 0, totalTokens: 0, postCount: 1 }],
    ["a fractional count", { inputTokens: 1.5, outputTokens: 0, totalTokens: 0, postCount: 1 }],
    ["NaN", { inputTokens: NaN, outputTokens: 0, totalTokens: 0, postCount: 1 }],
    ["Infinity", { inputTokens: Infinity, outputTokens: 0, totalTokens: 0, postCount: 1 }],
    ["a missing field", { inputTokens: 1, outputTokens: 2 }],
    ["string-typed numbers", { inputTokens: "1", outputTokens: "2", totalTokens: "3", postCount: "1" }],
  ])("falls back to zeros for %s", (_label, input) => {
    expect(readTurnUsage(input)).toEqual(ZERO_TURN_USAGE);
  });

  it("never returns the same object twice (callers mutate their copy)", () => {
    expect(readTurnUsage(undefined)).not.toBe(readTurnUsage(undefined));
  });
});

describe("usageHiddenEvent / usageVisibleEvent", () => {
  const usage = {
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    estimatedCostUsd: 0.0123,
    modelId: "gpt-4o",
    loopCount: 1,
    stepCount: 2,
  };

  it("usageHiddenEvent flags hidden:true with details list", () => {
    const e = usageHiddenEvent(usage);
    expect(e.event).toBe("copilotStatusUpdate");
    const data = e.data as Record<string, unknown>;
    expect(data.hidden).toBe(true);
    const details = data.details as Array<{ label: string; value: unknown }>;
    expect(details.find((d) => d.label === "Model")?.value).toBe("gpt-4o");
    expect(details.find((d) => d.label === "Total tokens")?.value).toBe(150);
  });

  it("usageVisibleEvent renders a thousands-separated total + cost", () => {
    const e = usageVisibleEvent({ ...usage, totalTokens: 12345 });
    const data = e.data as Record<string, unknown>;
    expect(data.message).toContain("12,345");
    expect(data.message).toContain("$0.0123");
  });

  it("usageVisibleEvent omits cost suffix when estimatedCostUsd is null", () => {
    const e = usageVisibleEvent({ ...usage, estimatedCostUsd: null });
    expect((e.data as Record<string, unknown>).message).not.toContain("$");
  });
});
