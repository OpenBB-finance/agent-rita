import type { Citation, ToolMessage } from "./types";
import type { TurnUsage } from "../lib/token-usage";

/**
 * Marker emitted by the compute MCP server when execute_code cannot recover
 * for the rest of the chat (e.g. Daytona quota exhausted, sandbox locked
 * down). Once any prior tool message in the conversation contains this
 * substring, src/agent/loop.ts suppresses execute_code for the rest of the
 * chat. SQL family is unaffected — it runs in-process on the MCP server.
 */
export const COMPUTE_PERMANENTLY_UNAVAILABLE = "COMPUTE_PERMANENTLY_UNAVAILABLE";

export interface ExtraState {
  copilot_function_call_arguments?: Record<string, unknown>;
  intermediate_citations?: Citation[];
  intermediate_context?: string;
  continue_from?: string;
  pending_widget_data_requests?: Array<{
    widget_uuid: string;
    input_args?: Record<string, unknown>;
  }>;
  /**
   * Bridge commands the model issued in one step but that could not all be
   * emitted at once (the browser executes exactly one copilotFunctionCall per
   * re-POST). The first is emitted immediately; the rest queue here and the
   * loop drains them one-per-re-POST before re-running the model. Same
   * echo-back channel as pending_widget_data_requests. Without this the extra
   * calls were silently dropped and only re-run if the model re-issued them —
   * which it does not when it fired them all up front (2026-06-11 trace:
   * 19 update_widget calls, 1 executed, "I updated the widget" hallucinated).
   */
  pending_bridge_calls?: Array<{
    function: string;
    input_arguments: Record<string, unknown>;
  }>;
  loaded_skill_slugs?: string[];
  sql_query?: string;
  sql_artifact_uuid?: string;
  /**
   * Names of tables already shipped to the compute sandbox in this chat.
   * Persisted across re-POSTs so the agent only sends the delta on the next
   * compute-MCP call. Populated by the decoration step in src/agent/loop.ts.
   */
  compute_tables_shipped?: string[];
  /**
   * Daytona sandbox identity from the prior execute_code result. The agent
   * compares it against the sandbox_id emitted in the next MCP result; on
   * mismatch (sandbox auto-stopped → fresh sandbox), `tablesShipped` is
   * cleared so the new sandbox gets a full re-ship. Absent = unknown =
   * conservative full-ship (backwards-compat for older MCP servers that
   * don't emit `sandbox_meta`).
   */
  compute_sandbox_id?: string;
  /**
   * Document ids already shipped to the rita-tools MCP server's
   * `query_documents` cache for this chat. Persisted across re-POSTs so the
   * agent only ships the delta on the next query_documents call. Same
   * pattern as `compute_tables_shipped`.
   */
  documents_shipped?: string[];
  /**
   * W3C traceparent of the FIRST request in this logical turn. Set once and
   * echoed forward verbatim, so every re-POST joins the same trace with the
   * first request's span as parent. Without it, a turn that round-trips five
   * times produces five disconnected traces, each looking like a turn that
   * stops mid-thought.
   *
   * Untrusted (browser-echoed) — validated by `parseTraceparent` in
   * src/lib/telemetry.ts, which returns null rather than throwing.
   */
  traceparent?: string;
  /**
   * Token usage summed across every re-POST of this turn so far. Per-request
   * counters reset with the generator, so without this the turn total is
   * unknowable.
   *
   * Aliased to `TurnUsage` rather than restated inline: this shape is written
   * by `turnUsageSoFar` and read back by `readTurnUsage`, and a second copy of
   * the field list drifts silently the next time a counter is added.
   */
  turn_usage?: TurnUsage;
  /**
   * The user's IANA timezone, echoed forward for the rest of the turn.
   *
   * The Workspace sends `timezone` on the initial POST but not on a round-trip
   * re-POST. `buildDateSection` used to append a "User timezone: ..." line only
   * when it had one, so the system prompt gained a 32-byte tail on fresh POSTs
   * and lost it on reboot POSTs — two alternating prefixes, two prompt-cache
   * lineages (measured 2026-08-19: 21960 vs 21928 bytes, identical for the
   * first 99.9%). Carrying it here keeps one prefix.
   *
   * It also fixes a correctness bug the cache miss exposed: without it a
   * re-POST rendered CURRENT DATE in UTC, which is the wrong day for a user
   * west of Greenwich for the last hours of their day.
   *
   * Untrusted (browser-echoed) — validated by `resolveTimezone` in
   * src/agent/prompt.ts, which falls back to UTC rather than throwing.
   */
  timezone?: string;
}

export function readExtraState(toolMsg: ToolMessage): ExtraState {
  const raw = toolMsg.extra_state;
  if (!raw || typeof raw !== "object") return {};
  return raw as ExtraState;
}

export function makeExtraState(state: ExtraState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state)) {
    if (v == null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    out[k] = v;
  }
  return out;
}
