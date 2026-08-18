/**
 * Tier 2 — workspace bridge native SSE round-trip.
 *
 * When the model picks one of the SSE-surfaced bridge commands the loop must
 * emit a `copilotFunctionCall` whose `function` equals the command name and
 * whose `input_arguments` are normalized to the openbb-ai wire shape (see
 * normalizeBridgeArgs). No `execute_agent_tool` (MCP detour) for these.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { runAgentLoop } from "../../../src/agent/loop";
import type { QueryRequest, SSEEvent, ToolMessage, Widget } from "../../../src/protocol/types";
import { llmCallsTool, llmEmitsText, makeMockLlm, makeSpyMockLlm } from "../../helpers/mock-llm";
import { collectGenerator } from "../../helpers/sse-reader";
import { clearAllModuleState } from "../../helpers/clear-state";

beforeEach(() => clearAllModuleState());

function findFunctionCall(events: SSEEvent[], fn: string): SSEEvent | undefined {
  return events.find(
    (e) =>
      e.event === "copilotFunctionCall" &&
      (e.data as { function?: string }).function === fn,
  );
}

describe("workspace bridge — generic dispatch", () => {
  it("successful update_widget_in_dashboard bridge results are terminal and do not start another model turn", async () => {
    const toolMsg: ToolMessage = {
      role: "tool",
      function: "update_widget_in_dashboard",
      input_arguments: {
        data_sources: [{ widget_uuid: "widget-1", input_args: { value: 41 } }],
      },
      data: [
        {
          ok: true,
          command: "update_widget",
          request_id: null,
          message: "Widget updated.",
          data: { dashboard_id: "dashboard-1", widget_uuid: "widget-1" },
        },
      ] as unknown as ToolMessage["data"],
    };
    const spy = makeSpyMockLlm(
      llmCallsTool("update_widget_in_dashboard", {
        widget_uuid: "widget-1",
        config: { data_args: { value: 41 } },
      }),
    );

    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "Update these widgets to say by 41" },
            toolMsg,
          ],
          workspace_options: ["generative-ui"],
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: spy.model,
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: true,
        conversationId: "wb-update-terminal",
      }),
    );

    expect(spy.calls).toHaveLength(0);
    expect(findFunctionCall(events, "update_widget_in_dashboard")).toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "copilotStatusUpdate",
        data: expect.objectContaining({ message: "Widget update succeeded" }),
      }),
    );
    expect(events).toContainEqual({
      event: "copilotMessageChunk",
      data: { delta: "Widget update succeeded." },
    });
  });

  it("a passthrough bridge call (manage_navigation_bar) emits a native SSE with verbatim shape", async () => {
    const args = { operation: "create" as const, tabs: [{ name: "AAPL Analysis" }] };
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "make me tabs" }],
          workspace_options: ["generative-ui"],
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(llmCallsTool("manage_navigation_bar", args)),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: true,
        conversationId: "wb-1",
      }),
    );
    const fc = findFunctionCall(events, "manage_navigation_bar");
    expect(fc).toBeDefined();
    const data = fc!.data as { input_arguments: unknown; extra_state?: Record<string, unknown> };
    expect(data.input_arguments).toEqual(args);
    // turn_usage rides every round-trip emission so the next request can add
    // to it — a turn's token total is otherwise unrecoverable once this
    // generator exits. The mock LLM reports 1 in / 1 out per call.
    expect(data.extra_state).toEqual({
      copilot_function_call_arguments: args,
      turn_usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, postCount: 1 },
    });
    expect(findFunctionCall(events, "execute_agent_tool")).toBeUndefined();
  });

  it("shows update_widget_in_dashboard progress and normalizes config to data_sources", async () => {
    const args = {
      widget_uuid: "6224044d-3026-42be-8101-7076a24548cf",
      config: { data_args: { filter_text: "B" } },
    };
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "filter this widget to B" }],
          workspace_options: ["generative-ui"],
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(llmCallsTool("update_widget_in_dashboard", args)),
        allWidgets: [],
        workspaceState: {
          current_page_context: "dashboard",
          current_dashboard_uuid: "dash-1",
          current_dashboard_info: {
            id: "dash-1",
            name: "Dashboard",
            current_tab_id: "main",
            tabs: [
              {
                tab_id: "main",
                widgets: [
                  {
                    widget_uuid: "6224044d-3026-42be-8101-7076a24548cf",
                    name: "Table Widget with String Filter",
                  },
                ],
              },
            ],
          },
        },
        generativeUiEnabled: true,
        conversationId: "wb-update-widget-progress",
      }),
    );

    const status = events.find(
      (event) =>
        event.event === "copilotStatusUpdate" &&
        (event.data as { message?: string }).message ===
          'Updating "Table Widget with String Filter"',
    );
    expect(status).toBeDefined();
    expect((status!.data as { details?: Array<Record<string, unknown>> }).details).toEqual([
      { filter_text: "B" },
    ]);

    const call = findFunctionCall(events, "update_widget_in_dashboard");
    expect(call).toBeDefined();
    expect((call!.data as { input_arguments: unknown }).input_arguments).toEqual({
      data_sources: [
        {
          widget_uuid: "6224044d-3026-42be-8101-7076a24548cf",
          input_args: { filter_text: "B" },
        },
      ],
    });
  });

  it("add_widget_to_dashboard normalizes catalog config to data_sources", async () => {
    const args = {
      origin: "openbb",
      widget_id: "options_chain",
      config: { data_args: { symbol: "AAPL" } },
    };
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "place options chain" }],
          workspace_options: ["generative-ui"],
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(llmCallsTool("add_widget_to_dashboard", args)),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: true,
        conversationId: "wb-2",
      }),
    );
    const call = findFunctionCall(events, "add_widget_to_dashboard");
    expect(call).toBeDefined();
    expect((call!.data as { input_arguments: unknown }).input_arguments).toEqual({
      data_sources: [{ origin: "openbb", id: "options_chain", input_args: { symbol: "AAPL" } }],
    });
    expect(findFunctionCall(events, "execute_agent_tool")).toBeUndefined();
  });

  it("emits update_widget_in_dashboard, one bridge command per round-trip", async () => {
    // The browser executes each copilotFunctionCall and re-POSTs immediately,
    // so a second emission in the same turn would fork the conversation into
    // duplicate continuations. Only the first bridge call goes out; the model
    // re-issues the rest after seeing its result.
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "update parameter sector to Financials" }],
          workspace_options: ["generative-ui"],
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm({
          toolCalls: [
            {
              toolName: "update_widget_in_dashboard",
              input: {
                widget_uuid: "w-1",
                config: { data_args: { sector: "Financials" }, ui_args: null },
              },
            },
            {
              toolName: "update_widget_in_dashboard",
              input: {
                widget_uuid: "w-2",
                config: { data_args: { sector: "Financials" }, ui_args: null },
              },
            },
          ],
          finishReason: "tool-calls",
        }),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: true,
        conversationId: "wb-update",
      }),
    );

    expect(findFunctionCall(events, "update_widget")).toBeUndefined();
    const call = findFunctionCall(events, "update_widget_in_dashboard");
    expect(call).toBeDefined();
    const bridgeCalls = events.filter((e) => e.event === "copilotFunctionCall");
    expect(bridgeCalls).toHaveLength(1);
    expect((call!.data as { input_arguments: unknown }).input_arguments).toEqual({
      data_sources: [{ widget_uuid: "w-1", input_args: { sector: "Financials" } }],
    });
  });

  it("emits only the first bridge command when the model calls several in one step", async () => {
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [{ role: "human", content: "create a widget and a tab" }],
          workspace_options: ["generative-ui"],
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm({
          toolCalls: [
            {
              toolName: "add_widget_to_dashboard",
              input: { origin: "openbb", widget_id: "options_chain" },
            },
            {
              toolName: "manage_navigation_bar",
              input: { operation: "add_tabs", tabs: [{ name: "Options" }] },
            },
          ],
          finishReason: "tool-calls",
        }),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: true,
        conversationId: "wb-multi-bridge",
      }),
    );

    const bridgeCalls = events.filter((e) => e.event === "copilotFunctionCall");
    expect(bridgeCalls).toHaveLength(1);
    const data = bridgeCalls[0]!.data as {
      function?: string;
      extra_state?: {
        pending_bridge_calls?: Array<{ function: string; input_arguments: Record<string, unknown> }>;
      };
    };
    expect(data.function).toBe("add_widget_to_dashboard");
    // The browser executes one copilotFunctionCall per turn. The rest of the
    // step's bridge calls must ride extra_state so the continuation can keep
    // executing them — dropping them silently loses model-decided mutations.
    // The queue stores the raw (pre-normalization) tool input; it is normalized
    // when the drain emits it.
    expect(data.extra_state?.pending_bridge_calls).toEqual([
      {
        function: "manage_navigation_bar",
        input_arguments: { operation: "add_tabs", tabs: [{ name: "Options" }] },
      },
    ]);
  });

  it("drains queued bridge calls one per re-POST before the model runs again", async () => {
    const queued = {
      function: "update_widget_in_dashboard",
      input_arguments: { widget_uuid: "w-2", config: { data_args: { sector: "technology" } } },
    };
    const priorBridgeResult: ToolMessage = {
      role: "tool",
      function: "update_widget_in_dashboard",
      input_arguments: {
        data_sources: [{ widget_uuid: "w-1", input_args: { sector: "technology" } }],
      },
      data: [
        { status: "success", message: "Widget updated." },
      ] as unknown as ToolMessage["data"],
      extra_state: { pending_bridge_calls: [queued] },
    } as unknown as ToolMessage;

    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "update parameter sector to technology" },
            priorBridgeResult,
          ],
          workspace_options: ["generative-ui"],
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(llmEmitsText("MODEL SHOULD NOT RUN")),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: true,
        conversationId: "wb-drain",
      }),
    );

    const bridgeCalls = events.filter((e) => e.event === "copilotFunctionCall");
    expect(bridgeCalls).toHaveLength(1);
    const data = bridgeCalls[0]!.data as {
      function?: string;
      input_arguments?: unknown;
      extra_state?: Record<string, unknown>;
    };
    expect(data.function).toBe("update_widget_in_dashboard");
    // The raw queued input is normalized to the openbb-ai data_sources shape.
    expect(data.input_arguments).toEqual({
      data_sources: [{ widget_uuid: "w-2", input_args: { sector: "technology" } }],
    });
    // Queue exhausted — the next re-POST runs the model with all results.
    expect(data.extra_state?.pending_bridge_calls).toBeUndefined();
    // The model must NOT run while calls are still owed to the browser.
    expect(events.some((e) => e.event === "copilotMessageChunk")).toBe(false);
  });

  it("carries continuation extra_state on bridge emissions (compute delta survives the round-trip)", async () => {
    // The workspace echoes extra_state back on the re-POST and the loop
    // restores from the LAST tool message only. A bridge emission that drops
    // compute_tables_shipped would silently wipe the execute_code delta-ship
    // state mid-turn.
    const priorBridgeResult: ToolMessage = {
      role: "tool",
      function: "manage_dashboard",
      input_arguments: { operation: "create", name: "Dash" },
      data: [
        {
          status: "success",
          message: "Dashboard created.",
          data: { ok: true, command: "manage_dashboard", data: { dashboard_id: "d-1" } },
        },
      ] as unknown as ToolMessage["data"],
      extra_state: { compute_tables_shipped: ["events_table"] },
    } as unknown as ToolMessage;

    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "create dashboard then add the widget" },
            priorBridgeResult,
          ],
          workspace_options: ["generative-ui"],
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(llmCallsTool("add_widget_to_dashboard", {
          origin: "openbb",
          widget_id: "options_chain",
        })),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: true,
        conversationId: "wb-extra-state",
      }),
    );

    const fc = findFunctionCall(events, "add_widget_to_dashboard");
    expect(fc).toBeDefined();
    const extraState = (fc!.data as { extra_state?: Record<string, unknown> }).extra_state;
    expect(extraState).toMatchObject({
      compute_tables_shipped: ["events_table"],
    });
  });

  it("add_widget_to_dashboard emits after a successful schema round-trip", async () => {
    const args = {
      origin: "openbb",
      widget_id: "options_chain",
      config: { data_args: { symbol: "AAPL" } },
    };
    const schemaTool = {
      role: "tool",
      function: "get_widget_schema",
      input_arguments: { origin: "openbb", widget_id: "options_chain" },
      data: [
        {
          status: "success",
          data: {
            ok: true,
            command: "get_widget_schema",
            data: {
              widget: {
                origin: "openbb",
                widget_id: "options_chain",
                name: "Options Chain",
                params: [{ paramName: "symbol", type: "text" }],
              },
            },
          },
        },
      ],
    };

    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            { role: "human", content: "place options chain" },
            schemaTool,
          ],
          workspace_options: ["generative-ui"],
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(llmCallsTool("add_widget_to_dashboard", args)),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: true,
        conversationId: "wb-2-schema",
      }),
    );

    const fc = findFunctionCall(events, "add_widget_to_dashboard");
    expect(fc).toBeDefined();
    expect(findFunctionCall(events, "execute_agent_tool")).toBeUndefined();
    const extraState = (fc!.data as { extra_state?: Record<string, unknown> }).extra_state;
    expect(extraState)
      .toMatchObject({
        copilot_function_call_arguments: {
          data_sources: [{ origin: "openbb", id: "options_chain", input_args: { symbol: "AAPL" } }],
        },
      });
  });

  it("emits duplicate add_widget_to_dashboard calls unchanged instead of blocking them", async () => {
    const boardWidget: Widget = {
      uuid: "board_structure",
      origin: "Teixeira Duarte",
      widget_id: "board_structure",
      name: "Board Size, Independence and Gender Mix",
      description: "Governance board structure data.",
      params: [],
    };
    const complianceWidget: Widget = {
      uuid: "ethics_compliance",
      origin: "Teixeira Duarte",
      widget_id: "ethics_compliance",
      name: "Compliance Cases, Resolution Rate and Timing",
      description: "Compliance cases data.",
      params: [],
    };
    const duplicateBoard = {
      dashboard_id: "dash-governance",
      origin: "Teixeira Duarte",
      widget_id: "board_structure",
      config: { data_args: { business_unit: "Group_Consolidated" } },
    };
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            {
              role: "human",
              content:
                'Create a new dashboard with 2 widgets from ESG on Governance on one tab "Governance" and then another tab "Social" that just has a markdown note widget saying "Hello"',
            },
          ],
          workspace_options: ["generative-ui"],
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(llmCallsTool("add_widget_to_dashboard", duplicateBoard)),
        allWidgets: [boardWidget, complianceWidget],
        tieredWidgets: [
          { widget: boardWidget, tier: "extra" as const },
          { widget: complianceWidget, tier: "extra" as const },
        ],
        workspaceState: {
          current_page_context: "dashboard",
          current_dashboard_uuid: "dash-governance",
          current_dashboard_info: {
            id: "dash-governance",
            name: "Governance Social Dashboard",
            current_tab_id: "governance",
            tabs: [
              {
                tab_id: "governance",
                widgets: [
                  {
                    widget_uuid: "board-widget-instance",
                    name: "Board Size, Independence and Gender Mix",
                  },
                  {
                    widget_uuid: "compliance-widget-instance",
                    name: "Compliance Cases, Resolution Rate and Timing",
                  },
                ],
              },
              { tab_id: "social", widgets: [] },
            ],
          },
        },
        generativeUiEnabled: true,
        conversationId: "wb-dashboard-duplicate-widget-guard",
      }),
    );

    const call = findFunctionCall(events, "add_widget_to_dashboard");
    expect(call).toBeDefined();
    expect((call!.data as { input_arguments: unknown }).input_arguments).toEqual({
      data_sources: [
        {
          origin: "Teixeira Duarte",
          id: "board_structure",
          input_args: { business_unit: "Group_Consolidated" },
        },
      ],
    });
    expect(events.some((event) =>
      event.event === "copilotStatusUpdate" &&
      (event.data as { message?: string }).message === "add_widget_to_dashboard: duplicate"
    )).toBe(false);
  });

  it("emits duplicate navigation bar creation unchanged instead of blocking it", async () => {
    const createTabs = {
      operation: "create",
      dashboard_id: "dash-governance",
      tabs: [{ name: "Governance" }, { name: "Social" }],
    };
    const events = await collectGenerator(
      runAgentLoop({
        request: {
          messages: [
            {
              role: "human",
              content:
                'Create a new dashboard with 2 widgets from ESG on Governance on one tab "Governance" and then another tab "Social" that just has a markdown note widget saying "Hello"',
            },
          ],
          workspace_options: ["generative-ui"],
        } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        model: makeMockLlm(llmCallsTool("manage_navigation_bar", createTabs)),
        allWidgets: [],
        workspaceState: {
          current_page_context: "dashboard",
          current_dashboard_uuid: "dash-governance",
          current_dashboard_info: {
            id: "dash-governance",
            name: "Governance Social Dashboard",
            current_tab_id: "governance",
            tabs: [
              { tab_id: "governance", widgets: [] },
              { tab_id: "social", widgets: [] },
            ],
          },
        },
        generativeUiEnabled: true,
        conversationId: "wb-dashboard-duplicate-nav-guard",
      }),
    );

    const call = findFunctionCall(events, "manage_navigation_bar");
    expect(call).toBeDefined();
    expect((call!.data as { input_arguments: unknown }).input_arguments).toEqual(createTabs);
    expect(events.some((event) =>
      event.event === "copilotStatusUpdate" &&
      (event.data as { message?: string }).message === "manage_navigation_bar: already created"
    )).toBe(false);
  });

  it("when generativeUiEnabled is false the bridge tools are NOT registered", async () => {
    const events = await collectGenerator(
      runAgentLoop({
        request: { messages: [{ role: "human", content: "x" }] } as unknown as QueryRequest,
        rawModelId: "openai:gpt-4o-mini",
        // The model "tries" to call update_widget_in_dashboard but it isn't
        // surfaced; the AI SDK still emits the tool-call content, and the loop's
        // generic dispatch ignores it (bridge calls only fire when generative
        // UI is enabled). We just assert no native SSE leaks out.
        model: makeMockLlm(llmCallsTool("update_widget_in_dashboard", { widget_uuid: "w-1" })),
        allWidgets: [],
        workspaceState: null,
        generativeUiEnabled: false,
        conversationId: "wb-3",
      }),
    );
    expect(findFunctionCall(events, "update_widget_in_dashboard")).toBeUndefined();
  });
});
