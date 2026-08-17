import { describe, it, expect } from "bun:test";
import { runExecuteSql } from "../../../../../../src/agent/tools/sql/execute-sql";

const prices = [
  { symbol: "NVDA", close: 100 },
  { symbol: "AAPL", close: 200 },
  { symbol: "MSFT", close: 300 },
];

function ctx(tables: Record<string, Record<string, unknown>[]> = {}) {
  return { pendingTables: new Map(Object.entries(tables)) };
}

describe("runExecuteSql — guardrails", () => {
  it("rejects non-SELECT statements", () => {
    const text = runExecuteSql({ sql: "DELETE FROM prices" }, ctx({ prices }));
    expect(text).toContain("only SELECT or WITH");
  });

  it("accepts WITH (CTE) statements", () => {
    const text = runExecuteSql({ sql: "WITH t AS (SELECT 1 AS n) SELECT * FROM t" }, ctx());
    expect(text).not.toContain("only SELECT");
  });

  it("accepts leading SQL comments before SELECT/WITH", () => {
    const text = runExecuteSql({
      sql: "-- Calculate the requested metric\nSELECT symbol FROM prices ORDER BY symbol",
    }, ctx({ prices }));
    expect(text).toContain("Rows: 3");
    expect(text).not.toContain("only SELECT");
  });
});

describe("runExecuteSql — happy path", () => {
  it("returns rows for a simple SELECT against a loaded table", () => {
    const text = runExecuteSql(
      { sql: "SELECT symbol, close FROM prices ORDER BY close DESC" },
      ctx({ prices }),
    );
    expect(text).toContain("Rows: 3");
    const json = text.slice(text.indexOf("["));
    const parsed = JSON.parse(json);
    expect(parsed[0].symbol).toBe("MSFT");
    expect(parsed[2].symbol).toBe("NVDA");
  });

  it("truncates result sets larger than 1000 rows and labels the output", () => {
    const big = Array.from({ length: 1500 }, (_, i) => ({ id: i }));
    const text = runExecuteSql({ sql: "SELECT * FROM big" }, ctx({ big }));
    expect(text).toContain("Rows: 1500");
    expect(text).toContain("TRUNCATED");
    expect(text).toContain("first 1000");
  });

  it("sanitizes table names with non-identifier characters", () => {
    const text = runExecuteSql(
      { sql: "SELECT * FROM weird_name" },
      ctx({ "weird-name": [{ a: 1 }] }),
    );
    expect(text).toContain("Rows: 1");
  });

  it("does not repair references to columns produced by the previous SQL result", () => {
    const c = ctx({
      executive_esg_kpi_snapshot: [
        { label: "Revenue", delta: "+8.5%" },
        { label: "Carbon intensity", delta: "-17.1%" },
        { label: "Compliance cases", delta: "-18.5%" },
      ],
    });

    const first = runExecuteSql(
      {
        sql:
          "SELECT label, delta, " +
          "CAST(TRIM(REPLACE(REPLACE(delta, '%', ''), 'pp', '')) AS REAL) AS numeric_delta " +
          "FROM executive_esg_kpi_snapshot",
      },
      c,
    );
    expect(first).toContain("Rows: 3");

    const second = runExecuteSql(
      {
        sql:
          "SELECT label, delta, numeric_delta, ABS(numeric_delta) AS abs_delta " +
          "FROM executive_esg_kpi_snapshot ORDER BY abs_delta DESC LIMIT 2",
      },
      c,
    );

    expect(second).toContain("SQL error");
    expect(second).toContain("no such column: numeric_delta");
    expect(second).not.toContain("Re-ran as");
  });
});

