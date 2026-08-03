import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "../../../../src/agent/prompt";
import type { QueryRequest, Widget } from "../../../../src/protocol/types";

function makeWidget(overrides: Partial<Widget> = {}): Widget {
  return {
    uuid: "uuid-a",
    origin: "test",
    widget_id: "prices",
    name: "AAPL Prices",
    description: "Daily OHLCV",
    params: [],
    metadata: {
      data_table: {
        dialect: "duckdb-wasm",
        table_name: "aapl_prices_uuida",
        row_count: 252,
        columns: [
          { name: "date", type: "DATE" },
          { name: "close", type: "DOUBLE" },
        ],
      },
    },
    ...overrides,
  };
}

describe("buildSystemPrompt — Client-Queryable Widgets", () => {
  it("includes section when clientSqlEnabled and widgets present", () => {
    const request: QueryRequest = {
      messages: [{ role: "human", content: "hi" }],
      widgets: { primary: [makeWidget()], secondary: [] },
    };
    const prompt = buildSystemPrompt(request, { clientSqlEnabled: true });
    expect(prompt).toContain("## Client-Queryable Widgets (DuckDB in workspace)");
    expect(prompt).toContain("CLIENT-SQL PRIORITY");
    expect(prompt).toContain("aapl_prices_uuida");
    expect(prompt).toContain("execute_client_sql");
    expect(prompt).toContain("close (DOUBLE)");
    expect(prompt).toContain("MUST call");
  });

  it("omits section when flag is false (back-compat)", () => {
    const request: QueryRequest = {
      messages: [{ role: "human", content: "hi" }],
      widgets: { primary: [makeWidget()], secondary: [] },
    };
    const prompt = buildSystemPrompt(request, { clientSqlEnabled: false });
    expect(prompt).not.toContain("## Client-Queryable Widgets (DuckDB in workspace)");
  });

  it("omits section when no data_table widgets", () => {
    const request: QueryRequest = {
      messages: [{ role: "human", content: "hi" }],
      widgets: {
        primary: [makeWidget({ metadata: {} })],
        secondary: [],
      },
    };
    const prompt = buildSystemPrompt(request, { clientSqlEnabled: true });
    expect(prompt).not.toContain("## Client-Queryable Widgets (DuckDB in workspace)");
  });
});
