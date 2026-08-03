import { describe, it, expect } from "bun:test";
import { buildSystemPrompt } from "../../../../src/agent/prompt";
import { makeMcpTools } from "../../../../src/mcp/factory";
import type { AgentTool, QueryRequest, Widget, WorkspaceState } from "../../../../src/protocol/types";

function req(overrides: Partial<QueryRequest> = {}): QueryRequest {
  return { messages: [], ...overrides };
}

function w(overrides: Partial<Widget> = {}): Widget {
  return {
    uuid: "u-1",
    origin: "openbb",
    widget_id: "wid-1",
    name: "Sample Widget",
    description: "Sample description",
    params: [],
    ...overrides,
  };
}

describe("buildSystemPrompt — base content", () => {
  it("always includes the base rules and tool priority", () => {
    const out = buildSystemPrompt(req());
    expect(out).toContain("financial agent for the OpenBB Workspace");
    expect(out).toContain("Never fabricate data");
    expect(out).toContain("TOOL PRIORITY (strict order for data analysis");
  });

  it("notes when no widgets are available", () => {
    const out = buildSystemPrompt(req());
    expect(out).toContain("No widgets or data sources are currently available");
  });

  it("explicitly tells the model to pass widget identifiers under widget_uuid", () => {
    const out = buildSystemPrompt(req());
    expect(out).toContain("the argument key is `widget_uuid`");
    expect(out).toContain("never `uuid`");
    expect(out).toContain("into `widget_uuid`");
  });

  it("spells out the create_artifact chart shape", () => {
    const out = buildSystemPrompt(req());
    expect(out).toContain('artifact.type MUST be "chart"');
    expect(out).toContain('chartType: "line"');
    expect(out).toContain('yKey: ["value"]');
    expect(out).toContain('Never use type: "line"');
    expect(out).toContain("never invent trend columns from a snapshot table");
    expect(out).toContain("Widget ids and widget names are not SQL tables");
    expect(out).toContain("Use the queryable column names shown there, not original widget labels");
    expect(out).toContain("Use peek_table first when table or column names are uncertain");
    expect(out).toContain("Do not use PRAGMA");
    expect(out).toContain("0 rows");
    expect(out).toContain("filter combinations");
    expect(out).toContain("xKey/yKey must match the final SELECT aliases exactly");
    expect(out).toContain("create a table artifact instead of writing Markdown tables");
    expect(out).toContain("do not include HTML/Markdown image tags");
    expect(out).toContain("Never write inline artifact placeholder tags");
    expect(out).toContain("prefer reusing the same origin/widget_id with new input_args");
    expect(out).toContain("companion discovery widget");
    expect(out).toContain("Never infer column names from a table/display name");
    expect(out).toContain("value AS metric_value");
    expect(out).toContain("Do not call SQL-family tools in the same tool batch as get_widget_data");
    expect(out).toContain("Progress messages show your `display_summary` directly");
    expect(out).toContain(
      "In display_summary and _llm_think summary/plan text, do not mention internal tool/function names",
    );
    expect(out).toContain("_llm_think is for one workflow-level plan, not repeated planning between routine follow-up tool calls");
    expect(out).toContain('use plain phrases like "getting widget data" or "running SQL"');
    expect(out).toContain("If you use `sql`, omit `from_table_id` and `data`");
    expect(out).toContain("After create_artifact succeeds, do not call create_artifact again");
    expect(out).toContain("For flowchart-like renders, prefer Mermaid with `flowchart TD`");
    expect(out).toContain("After a Mermaid diagram render succeeds, do not include Mermaid code blocks");
  });

  it("keeps internal identifiers out of final answers", () => {
    const out = buildSystemPrompt(req());
    expect(out).toContain("Internal identifiers such as dashboard_id, widget_id, widget_uuid, and uuid are tool-only");
    expect(out).toContain("never expose them in final/user-facing text");
    expect(out).toContain("Never mention widget IDs or dashboard IDs to the user");
    expect(out).toContain("Use display widget names and dashboard names instead");
    expect(out).toContain("Internal tool/function names such as get_widget_data, search_widgets, and peek_table");
    expect(out).toContain('describe the action instead, e.g. "getting widget data" or "inspecting the table"');
    expect(out).toContain("Do not use queryable table names such as `table_widget_with_string_filter` as user-facing widget names");
  });

  it("only advertises execute_code when Python execution is available", () => {
    const unavailable = buildSystemPrompt(req());
    expect(unavailable).toContain("execute_code is not available this turn");
    expect(unavailable).toContain("Do not call it");
    expect(unavailable).not.toContain("execute_code is available this turn");

    const available = buildSystemPrompt(req(), { codeExecutionAvailable: true });
    expect(available).toContain("execute_code is available this turn");
    expect(available).toContain("Use rita.show() inside execute_code");
    expect(available).not.toContain("execute_code is not available this turn");
  });

  it("states the current date so the model doesn't fall back to its training cutoff", () => {
    const out = buildSystemPrompt(req());
    expect(out).toContain("CURRENT DATE");
    // The actual bug: model used its cutoff year. Assert the real current year appears.
    expect(out).toContain(String(new Date().getUTCFullYear()));
  });

  it("formats the current date in the user's timezone when one is supplied", () => {
    const tz = "Australia/Sydney";
    const out = buildSystemPrompt(req({ timezone: tz }));
    const expected = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(new Date());
    expect(out).toContain(expected);
  });
});

