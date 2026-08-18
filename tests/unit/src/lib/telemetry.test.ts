import { describe, it, expect } from "bun:test";
import {
  parseTraceparent,
  formatTraceparent,
  traceIdForLogs,
  aiTelemetry,
} from "../../../../src/lib/telemetry";

const VALID = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("parseTraceparent", () => {
  it("accepts a well-formed W3C traceparent", () => {
    const ctx = parseTraceparent(VALID);
    expect(ctx).not.toBeNull();
    expect(ctx!.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(ctx!.spanId).toBe("00f067aa0ba902b7");
    expect(ctx!.traceFlags).toBe(1);
  });

  it("marks the context remote so the SDK treats it as a parent from another process", () => {
    expect(parseTraceparent(VALID)!.isRemote).toBe(true);
  });

  it("parses the sampled flag as 0 when not set", () => {
    const ctx = parseTraceparent(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
    );
    expect(ctx!.traceFlags).toBe(0);
  });

  // extra_state round-trips through the browser, so every one of these is a
  // value an attacker (or a buggy frontend) can actually put on the wire.
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a non-string", 12345],
    ["empty", ""],
    ["too few segments", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7"],
    ["too many segments", `${VALID}-extra`],
    ["an unsupported version", "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"],
    ["version ff (forbidden by spec)", "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"],
    ["a short trace id", "00-4bf92f3577b34da6a-00f067aa0ba902b7-01"],
    ["a short span id", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa-01"],
    ["an all-zero trace id", "00-00000000000000000000000000000000-00f067aa0ba902b7-01"],
    ["an all-zero span id", "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01"],
    ["non-hex characters", "00-zzf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"],
    ["uppercase hex (spec requires lowercase)", "00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01"],
    ["whitespace padding", ` ${VALID} `],
    ["a header-injection attempt", `${VALID}\r\nX-Evil: 1`],
    ["an absurdly long string", "00-" + "a".repeat(10_000)],
  ])("rejects %s", (_label, input) => {
    expect(parseTraceparent(input)).toBeNull();
  });
});

describe("formatTraceparent", () => {
  it("round-trips through parseTraceparent", () => {
    const out = formatTraceparent({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: 1,
    });
    expect(out).toBe(VALID);
    expect(parseTraceparent(out)!.spanId).toBe("00f067aa0ba902b7");
  });

  it("returns null for an invalid (non-recording) span context", () => {
    expect(
      formatTraceparent({
        traceId: "00000000000000000000000000000000",
        spanId: "0000000000000000",
        traceFlags: 0,
      }),
    ).toBeNull();
  });
});

describe("traceIdForLogs", () => {
  it("returns the trace id when telemetry is recording", () => {
    expect(traceIdForLogs({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736" })).toBe(
      "4bf92f3577b34da6a3ce929d0e0e4736",
    );
  });

  it("returns undefined for the all-zero id a no-op tracer produces", () => {
    // Otherwise every log line in the default (telemetry-off) deployment
    // carries a meaningless 32-zero string.
    expect(traceIdForLogs({ traceId: "0".repeat(32) })).toBeUndefined();
  });
});

describe("aiTelemetry", () => {
  it("is disabled when telemetry is not configured", () => {
    // No OTEL_EXPORTER_OTLP_ENDPOINT in the test env.
    expect(aiTelemetry("agent.loop", {}).isEnabled).toBe(false);
  });

  it("does not record prompts or completions by default", () => {
    const t = aiTelemetry("agent.loop", { conversation_id: "abc" });
    expect(t.recordInputs).toBe(false);
    expect(t.recordOutputs).toBe(false);
  });

  it("passes functionId and metadata through", () => {
    const t = aiTelemetry("agent.loop", { conversation_id: "abc", loop_idx: 2 });
    expect(t.functionId).toBe("agent.loop");
    expect(t.metadata).toEqual({ conversation_id: "abc", loop_idx: 2 });
  });

  it("drops metadata entries with undefined values", () => {
    const t = aiTelemetry("agent.loop", { a: "x", b: undefined });
    expect(t.metadata).toEqual({ a: "x" });
  });
});