describe("runExecuteSql — errors", () => {
  it("returns a hint listing available tables on bad SQL", () => {
    const text = runExecuteSql(
      { sql: "SELECT * FROM does_not_exist" },
      ctx({ prices }),
    );
    expect(text).toContain("SQL error");
    expect(text).toContain("Available tables:");
    expect(text).toContain('"prices"');
    // The listing alone reads as terminal state; the model must be told the
    // missing table may just be an unfetched widget.
    expect(text).toContain("call get_widget_data");
  });

  it("returns raw missing-column errors with loaded table context", () => {
    const rows = [
      {
        year: 2024,
        ltifr: 5.4,
        women_leadership_percent: 24,
      },
    ];
    const text = runExecuteSql(
      { sql: "SELECT safety_ltifr FROM master_database" },
      ctx({ master_database: rows }),
    );

    expect(text).toContain("SQL error");
    expect(text).toContain('no such column: safety_ltifr');
    expect(text).not.toContain("Did you mean");
    expect(text).toContain('"master_database"');
    expect(text).toContain('"year", "ltifr", "women_leadership_percent"');
    expect(text).not.toContain("columns: -");
  });

  it("does not suggest value aliases when the missing metric matches a table name", () => {
    const text = runExecuteSql(
      {
        sql: "SELECT date, unrate, cpi FROM ctx_unrate_series JOIN cpi USING(date)",
      },
      ctx({
        ctx_unrate_series: [{ date: "2024-01-01", unrate: 3.7 }],
        cpi: [{ date: "2024-01-01", country: "united_states", value: 0.031 }],
      }),
    );

    expect(text).toContain("SQL error");
    expect(text).not.toContain("Did you mean");
    expect(text).toContain('"cpi" (1 rows; columns: "date", "country", "value")');
  });

  it("tells the model how to load data when nothing was loaded", () => {
    const text = runExecuteSql({ sql: "SELECT * FROM whatever" }, ctx());
    expect(text).toContain("SQL error");
    expect(text).toContain("No widget data is loaded");
    expect(text).toContain("call get_widget_data");
  });

  it("returns raw SQLite compound SELECT ORDER BY errors", () => {
    const text = runExecuteSql(
      {
        sql:
          "SELECT year FROM years " +
          "UNION ALL SELECT 'Overall' AS year " +
          "ORDER BY CASE WHEN year = 'Overall' THEN 999 ELSE CAST(year AS INTEGER) END",
      },
      ctx({ years: [{ year: 2020 }, { year: 2021 }] }),
    );

    expect(text).toContain("SQL error");
    expect(text).toContain("ORDER BY");
    expect(text).not.toContain("sort_key");
    expect(text).toContain('"years"');
  });

  it("returns raw date_trunc errors", () => {
    const text = runExecuteSql(
      { sql: "SELECT date_trunc('quarter', date) AS quarter FROM dates" },
      ctx({ dates: [{ date: "2024-01-01" }] }),
    );

    expect(text).toContain("SQL error");
    expect(text).toContain("no such function: date_trunc");
    expect(text).not.toContain("SQLite does not support date_trunc");
    expect(text).not.toContain("strftime/date");
  });
});

describe("runExecuteSql — security regressions", () => {
  it("regression: rejects sqlite_master / sqlite_schema / sqlite_sequence", () => {
    for (const sql of [
      "SELECT name FROM sqlite_master",
      "select * from sqlite_schema",
      "select * from sqlite_sequence",
    ]) {
      const text = runExecuteSql({ sql }, ctx({ prices }));
      expect(text).toMatch(/sqlite internals/);
    }
  });

  it("regression: rejects PRAGMA / ATTACH / DETACH inside a WITH clause", () => {
    expect(runExecuteSql({ sql: "WITH t AS (PRAGMA table_info(prices)) SELECT 1" }, ctx({ prices })))
      .toMatch(/PRAGMA/);
    expect(runExecuteSql({ sql: "SELECT name FROM pragma_table_info('prices')" }, ctx({ prices })))
      .toMatch(/PRAGMA/);
    expect(runExecuteSql({ sql: "WITH t AS (ATTACH DATABASE 'x' AS y) SELECT 1" }, ctx({ prices })))
      .toMatch(/ATTACH/);
    expect(runExecuteSql({ sql: "WITH t AS (DETACH DATABASE main) SELECT 1" }, ctx({ prices })))
      .toMatch(/DETACH/);
  });

  it("regression: explicit denylist blocks multi-statement smuggling (`SELECT ... ; DROP ...`)", () => {
    // bun:sqlite happens to only execute the first prepared statement,
    // so a trailing DROP/INSERT/etc would silently no-op today. Don't
    // rely on that — reject any `;` followed by a SQL keyword.
    for (const sql of [
      "SELECT * FROM prices; DROP TABLE prices",
      "SELECT 1; INSERT INTO prices VALUES ('X', 0)",
      "SELECT 1; DELETE FROM prices",
      "SELECT 1; PRAGMA table_info(prices)",
      "SELECT 1; ATTACH DATABASE 'evil.db' AS e",
    ]) {
      const text = runExecuteSql({ sql }, ctx({ prices }));
      expect(text).toMatch(/multi-statement|PRAGMA|ATTACH/);
    }
  });
});