describe("buildSystemPrompt — widget sections", () => {
  it("emits added-to-context and on-dashboard blocks with widget details", () => {
    const out = buildSystemPrompt(
      req({
        widgets: {
          primary: [w({ uuid: "p-1", name: "PriceWidget" })],
          secondary: [w({ uuid: "s-1", name: "SecondaryWidget" })],
        },
      }),
    );
    expect(out).toContain("Widgets added to this conversation");
    expect(out).toContain("PriceWidget");
    expect(out).toContain("Widgets on the current dashboard");
    expect(out).toContain("SecondaryWidget");
    expect(out).toContain("1 added to context, 1 on dashboard, 0 connected");
  });

  it("does not leak primary/secondary/extra jargon in the rendered prompt", () => {
    const out = buildSystemPrompt(
      req({
        widgets: {
          primary: [w({ uuid: "p-1", name: "P" })],
          secondary: [w({ uuid: "s-1", name: "S" })],
          extra: [w({ uuid: "e-1", name: "E" })],
        },
      }),
    );
    expect(out).not.toContain("PRIMARY —");
    expect(out).not.toContain("SECONDARY —");
    expect(out).not.toContain("EXTRA —");
  });

  it("describes connected-but-off-dashboard widgets only by count, not detail", () => {
    const out = buildSystemPrompt(
      req({ widgets: { extra: [w({ name: "Hidden" }), w({ name: "AlsoHidden" })] } }),
    );
    expect(out).toContain("Other connected widgets — 2 additional");
    expect(out).not.toContain("Hidden");
  });

  it("renders REQUIRED for params with no current_value or default_value", () => {
    const out = buildSystemPrompt(
      req({
        widgets: {
          primary: [
            w({
              params: [
                { name: "ticker", type: "string", description: "" },
                { name: "limit", type: "number", description: "", default_value: 5 },
              ],
            }),
          ],
        },
      }),
    );
    expect(out).toContain("ticker:string=REQUIRED");
    expect(out).toContain("limit:number=5");
  });

  it("tags file widgets with their extension", () => {
    const out = buildSystemPrompt(
      req({
        widgets: {
          primary: [w({ name: "Doc", metadata: { extension: "pdf" } })],
        },
      }),
    );
    expect(out).toContain("[FILE: pdf]");
  });
});

describe("buildSystemPrompt — SQL-enabled widgets", () => {
  it("renders an SQL block for widgets with a SnowflakeSchema", () => {
    const out = buildSystemPrompt(
      req({
        widgets: {
          primary: [
            w({
              metadata: {
                schema: {
                  tableName: "PRICES",
                  database: "DB",
                  schema: "SCH",
                  columns: [{ name: "symbol", type: "VARCHAR" }],
                },
              },
            }),
          ],
        },
      }),
    );
    expect(out).toContain("## SQL-Enabled Widgets");
    expect(out).toContain("DB.SCH.PRICES");
    expect(out).toContain("symbol (VARCHAR)");
  });
});

describe("buildSystemPrompt — skills + MCP tools + timezone", () => {
  it("includes skills catalog when present", () => {
    const out = buildSystemPrompt(
      req({
        skills_catalog: [{ slug: "earnings", description: "earnings flow", updatedAt: "2026" }],
      }),
    );
    expect(out).toContain('slug="earnings"');
    expect(out).toContain("earnings flow");
  });

  it("instructs the model to autonomously call get_skill_content on topic match", () => {
    const out = buildSystemPrompt(
      req({
        skills_catalog: [{ slug: "options", description: "options pricing", updatedAt: "2026" }],
      }),
    );
    expect(out).toContain("BEFORE answering, scan this list");
    expect(out).toContain("call get_skill_content");
    expect(out).toContain("FIRST");
    expect(out).toContain("Multiple skills may apply");
  });

  it("places skills section before widget data sources so model considers it during routing", () => {
    const out = buildSystemPrompt(
      req({
        skills_catalog: [{ slug: "earnings", description: "earnings flow", updatedAt: "2026" }],
        widgets: { primary: [w({ name: "PriceWidget" })] },
      }),
    );
    const skillsIdx = out.indexOf("## Skills");
    const widgetsIdx = out.indexOf("Available data sources");
    expect(skillsIdx).toBeGreaterThan(-1);
    expect(widgetsIdx).toBeGreaterThan(-1);
    expect(skillsIdx).toBeLessThan(widgetsIdx);
  });

  it("omits skills section entirely when catalog is empty", () => {
    const out = buildSystemPrompt(req());
    expect(out).not.toContain("## Skills");
    expect(out).not.toContain("get_skill_content");
  });

  it("includes MCP tool descriptions with sanitized names", () => {
    const tools: AgentTool[] = [
      { name: "fetch-webpage", server_id: "rita", url: "u", description: "Fetch a page" },
    ];
    const out = buildSystemPrompt(req({ tools }), {
      mcpToolEntries: makeMcpTools(tools).entries,
    });
    expect(out).toContain("fetch_webpage");
    expect(out).toContain("Fetch a page");
  });

  it("includes user timezone when supplied", () => {
    const out = buildSystemPrompt(req({ timezone: "Europe/Lisbon" }));
    expect(out).toContain("User timezone: Europe/Lisbon");
  });
});

