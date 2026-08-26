/**
 * Tier 2 — turn-level tracing across re-POSTs.
 *
 * A logical turn is N HTTP POSTs, not one: every round-trip ends the generator
 * and the browser re-POSTs. These tests pin the two things that make the turn
 * observable anyway — the traceparent that keeps all N requests in one trace,
 * and the token total that would otherwise die with each generator.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { runAgentLoop } from "../../../src/agent/loop";
import { parseTraceparent } from "../../../src/lib/telemetry";
import type { TurnUsage } from "../../../src/lib/token-usage";
import type { QueryRequest, SSEEvent, ToolMessage } from "../../../src/protocol/types";
import {
  llmCallsTool,
  llmEmitsText,
  makeMockLlm,
  makeSpyMockLlm,
  type SpyMockLlm,
} from "../../helpers/mock-llm";
import { collectGenerator } from "../../helpers/sse-reader";
import { clearAllModuleState } from "../../helpers/clear-state";

const exporter = new InMemorySpanExporter();
let provider: BasicTracerProvider | undefined;

// Registered once for the file, not per test: the OTel global is process-wide,
// and tearing it down between tests leaves the API unable to re-register.
// initTelemetry() is deliberately bypassed — it is env-gated, so going through
// it would make these tests depend on process env.
beforeAll(() => {
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider?.shutdown();
  // Restore the no-op global. bun runs test files in one process, and leaving
  // a recording provider registered would put a `traceparent` into extra_state
  // for every later test file — including the ones that pin its verbatim shape.
  trace.disable();
});

beforeEach(() => {
  clearAllModuleState();
  exporter.reset();
});

interface ExtraState {
  traceparent?: string;
  turn_usage?: TurnUsage;
  timezone?: string;
}

function bridgeExtraState(events: SSEEvent[]): ExtraState {
  const fc = events.find((e) => e.event === "copilotFunctionCall");
  expect(fc).toBeDefined();
  return (fc!.data as { extra_state?: ExtraState }).extra_state ?? {};
}

/** A turn's first request: the model fires a bridge command, so we round-trip. */
function firstRequest(conversationId: string) {
  return runAgentLoop({
    request: {
      messages: [{ role: "human", content: "make me tabs" }],
      workspace_options: ["generative-ui"],
    } as unknown as QueryRequest,
    rawModelId: "openai:gpt-4o-mini",
    model: makeMockLlm(
      llmCallsTool("manage_navigation_bar", {
        operation: "create" as const,
        tabs: [{ name: "AAPL Analysis" }],
      }),
    ),
    allWidgets: [],
    workspaceState: null,
    generativeUiEnabled: true,
    conversationId,
  });
}

/** The browser's re-POST: the bridge result plus whatever extra_state we echoed. */
function rePost(conversationId: string, extraState: Record<string, unknown>) {
  const toolMsg: ToolMessage = {
    role: "tool",
    function: "manage_navigation_bar",
    input_arguments: {},
    extra_state: extraState,
    data: [
      { ok: true, command: "manage_navigation_bar", request_id: null, message: "Tabs created." },
    ] as unknown as ToolMessage["data"],
  };
  return runAgentLoop({
    request: {
      messages: [{ role: "human", content: "make me tabs" }, toolMsg],
      workspace_options: ["generative-ui"],
    } as unknown as QueryRequest,
    rawModelId: "openai:gpt-4o-mini",
    model: makeMockLlm(llmEmitsText("Done — tabs created.")),
    allWidgets: [],
    workspaceState: null,
    generativeUiEnabled: true,
    conversationId,
  });
}

/**
 * A re-POST whose model fires ANOTHER bridge call, so the request emits its
 * own extra_state — the only way to observe what a middle request propagates
 * onward to the rest of the turn.
 */
