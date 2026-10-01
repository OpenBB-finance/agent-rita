/**
 * Tier 2 — agent-loop round-trip scenarios.
 *
 * Pinned to CLAUDE.md gotchas:
 * - Generative UI tools are terminal (no re-POST data injection expected)
 * - SSRM widgets take inline SQL via `input_args.query`
 * - Cache-resolved widget re-fetch within MAX_LOOPS=3 without HTTP round-trip
 * - Citations forwarded across round-trips (commit 63272c8)
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { runAgentLoop } from "../../../src/agent/loop";
import type { Citation, QueryRequest, ToolMessage, Widget } from "../../../src/protocol/types";
import {
  llmCallsTool,
  llmEmitsText,
  makeMockLlm,
  makeSequencedMockLlm,
} from "../../helpers/mock-llm";
import { collectGenerator } from "../../helpers/sse-reader";
import { clearAllModuleState } from "../../helpers/clear-state";

beforeEach(() => clearAllModuleState());

describe("generative UI is terminal — emits SSE then returns, no continuing loop", () => {
  it("add_generative_widget emits a function call and ends the turn", async () => {
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "make a widget" }],
          workspace_options: ["generative-ui"],
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(
          llmCallsTool("add_generative_widget", {
            widget_type: "note",
            data: "hello",
            name: "n",
            description: "d",
          }),
        ),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: true,
        conversationId: "gu-1",
      }),
    );
    const fnCall = events.find(
      (e) =>
        e.event === "copilotFunctionCall" &&
        (e.data as { function?: string }).function === "add_generative_widget",
    );
    expect(fnCall).toBeDefined();
    // Terminal: no execute_agent_tool follow-on emitted.
    expect(
      events.find(
        (e) =>
          e.event === "copilotFunctionCall" &&
          (e.data as { function?: string }).function === "execute_agent_tool",
      ),
    ).toBeUndefined();
  });
});

describe("SSRM widget — inline SQL via input_args.query routes to getWidgetDataSsrm", () => {
  it("emits a get_widget_data SSE with ssm_request.query == provided SQL", async () => {
    const widget: Widget = {
      uuid: "ssrm-1",
      origin: "openbb",
      widget_id: "ssrm-table",
      name: "SSRM Table",
      description: "",
      params: [],
      metadata: {
        schema: {
          tableName: "PRICES",
          database: "DB",
          schema: "SCH",
          columns: [{ name: "symbol", type: "VARCHAR" }],
        },
      },
    };
    const events = await collectGenerator(
      runAgentLoop({
        request: { messages: [{ role: "human", content: "query" }] } as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(
          llmCallsTool("get_widget_data", {
            widgets: [{ widget_uuid: "ssrm-1", input_args: { query: "SELECT * FROM PRICES" } }],
          }),
        ),
        allWidgets: [widget],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "ssrm-c",
      }),
    );
    const fnCall = events.find(
      (e) =>
        e.event === "copilotFunctionCall" &&
        (e.data as { function?: string }).function === "get_widget_data",
    );
    expect(fnCall).toBeDefined();
    const inputArgs = (fnCall!.data as { input_arguments: { data_sources: Array<Record<string, unknown>> } })
      .input_arguments;
    const ds = inputArgs.data_sources[0] as { ssm_request: { query: string } };
    expect(ds.ssm_request.query).toBe("SELECT * FROM PRICES");
  });
});

describe("citations — forwarded across round-trips via extra_state.intermediate_citations", () => {
  it("a tool re-POST whose extra_state carries intermediate_citations re-emits them in the final collection", async () => {
    const stashed: Citation = {
      id: "stable-id-1",
      source_info: { type: "web", name: "Source A", citable: true },
      details: [{ link: "https://example.com", title: "Source A" }],
      signature: "",
    };
    const priorTool: ToolMessage = {
      role: "tool",
      function: "execute_agent_tool",
      input_arguments: { tool_name: "fetch_webpage", server_id: "rita" },
      data: [{ items: [{ text: "page body" }] }],
      extra_state: { intermediate_citations: [stashed] },
    };
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "summarize" },
            priorTool,
          ],
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(llmEmitsText("here is the summary")),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "cit-c",
      }),
    );
    const cits = events.find((e) => e.event === "copilotCitationCollection");
    expect(cits).toBeDefined();
    const list = (cits!.data as { citations: Citation[] }).citations;
    expect(list.find((c) => c.id === "stable-id-1")).toBeDefined();
  });
});

describe("MCP tool input rejected by schema — corrected in-turn, never forwarded", () => {
  it("feeds the validation error back to the model and forwards only the valid retry", async () => {
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "list chart sources" }],
          tools: [
            {
              name: "list_chart_capabilities",
              server_id: "charts",
              url: "http://localhost:6910/charts/mcp",
              description: "List sources",
              input_schema: {
                properties: { cursor: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] } },
                required: ["cursor"],
              },
            },
          ],
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        // First attempt violates minLength; the model sees the rejection and retries.
        model: makeSequencedMockLlm([
          llmCallsTool("list_chart_capabilities", { cursor: "" }),
          llmCallsTool("list_chart_capabilities", { cursor: null }),
        ]),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "invalid-mcp-1",
      }),
    );
    const forwarded = events.filter(
      (e) =>
        e.event === "copilotFunctionCall" &&
        (e.data as { function?: string }).function === "execute_agent_tool",
    );
    expect(forwarded).toHaveLength(1);
    const args = (forwarded[0].data as { input_arguments: { parameters: Record<string, unknown> } }).input_arguments;
    expect(args.parameters).toEqual({ cursor: null });
  });
});