describe("buildSystemPrompt — generative UI options", () => {
  it("appends workspace bridge tools block only when enabled", () => {
    const off = buildSystemPrompt(req());
    expect(off).not.toContain("WORKSPACE OPS");

    const on = buildSystemPrompt(req(), { generativeUiEnabled: true });
    expect(on).toContain("WORKSPACE OPS");
    expect(on).toContain("add_generative_widget");
    expect(on).toContain("update_widget_in_dashboard");
    expect(on).toContain("operation 'create'");
    expect(on).toContain("add_widget_to_dashboard adds a connected/catalog widget to the current tab");
    expect(on).toContain("add_generative_widget creates inline note/table/chart/html content and supports inner_tab");
    expect(on).toContain("get_params_options when needed");
    expect(on).toContain("Omit optional IDs when you do not have a concrete value");
  });

  it("requires parameter inspection before dashboard widget config updates", () => {
    const on = buildSystemPrompt(req(), { generativeUiEnabled: true });
    expect(on).toContain("call update_widget_in_dashboard on the visible");
    expect(on).toContain("only update widgets that actually expose the requested parameter");
    expect(on).toContain("pass exact option values, not display labels");
    expect(on).toContain("preserve the user's literal value");
  });

  it("appends dashboard context only when workspaceState is provided", () => {
    const ws: WorkspaceState = {
      current_page_context: "page",
      current_dashboard_uuid: "d-1",
      current_dashboard_info: {
        id: "d-1",
        name: "My Dash",
        current_tab_id: "t1",
        tabs: [{ tab_id: "t1", widgets: [{ widget_uuid: "w-1", name: "W1" }] }],
      },
    };
    const out = buildSystemPrompt(req(), { generativeUiEnabled: true, workspaceState: ws });
    expect(out).toContain('Current dashboard: "My Dash" [dashboard_id: d-1]');
    expect(out).toContain("dashboard_id may be omitted unless the tool explicitly requires it");
    expect(out).toContain("[current]");
    expect(out).toContain("W1 [uuid: w-1]");
  });
});

// Regression guard: the system prompt must advertise exactly the MCP tools the
// factory registered. Listing raw request.tools leaks bridge-command wrappers
// the filter dropped, and the model calls ghosts (18x agentritamcp_update_widget,
// then a hallucinated "I've updated the widget" — 2026-06-11 trace).
describe("buildSystemPrompt — MCP section matches registration", () => {
  const agentTools: AgentTool[] = [
    { name: "agentritamcp_web_search", server_id: "ws", url: "u", description: "Search the web" },
    {
      name: "agentritamcp_update_widget",
      server_id: "ws",
      url: "u",
      description: "Update one widget's config",
    },
  ];

  it("lists only tools that survived the registration filter", () => {
    const out = buildSystemPrompt(req({ tools: agentTools }), {
      mcpToolEntries: makeMcpTools(agentTools).entries,
    });
    expect(out).toContain("agentritamcp_web_search");
    expect(out).toContain("Search the web");
    expect(out).not.toContain("agentritamcp_update_widget");
  });

  it("omits the MCP section when nothing is registered", () => {
    const out = buildSystemPrompt(req({ tools: agentTools }), { mcpToolEntries: [] });
    expect(out).not.toContain("MCP Tools");
  });
});

describe("buildSystemPrompt — no widgets but MCP tools registered", () => {
  const mcpEntry = {
    sanitizedName: "tako_search",
    description: "A live data source for company financials.",
  };

  // The model used to answer "I don't have a data source for that" while an
  // MCP data tool sat registered and unused.
  it("does not claim there are no data sources when an MCP tool is registered", () => {
    const out = buildSystemPrompt(req(), { mcpToolEntries: [mcpEntry] as never });
    expect(out).not.toContain("No widgets or data sources are currently available");
    expect(out).toContain("No widgets are connected in this session");
    expect(out).toContain("before telling the user you have no data source");
  });

  it("still says there are no data sources when nothing is registered", () => {
    const out = buildSystemPrompt(req());
    expect(out).toContain("No widgets or data sources are currently available");
  });

  it("frames MCP tools as data sources, not last resorts", () => {
    const out = buildSystemPrompt(req(), { mcpToolEntries: [mcpEntry] as never });
    expect(out).toContain("data sources in their own right");
    expect(out).not.toContain("use only when connected widgets do not cover");
  });
});