function rePostWithBridgeCall(conversationId: string, extraState: Record<string, unknown>) {
  const toolMsg: ToolMessage = {
    role: "tool",
    function: "manage_navigation_bar",
    input_arguments: {},
    extra_state: extraState,
    data: [
      { ok: true, command: "manage_navigation_bar", request_id: null, message: "Tabs created." },
    ] as unknown as ToolMessage["data"],
  };
  return runAgentLoop({
    request: {
      messages: [{ role: "human", content: "make me tabs" }, toolMsg],
      workspace_options: ["generative-ui"],
    } as unknown as QueryRequest,
    rawModelId: "openai:gpt-4o-mini",
    model: makeMockLlm(
      llmCallsTool("manage_navigation_bar", {
        operation: "create" as const,
        tabs: [{ name: "Second Tab" }],
      }),
    ),
    allWidgets: [],
    workspaceState: null,
    generativeUiEnabled: true,
    conversationId,
  });
}

function turnSpans() {
  return exporter.getFinishedSpans().filter((s) => s.name === "rita.turn.request");
}

describe("turn tracing across re-POSTs", () => {
  it("emits one span per request, and the first request's span is a trace root", async () => {
    await collectGenerator(firstRequest("t-root"));
    const spans = turnSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].parentSpanContext).toBeUndefined();
  });

  it("echoes a traceparent pointing at the first request's own span", async () => {
    const events = await collectGenerator(firstRequest("t-echo"));
    const { traceparent } = bridgeExtraState(events);
    const span = turnSpans()[0];
    expect(traceparent).toBe(
      `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`,
    );
  });

  it("puts the re-POST in the SAME trace as the first request", async () => {
    const first = await collectGenerator(firstRequest("t-join"));
    const echoed = bridgeExtraState(first);
    exporter.reset();

    await collectGenerator(rePost("t-join", { traceparent: echoed.traceparent }));

    const second = turnSpans()[0];
    const firstCtx = echoed.traceparent!.split("-");
    expect(second.spanContext().traceId).toBe(firstCtx[1]);
    expect(second.parentSpanContext?.spanId).toBe(firstCtx[2]);
  });

  it("keeps every later request a direct CHILD of the first — not nested one level deeper each time", async () => {
    // A queued-bridge-call drain can re-POST 19 times. Parenting each request
    // to the previous one would bury the last span 19 levels deep.
    const first = await collectGenerator(firstRequest("t-flat"));
    const rootTraceparent = bridgeExtraState(first).traceparent!;

    // A middle request must echo the ROOT's traceparent onward unchanged —
    // asserted unconditionally, because a guarded assertion here would pass
    // vacuously the moment the emission stopped happening.
    const middle = await collectGenerator(
      rePostWithBridgeCall("t-flat", { traceparent: rootTraceparent }),
    );
    expect(bridgeExtraState(middle).traceparent).toBe(rootTraceparent);

    await collectGenerator(rePost("t-flat", { traceparent: rootTraceparent }));
    const spans = turnSpans();
    const rootSpanId = rootTraceparent.split("-")[2];
    for (const s of spans.slice(1)) {
      expect(s.parentSpanContext?.spanId).toBe(rootSpanId);
    }
  });

  it("records the turn's token total on the span, not just the request's", async () => {
    const first = await collectGenerator(firstRequest("t-usage-span"));
    const echoed = bridgeExtraState(first);
    exporter.reset();

    await collectGenerator(
      rePost("t-usage-span", {
        traceparent: echoed.traceparent,
        turn_usage: echoed.turn_usage,
      }),
    );

    const attrs = turnSpans()[0].attributes;
    expect(attrs["rita.usage.turn.post_count"]).toBe(2);
    // Mock LLM reports 1 in / 1 out per call: 2 tokens per request, 4 for the turn.
    expect(attrs["rita.usage.turn.total_tokens"]).toBe(4);
    expect(attrs["rita.conversation_id"]).toBe("t-usage-span");
  });

  it("tags the turn span with the standard session.id attribute", async () => {
    // `session.id` is OTel semconv, not a vendor key — but it is also what
    // Langfuse reads to group a chat's turns into one session. Emitting the
    // standard name gets that grouping without coupling to a backend.
    await collectGenerator(firstRequest("chat-abc"));
    expect(turnSpans()[0].attributes["session.id"]).toBe("chat-abc");
  });

  it("omits session.id entirely when there is no conversation id", async () => {
    // A placeholder like "(missing)" would collapse every anonymous turn from
    // every user into one bogus shared session — worse than no grouping.
    await collectGenerator(firstRequest(""));
    expect(turnSpans()[0].attributes).not.toHaveProperty("session.id");
    expect(turnSpans()[0].attributes["rita.conversation_id"]).toBe("(missing)");
  });

  it("ends the span even when the request exits early through a round-trip return", async () => {
    // Every round-trip leaves runAgentLoop via `return`, not by running off the
    // end — an end() outside `finally` would leak a span on exactly these.
    await collectGenerator(firstRequest("t-early-exit"));
    expect(turnSpans()).toHaveLength(1);
    expect(turnSpans()[0].ended).toBe(true);
  });
});

