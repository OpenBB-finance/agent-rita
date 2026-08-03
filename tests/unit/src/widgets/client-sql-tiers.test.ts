import { describe, expect, it } from "bun:test";
import {
  getClientDataTable,
  getClientSqlWidgets,
  getSqlSchema,
} from "../../../../src/widgets/tiers";
import type { Widget } from "../../../../src/protocol/types";

function widget(meta: Record<string, unknown>): Widget {
  return {
    uuid: "u1",
    origin: "test",
    widget_id: "w1",
    name: "Prices",
    description: "d",
    params: [],
    metadata: meta,
  };
}

describe("getClientDataTable", () => {
  it("accepts duckdb-wasm data_table", () => {
    const t = getClientDataTable(
      widget({
        data_table: {
          dialect: "duckdb-wasm",
          table_name: "prices_u1",
          row_count: 10,
          columns: [
            { name: "symbol", type: "VARCHAR" },
            { name: "close", type: "DOUBLE" },
          ],
        },
      }),
    );
    expect(t).not.toBeNull();
    expect(t!.table_name).toBe("prices_u1");
    expect(t!.columns).toHaveLength(2);
  });

  it("rejects snowflake-shaped schema on metadata.schema", () => {
    const w = widget({
      schema: {
        tableName: "T",
        database: "DB",
        schema: "PUBLIC",
        columns: [{ name: "a", type: "NUMBER" }],
      },
    });
    expect(getClientDataTable(w)).toBeNull();
    expect(getSqlSchema(w)).not.toBeNull();
  });

  it("rejects malformed data_table", () => {
    expect(getClientDataTable(widget({ data_table: { dialect: "duckdb-wasm" } }))).toBeNull();
    expect(
      getClientDataTable(
        widget({
          data_table: {
            dialect: "postgres",
            table_name: "x",
            columns: [{ name: "a", type: "VARCHAR" }],
          },
        }),
      ),
    ).toBeNull();
    expect(
      getClientDataTable(
        widget({
          data_table: {
            dialect: "duckdb-wasm",
            table_name: "x",
            columns: [{ name: 1, type: "VARCHAR" }],
          },
        }),
      ),
    ).toBeNull();
  });
});

describe("getClientSqlWidgets", () => {
  it("filters to only widgets with data_table", () => {
    const widgets = [
      widget({
        data_table: {
          dialect: "duckdb-wasm",
          table_name: "a",
          columns: [{ name: "x", type: "VARCHAR" }],
        },
      }),
      widget({}),
    ];
    expect(getClientSqlWidgets(widgets)).toHaveLength(1);
  });
});
