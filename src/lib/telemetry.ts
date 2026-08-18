import { trace, context, type Context, type SpanContext, type Tracer } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import type { TelemetrySettings } from "ai";
import { getLogger } from "./logger";

const logger = getLogger(["app", "telemetry"]);

export const TRACER_NAME = "agent-rita";

/**
 * Telemetry is opt-in: with no OTLP endpoint configured nothing is registered,
 * `trace.getTracer` hands back the API's no-op tracer, and every span created
 * by the agent is non-recording (invalid span context, no export, no cost).
 * That's why call sites never branch on "is telemetry on" — they just create
 * spans. `formatTraceparent` returns null for the invalid context, so the
 * disabled path also produces no `extra_state.traceparent`.
 */
function otlpEndpoint(): string | undefined {
  return (
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    undefined
  );
}

/** Dev switch: print spans to stdout instead of (or alongside) shipping them. */
function consoleTraces(): boolean {
  return process.env.OTEL_TRACES_CONSOLE === "true";
}

export function telemetryEnabled(): boolean {
  return otlpEndpoint() !== undefined || consoleTraces();
}

/**
 * Prompts, widget rows and SQL results ride in AI SDK span attributes when
 * input/output recording is on. That is customer data leaving the process, so
 * it stays off unless explicitly enabled. Turn it on only against a
 * self-hosted collector.
 */
function recordPrompts(): boolean {
  return process.env.OTEL_RECORD_PROMPTS === "true";
}

let provider: NodeTracerProvider | undefined;

/**
 * Idempotent. Safe to call from both server entrypoints; the first call wins.
 *
 * Note for anyone adding auto-instrumentation later: this runs under Bun, and
 * `@opentelemetry/instrumentation-*` packages patch Node's module registry —
 * they will NOT capture `Bun.serve` or `fetch`. Everything here is manual
 * span creation on purpose.
 */
export function initTelemetry(): void {
  if (provider) return;
  const url = otlpEndpoint();
  if (!url && !consoleTraces()) {
    logger.debug(
      "Telemetry disabled (set OTEL_EXPORTER_OTLP_ENDPOINT to export, or OTEL_TRACES_CONSOLE=true to print spans)",
    );
    return;
  }

  const spanProcessors: SpanProcessor[] = [];
  if (url) spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url })));
  // Simple (not batched) so spans appear as they end — the point of the
  // console path is watching a turn unfold live.
  if (consoleTraces()) spanProcessors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));

  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "agent-rita",
      [ATTR_SERVICE_VERSION]: process.env.OTEL_SERVICE_VERSION || "dev",
    }),
    spanProcessors,
  });
  provider.register();

  logger.info("Telemetry enabled", {
    endpoint: url ?? null,
    console: consoleTraces(),
    recordPrompts: recordPrompts(),
  });
}

/**
 * Flush pending spans. Without this the last trace before a container SIGTERM
 * is dropped by the batch processor.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!provider) return;
  await provider.shutdown();
  provider = undefined;
}

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);
const TRACEPARENT_LEN = 55;

/**
 * Parse a W3C traceparent into a remote SpanContext, or null if it is not
 * exactly a valid version-00 traceparent.
 *
 * This value arrives in `extra_state`, which round-trips through the browser,
 * so it is untrusted input — same posture as the other echoed keys. Strict by
 * design: no trimming, no case-folding, no partial acceptance. A malformed
 * value means "start a fresh trace", never "throw".
 */
export function parseTraceparent(raw: unknown): SpanContext | null {
  if (typeof raw !== "string" || raw.length !== TRACEPARENT_LEN) return null;
  const m = TRACEPARENT_RE.exec(raw);
  if (!m) return null;
  const [, traceId, spanId, flags] = m;
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) return null;
  return {
    traceId,
    spanId,
    traceFlags: parseInt(flags, 16),
    isRemote: true,
  };
}

/** Serialize a span context as a W3C traceparent; null if the context is invalid. */
export function formatTraceparent(ctx: {
  traceId: string;
  spanId: string;
  traceFlags: number;
}): string | null {
  if (!TRACEPARENT_RE.test(`00-${ctx.traceId}-${ctx.spanId}-00`)) return null;
  if (ctx.traceId === ZERO_TRACE_ID || ctx.spanId === ZERO_SPAN_ID) return null;
  const flags = (ctx.traceFlags & 0xff).toString(16).padStart(2, "0");
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

/**
 * Trace id for joining logs to traces, or undefined when telemetry is off (in
 * which case the context is the all-zero invalid one and logging it would be
 * pure noise).
 */
export function traceIdForLogs(ctx: { traceId: string }): string | undefined {
  return ctx.traceId === ZERO_TRACE_ID ? undefined : ctx.traceId;
}

/**
 * Wrap a span context as a parent Context.
 *
 * Deliberately takes an already-parsed SpanContext rather than a raw string:
 * callers must derive the parent span and the value they propagate onward from
 * the SAME validated parse, or the two disagree whenever the input is corrupt.
 */
export function contextFromSpanContext(spanContext: SpanContext): Context {
  return trace.setSpanContext(context.active(), spanContext);
}

/**
 * AI SDK telemetry settings for a call site. Enabled only when an exporter is
 * configured, so the SDK does no span work in the default deployment.
 */
export function aiTelemetry(
  functionId: string,
  metadata: Record<string, string | number | boolean | undefined>,
): TelemetrySettings {
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (v !== undefined) clean[k] = v;
  }
  return {
    isEnabled: telemetryEnabled(),
    recordInputs: recordPrompts(),
    recordOutputs: recordPrompts(),
    functionId,
    metadata: clean,
  };
}
