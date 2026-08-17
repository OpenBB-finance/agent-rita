import { describe, it, expect } from "bun:test";
import { runPeekColumnValues } from "../../../../../../src/agent/tools/sql/peek-column-values";

const prices = [
  { symbol: "NVDA", close: 100 },
  { symbol: "AAPL", close: 200 },
  { symbol: "NVDA", close: 110 },
  { symbol: "MSFT", close: 300 },
];

function ctx(tables: Record<string, Record<string, unknown>[]> = {}) {
  return { pendingTables: new Map(Object.entries(tables)) };
}

describe("runPeekColumnValues — guards", () => {
  it("returns the no-tables message when nothing loaded", () => {
    const text = runPeekColumnValues({ column: "symbol" }, ctx());
    expect(text).toContain("No widget data is loaded");
    expect(text).toContain("call get_widget_data");
  });

  it("returns table-not-found when name does not match", () => {
    const text = runPeekColumnValues(
      { column: "symbol", table_name: "missing" },
      ctx({ prices }),
    );
    expect(text).toContain('Table "missing" not loaded');
    expect(text).toContain("call get_widget_data");
  });
});

describe("runPeekColumnValues — happy path", () => {
  it("returns DISTINCT values for a column", () => {
    const text = runPeekColumnValues({ column: "symbol" }, ctx({ prices }));
    expect(text).toContain('Column "symbol"');
    expect(text).toContain("3 unique values");
    expect(text).toContain("NVDA");
    expect(text).toContain("AAPL");
    expect(text).toContain("MSFT");
  });

  it("sanitizes the column input before querying", () => {
    const text = runPeekColumnValues({ column: "Symbol" }, ctx({ prices }));
    expect(text).toContain("3 unique values");
  });

  it("caps results at the documented MAX_VALUES (50)", () => {
    // The cap is intentional context-budget protection (LLM consumer).
    // A column with 200 distinct values should surface the cap, not return all.
    const big = Array.from({ length: 200 }, (_, i) => ({ id: `v_${i}` }));
    const text = runPeekColumnValues({ column: "id" }, ctx({ data: big }));
    expect(text).toContain("50 unique values");
    expect(text).toContain("max 50 shown");
  });
});

describe("runPeekColumnValues — security regressions", () => {
  it("regression: rejects sqlite_* table names", () => {
    const text = runPeekColumnValues(
      { column: "name", table_name: "sqlite_master" },
      ctx({ prices }),
    );
    expect(text).toMatch(/SQLite internal/);
  });
});
