import { describe, it, expect } from "bun:test";
import { peekTableDescription, runPeekTable } from "../../../../../../src/agent/tools/sql/peek-table";

const prices = [
  { symbol: "NVDA", close: 100 },
  { symbol: "AAPL", close: 200 },
];

function ctx(tables: Record<string, Record<string, unknown>[]> = {}) {
  return { pendingTables: new Map(Object.entries(tables)) };
}

describe("runPeekTable — guards", () => {
  it("warns models that widget names are not loaded table names", () => {
    expect(peekTableDescription).toContain("widget ids are not queryable tables");
    expect(peekTableDescription).toContain("Use this first whenever table or column names are uncertain");
    expect(peekTableDescription).toContain("exact queryable table and column names");
  });

  it("returns the no-tables message when nothing is loaded", () => {
    const text = runPeekTable({}, ctx());
    expect(text).toContain("No widget data is loaded");
    expect(text).toContain("call get_widget_data");
  });

  it("returns table-not-found when name does not match", () => {
    const text = runPeekTable({ table_name: "missing" }, ctx({ prices }));
    expect(text).toContain('Table "missing" not loaded');
    expect(text).toContain('"prices"');
  });

  // Regression: the not-found message used to end at "Available: ...", which
  // reads as terminal state. The model treated a missing table as "the data
  // is not available" and asked the user for permission to load it, even
  // though the widget was listed in the prompt with its uuid.
  it("tells the model to fetch the widget instead of stopping at the missing table", () => {
    const text = runPeekTable({ table_name: "missing" }, ctx({ prices }));
    expect(text).toContain("call get_widget_data");
    expect(text).toContain("Do not ask the user for permission");
  });
});

describe("runPeekTable — happy path", () => {
  it("defaults to the only loaded table when no name is provided", () => {
    const text = runPeekTable({}, ctx({ prices }));
    expect(text).toContain('Table "prices"');
    expect(text).toContain("First 2 rows");
    expect(text).toContain("NVDA");
  });

  it("respects an explicit limit and caps at 100", () => {
    const big = Array.from({ length: 150 }, (_, i) => ({ id: i }));
    expect(runPeekTable({ limit: 5 }, ctx({ big }))).toContain("First 5 rows");
    expect(runPeekTable({ limit: 9999 }, ctx({ big }))).toContain("First 100 rows");
  });

  it("includes the column listing", () => {
    const text = runPeekTable({}, ctx({ prices }));
    expect(text).toContain("Columns:");
    expect(text).toContain('"symbol"');
    expect(text).toContain('"close"');
  });
});

describe("runPeekTable — security + correctness regressions", () => {
  it("regression: rejects sqlite_* table names (information disclosure)", () => {
    for (const name of ["sqlite_master", "sqlite_schema", "SQLITE_MASTER"]) {
      const text = runPeekTable({ table_name: name }, ctx({ prices }));
      expect(text).toMatch(/SQLite internal/);
    }
  });

  it("regression: type-infers columns populated only past row 50 (sparse columns)", () => {
    // Old behavior sampled the first 50 rows for type inference. A column
    // that is null until row 51 ended up labeled TEXT even when its
    // populated values were numeric. Bug existed in both
    // src/sql/loader.ts:analyzeTable and src/agent/tools/sql/db.ts:loadOne.
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 100; i++) rows.push({ id: i, sparse: i < 60 ? null : i });
    const text = runPeekTable({}, ctx({ data: rows }));
    expect(text).toMatch(/"sparse"\s+\(INTEGER\)/);
  });

  it("regression: dedupes columns that sanitize to the same name in the SQLite load path", () => {
    // Mirror of loader.ts dedup, but for the `loadOne` path that actually
    // runs CREATE TABLE inside bun:sqlite. Without the dedup, duplicate
    // column defs would either raise or silently collapse one column.
    const rows = [{ a: 1, A: 2, "foo bar": 3, "foo-bar": 4 }];
    const text = runPeekTable({}, ctx({ data: rows }));
    // Column listing should show a, a_2, foo_bar, foo_bar_2
    expect(text).toContain('"a"');
    expect(text).toContain('"a_2"');
    expect(text).toContain('"foo_bar"');
    expect(text).toContain('"foo_bar_2"');
  });
});