describe("turn tracing — untrusted echoed state", () => {
  it("accumulates token usage across requests", async () => {
    const first = await collectGenerator(firstRequest("t-usage"));
    const afterFirst = bridgeExtraState(first).turn_usage;
    expect(afterFirst).toEqual({
      inputTokens: 1,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1,
      totalTokens: 2,
      postCount: 1,
    });
  });

  it.each([
    ["a malformed traceparent", "not-a-traceparent"],
    ["an all-zero trace id", "00-00000000000000000000000000000000-00f067aa0ba902b7-01"],
    ["a non-string", 42],
    ["a header-injection attempt", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01\r\nX: 1"],
  ])("starts a fresh trace (and does not throw) given %s", async (_label, bad) => {
    const events = await collectGenerator(
      rePost("t-bad", { traceparent: bad as unknown as string }),
    );
    expect(events.length).toBeGreaterThan(0);
    const span = turnSpans()[0];
    expect(span).toBeDefined();
    expect(span.parentSpanContext).toBeUndefined();
  });

  it("does not propagate a traceparent it refused to parse", async () => {
    // Otherwise the two derivations of "what is the turn root" disagree: the
    // span parents to nothing (correct) while the corrupt string keeps riding
    // extra_state, so every later request in the turn also fails to parse it
    // and starts its own trace. The turn shatters and never recovers, even
    // though this request had a perfectly good span context to offer instead.
    const events = await collectGenerator(
      rePostWithBridgeCall("t-poison", { traceparent: "garbage-not-a-traceparent" }),
    );
    const echoed = bridgeExtraState(events).traceparent;
    expect(echoed).not.toBe("garbage-not-a-traceparent");
    // It must offer this request's own span so the REST of the turn can stitch.
    expect(parseTraceparent(echoed)).not.toBeNull();
    expect(echoed).toBe(
      `00-${turnSpans()[0].spanContext().traceId}-${turnSpans()[0].spanContext().spanId}-01`,
    );
  });

  it("resets a corrupted turn_usage to zero instead of failing the turn", async () => {
    const events = await collectGenerator(
      rePost("t-bad-usage", {
        turn_usage: { inputTokens: -5, outputTokens: "x", totalTokens: null, postCount: 3 },
      }),
    );
    expect(events.length).toBeGreaterThan(0);
    expect(turnSpans()[0].attributes["rita.usage.turn.post_count"]).toBe(1);
  });
});

/**
 * The prompt-cache regression, end to end.
 *
 * The Workspace sends `timezone` on the first POST of a turn and not on the
 * bridge re-POST. `buildDateSection` appended its "User timezone" line only
 * when it had a value, so the system prompt alternated between two byte
 * strings across a turn's POSTs — measured against a live OpenAI trace on
 * 2026-08-19 as 21960 vs 21928 bytes, identical for the first 99.9%, each
 * variant maintaining its own prompt-cache lineage.
 */
describe("turn tracing — timezone carries across the round-trip", () => {
  const TZ = "America/New_York";

  function systemPromptOf(spy: SpyMockLlm): string {
    const msgs = spy.calls[0]?.messages as Array<{ role: string; content: unknown }>;
    expect(msgs?.[0]?.role).toBe("system");
    const content = msgs[0].content;
    return typeof content === "string" ? content : JSON.stringify(content);
  }

  function firstPost(spy: SpyMockLlm, timezone?: string) {
    return runAgentLoop({
      request: {
        messages: [{ role: "human", content: "make me tabs" }],
        workspace_options: ["generative-ui"],
        ...(timezone ? { timezone } : {}),
      } as unknown as QueryRequest,
      rawModelId: "openai:gpt-4o-mini",
      model: spy.model,
      allWidgets: [],
      workspaceState: null,
      generativeUiEnabled: true,
      conversationId: "t-tz",
    });
  }

  /** The browser's re-POST: carries no `timezone`, only the echoed extra_state. */
  function bridgeRePost(spy: SpyMockLlm, extraState: Record<string, unknown>) {
    const toolMsg: ToolMessage = {
      role: "tool",
      function: "manage_navigation_bar",
      input_arguments: {},
      extra_state: extraState,
      data: [
        { ok: true, command: "manage_navigation_bar", request_id: null, message: "Tabs created." },
      ] as unknown as ToolMessage["data"],
    };
    return runAgentLoop({
      request: {
        messages: [{ role: "human", content: "make me tabs" }, toolMsg],
        workspace_options: ["generative-ui"],
      } as unknown as QueryRequest,
      rawModelId: "openai:gpt-4o-mini",
      model: spy.model,
      allWidgets: [],
      workspaceState: null,
      generativeUiEnabled: true,
      conversationId: "t-tz",
    });
  }

  it("echoes the timezone forward on every round-trip emission", async () => {
    const spy = makeSpyMockLlm(
      llmCallsTool("manage_navigation_bar", {
        operation: "create" as const,
        tabs: [{ name: "AAPL Analysis" }],
      }),
    );
    const events = await collectGenerator(firstPost(spy, TZ));
    expect(bridgeExtraState(events).timezone).toBe(TZ);
  });

  it("keeps the system prompt byte-identical across the round-trip", async () => {
    const firstSpy = makeSpyMockLlm(
      llmCallsTool("manage_navigation_bar", {
        operation: "create" as const,
        tabs: [{ name: "AAPL Analysis" }],
      }),
    );
    const first = await collectGenerator(firstPost(firstSpy, TZ));

    const secondSpy = makeSpyMockLlm(llmEmitsText("Done — tabs created."));
    await collectGenerator(
      bridgeRePost(secondSpy, bridgeExtraState(first) as Record<string, unknown>),
    );

    expect(systemPromptOf(secondSpy)).toBe(systemPromptOf(firstSpy));
  });

  // The correctness half: without the echo the re-POST fell back to UTC, which
  // is the wrong calendar day for a user west of Greenwich late in their day.
  it("renders the re-POST date in the user's zone, not UTC", async () => {
    const firstSpy = makeSpyMockLlm(
      llmCallsTool("manage_navigation_bar", {
        operation: "create" as const,
        tabs: [{ name: "AAPL Analysis" }],
      }),
    );
    const first = await collectGenerator(firstPost(firstSpy, TZ));

    const secondSpy = makeSpyMockLlm(llmEmitsText("Done."));
    await collectGenerator(
      bridgeRePost(secondSpy, bridgeExtraState(first) as Record<string, unknown>),
    );

    expect(systemPromptOf(secondSpy)).toContain(`User timezone: ${TZ}`);
    expect(systemPromptOf(secondSpy)).not.toContain("User timezone: UTC");
  });

  // A turn that never had a timezone must still produce ONE stable prompt.
  it("stays stable across the round-trip when no timezone is ever supplied", async () => {
    const firstSpy = makeSpyMockLlm(
      llmCallsTool("manage_navigation_bar", {
        operation: "create" as const,
        tabs: [{ name: "AAPL Analysis" }],
      }),
    );
    const first = await collectGenerator(firstPost(firstSpy));

    const secondSpy = makeSpyMockLlm(llmEmitsText("Done."));
    await collectGenerator(
      bridgeRePost(secondSpy, bridgeExtraState(first) as Record<string, unknown>),
    );

    expect(systemPromptOf(secondSpy)).toBe(systemPromptOf(firstSpy));
    expect(systemPromptOf(secondSpy)).toContain("User timezone: UTC");
  });

  // extra_state round-trips through the browser and is untrusted.
  it("falls back to UTC on a corrupted echoed timezone instead of failing the turn", async () => {
    const spy = makeSpyMockLlm(llmEmitsText("Done."));
    const events = await collectGenerator(bridgeRePost(spy, { timezone: "Not/AZone" }));
    expect(events.length).toBeGreaterThan(0);
    expect(systemPromptOf(spy)).toContain("User timezone: UTC");
  });
});
