import { describe, it, expect } from "bun:test";
import {
  createArtifactDescription,
  createArtifactSchema,
  runCreateArtifact,
} from "../../../../../../src/agent/tools/sql/create-artifact";
import type { SSEEvent } from "../../../../../../src/protocol/types";

const prices = [
  { symbol: "NVDA", close: 100 },
  { symbol: "AAPL", close: 200 },
];

const energyRows = [
  { Year: 2020, Energy_Total_MWh: 980000, Renewable_Energy_Percent: 12 },
  { Year: 2021, Energy_Total_MWh: 964320, Renewable_Energy_Percent: 17.75 },
];

function ctx(tables: Record<string, Record<string, unknown>[]> = {}) {
  return {
    pendingTables: new Map(Object.entries(tables)),
    artifactQueue: [] as SSEEvent[],
  };
}

function lastArtifactPayload(queue: SSEEvent[]) {
  expect(queue.length).toBeGreaterThan(0);
  const e = queue[queue.length - 1];
  expect(e.event).toBe("copilotMessageArtifact");
  return e.data;
}

describe("runCreateArtifact — guards", () => {
  it("tells the model to provide exactly one source field", () => {
    expect(createArtifactDescription).toContain("If you use `sql`, omit `from_table_id` and `data`");
    expect(createArtifactDescription).toContain("If you use `from_table_id`, omit `sql` and `data`");
    expect(createArtifactDescription).toContain("After a successful create_artifact call, do not call create_artifact again");
  });

  it("requires one of sql, data, or from_table_id", () => {
    const c = ctx();
    const text = runCreateArtifact(
      { artifact: { type: "table", name: "T", description: "d" } },
      c,
    );
    expect(text).toContain("provide one of");
    expect(c.artifactQueue.length).toBe(0);
  });

  it("rejects multiple source kinds at once", () => {
    const c = ctx({ prices });
    const text = runCreateArtifact(
      {
        data: prices,
        from_table_id: "prices",
        artifact: { type: "table", name: "T", description: "d" },
      },
      c,
    );
    expect(text).toContain("exactly one");
    expect(c.artifactQueue.length).toBe(0);
  });

  it("rejects from_table_id when SQL is provided", () => {
    const c = ctx({ prices });
    const text = runCreateArtifact(
      {
        sql: "SELECT symbol, close FROM prices",
        from_table_id: "prices",
        artifact: { type: "table", name: "T", description: "d" },
      },
      c,
    );

    expect(text).toContain("exactly one");
    expect(c.artifactQueue.length).toBe(0);
  });

  it("accepts data:null with SQL and treats null as absent", () => {
    const parsed = createArtifactSchema.safeParse({
      sql: "SELECT * FROM prices",
      data: null,
      artifact: { type: "table", name: "T", description: "d" },
    });
    expect(parsed.success).toBe(true);

    const c = ctx({ prices });
    const text = runCreateArtifact(
      {
        sql: "SELECT * FROM prices",
        data: null,
        artifact: { type: "table", name: "T", description: "d" },
      },
      c,
    );
    expect(text).toContain("Created table artifact");
    expect(c.artifactQueue.length).toBe(1);
  });

  it("accepts null SQL/from_table_id placeholders and treats them as absent", () => {
    const parsed = createArtifactSchema.safeParse({
      sql: null,
      from_table_id: null,
      data: prices,
      artifact: { type: "table", name: "T", description: "d" },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.sql).toBeUndefined();
    expect(parsed.data.from_table_id).toBeUndefined();

    const c = ctx();
    const text = runCreateArtifact(parsed.data, c);
    expect(text).toContain("Created table artifact");
    expect(c.artifactQueue.length).toBe(1);
  });

  it("ignores empty data when SQL is provided", () => {
    const c = ctx({ prices });
    const text = runCreateArtifact(
      {
        sql: "SELECT * FROM prices",
        data: [],
        artifact: { type: "table", name: "T", description: "d" },
      },
      c,
    );
    expect(text).toContain("Created table artifact");
    expect(c.artifactQueue.length).toBe(1);
  });

  it("errors with a helpful message when from_table_id is unknown", () => {
    const c = ctx({ prices });
    const text = runCreateArtifact(
      {
        from_table_id: "missing",
        artifact: { type: "table", name: "T", description: "d" },
      },
      c,
    );
    // Internal state names must not leak into tool output — the model echoes
    // them back to the user. Route through the shared not-found contract.
    expect(text).not.toContain("pendingTables");
    expect(text).toContain('Table "missing" not loaded');
    expect(text).toContain("prices");
    expect(text).toContain("call get_widget_data");
    expect(c.artifactQueue.length).toBe(0);
  });

  it("rejects non-SELECT/WITH SQL", () => {
    const c = ctx({ prices });
    const text = runCreateArtifact(
      {
        sql: "DELETE FROM prices",
        artifact: { type: "table", name: "T", description: "d" },
      },
      c,
    );
    expect(text).toContain("only SELECT or WITH");
    expect(c.artifactQueue.length).toBe(0);
  });

  it("accepts leading SQL comments before SELECT", () => {
    const c = ctx({ prices });
    const text = runCreateArtifact(
      {
        sql: "-- Show all prices\nSELECT * FROM prices",
        artifact: { type: "table", name: "T", description: "d" },
      },
      c,
    );
    expect(text).toContain("Created table artifact");
    expect(c.artifactQueue.length).toBe(1);
  });

  it("returns a no-rows message when SQL produces nothing", () => {
    const c = ctx({ prices });
    const text = runCreateArtifact(
      {
        sql: "SELECT * FROM prices WHERE close > 999999",
        artifact: { type: "table", name: "T", description: "d" },
      },
      c,
    );
    expect(text).toContain("No rows");
    expect(c.artifactQueue.length).toBe(0);
  });

  it("returns a no-rows message when data is an empty array", () => {
    const c = ctx();
    const text = runCreateArtifact(
      { data: [], artifact: { type: "table", name: "T", description: "d" } },
      c,
    );
    expect(text).toContain("No rows");
    expect(c.artifactQueue.length).toBe(0);
  });

  it("returns a SQL error message on bad query without pushing an artifact", () => {
    const c = ctx({ prices });
    const text = runCreateArtifact(
      {
        sql: "SELECT * FROM nope",
        artifact: { type: "table", name: "T", description: "d" },
      },
      c,
    );
    expect(text).toContain("SQL error");
    expect(c.artifactQueue.length).toBe(0);
  });

  it("returns raw missing-table SQL errors", () => {
    const c = ctx({ prices });
    const text = runCreateArtifact(
      {
        sql: "SELECT * FROM change",
        artifact: { type: "table", name: "T", description: "d" },
      },
      c,
    );

    expect(text).toContain("SQL error");
    expect(text).toContain("no such table: change");
    expect(text).not.toContain("execute_sql result sets");
    expect(text).not.toContain("include the full WITH query");
    expect(c.artifactQueue.length).toBe(0);
  });

  it("does not repair metric-table value columns when chart SQL selects the table name", () => {
    const c = ctx({
      ctx_unrate_series: [
        { date: "2024-01-01", unrate: 3.7 },
        { date: "2024-02-01", unrate: 3.8 },
      ],
      cpi: [
        { date: "2024-01-01", country: "united_states", value: 0.031 },
        { date: "2024-02-01", country: "united_states", value: 0.032 },
      ],
    });

    const text = runCreateArtifact(
      {
        sql: "SELECT date, unrate, cpi FROM ctx_unrate_series JOIN cpi USING(date)",
        artifact: {
          type: "chart",
          chartType: "line",
          xKey: "date",
          yKey: ["unrate", "cpi"],
          name: "UNRATE vs CPI",
          description: "Unemployment versus CPI",
        },
      },
      c,
    );

    expect(text).toContain("SQL error");
    expect(text).toContain("no such column: cpi");
    expect(c.artifactQueue.length).toBe(0);
  });

  it("returns raw SQLite compound SELECT ORDER BY errors", () => {
    const c = ctx({ years: [{ year: 2020 }, { year: 2021 }] });
    const text = runCreateArtifact(
      {
        sql:
          "SELECT year FROM years " +
          "UNION ALL SELECT 'Overall' AS year " +
          "ORDER BY CASE WHEN year = 'Overall' THEN 999 ELSE CAST(year AS INTEGER) END",
        artifact: { type: "table", name: "T", description: "d" },
      },
      c,
    );

    expect(text).toContain("SQL error");
    expect(text).toContain("ORDER BY");
    expect(text).not.toContain("wrap the compound query");
    expect(c.artifactQueue.length).toBe(0);
  });

  it("returns raw date_trunc errors", () => {
    const c = ctx({ dates: [{ date: "2024-01-01" }] });
    const text = runCreateArtifact(
      {
        sql: "SELECT date_trunc('quarter', date) AS quarter FROM dates",
        artifact: { type: "table", name: "T", description: "d" },
      },
      c,
    );

    expect(text).toContain("SQL error");
    expect(text).toContain("no such function: date_trunc");
    expect(text).not.toContain("SQLite does not support date_trunc");
    expect(text).not.toContain("substr(date, 1, 4)");
    expect(c.artifactQueue.length).toBe(0);
  });

  it("lists loaded columns when SQL references a missing column", () => {
    const c = ctx({
      ctx_unrate_series: [{ date: "2024-01-01", unrate: 3.9 }],
      cpi: [{ date: "2024-01-01", country: "united_states", value: 310.3 }],
    });
    const text = runCreateArtifact(
      {
        sql: "SELECT date, unrate, cpi AS cpi_value FROM ctx_unrate_series JOIN cpi USING(date)",
        artifact: { type: "table", name: "UNRATE vs CPI", description: "d" },
      },
      c,
    );

    expect(text).toContain("SQL error: no such column: cpi");
    expect(text).toContain('"cpi" (1 rows; columns: "date", "country", "value")');
    expect(text).toContain('"ctx_unrate_series" (1 rows; columns: "date", "unrate")');
    expect(c.artifactQueue.length).toBe(0);
  });
});

describe("runCreateArtifact — table happy path", () => {
  it("pushes a table artifact onto the queue from SQL rows", () => {
    const c = ctx({ prices });
    const text = runCreateArtifact(
      {
        sql: "SELECT * FROM prices",
        artifact: { type: "table", name: "Top Closes", description: "test" },
      },
      c,
    );
    expect(text).toContain("Created table artifact");
    const artifact = lastArtifactPayload(c.artifactQueue) as {
      type: string;
      name: string;
      content: unknown[];
    };
    expect(artifact.type).toBe("table");
    expect(artifact.name).toBe("Top Closes");
    expect(artifact.content.length).toBe(2);
  });

  it("pushes a table artifact from inline data", () => {
    const c = ctx();
    runCreateArtifact(
      { data: prices, artifact: { type: "table", name: "Inline", description: "" } },
      c,
    );
    const artifact = lastArtifactPayload(c.artifactQueue) as { content: unknown[] };
    expect(artifact.content).toEqual(prices);
  });

  it("truncates rows over 500 in artifact.content", () => {
    const big = Array.from({ length: 600 }, (_, i) => ({ id: i }));
    const c = ctx();
    runCreateArtifact(
      { data: big, artifact: { type: "table", name: "Big", description: "" } },
      c,
    );
    const artifact = lastArtifactPayload(c.artifactQueue) as { content: unknown[] };
    expect(artifact.content.length).toBe(500);
  });

  it("emits a chart artifact from from_table_id without running any SQL", () => {
    const c = ctx({ prices });
    const text = runCreateArtifact(
      {
        from_table_id: "prices",
        artifact: {
          type: "chart",
          chartType: "bar",
          xKey: "symbol",
          yKey: ["close"],
          name: "From table",
          description: "by id",
        },
      },
      c,
    );
    expect(text).toContain("Created chart artifact");
    const artifact = lastArtifactPayload(c.artifactQueue) as {
      type: string;
      content: unknown[];
      chart_params: unknown;
    };
    expect(artifact.type).toBe("chart");
    expect(artifact.content).toEqual(prices);
    expect(artifact.chart_params).toMatchObject({ chartType: "bar" });
  });

  it("emits from_table_id rows with the same sanitized column shape as SQL", () => {
    const c = ctx({ energy_consumption__renewables_and_revenue: energyRows });
    const text = runCreateArtifact(
      {
        from_table_id: "energy_consumption__renewables_and_revenue",
        artifact: {
          type: "chart",
          chartType: "line",
          xKey: "year",
          yKey: ["renewable_energy_percent"],
          name: "Renewable Energy Trend",
          description: "trend",
        },
      },
      c,
    );
    expect(text).toContain("Created chart artifact");
    const artifact = lastArtifactPayload(c.artifactQueue) as {
      type: string;
      content: Array<Record<string, unknown>>;
      chart_params: unknown;
    };
    expect(artifact.type).toBe("chart");
    expect(artifact.content[0]).toEqual({
      year: 2020,
      energy_total_mwh: 980000,
      renewable_energy_percent: 12,
    });
    expect(artifact.chart_params).toEqual({
      chartType: "line",
      xKey: "year",
      yKey: ["renewable_energy_percent"],
    });
  });
});

describe("runCreateArtifact — chart happy path", () => {
  it("emits axis chart_params for line/bar/scatter", () => {
    const c = ctx();
    runCreateArtifact(
      {
        data: prices,
        artifact: {
          type: "chart",
          chartType: "line",
          xKey: "symbol",
          yKey: ["close"],
          name: "Line",
          description: "",
        },
      },
      c,
    );
    const artifact = lastArtifactPayload(c.artifactQueue) as { chart_params: unknown };
    expect(artifact.chart_params).toEqual({
      chartType: "line",
      xKey: "symbol",
      yKey: ["close"],
    });
  });

  it("emits proportion chart_params for pie/donut", () => {
    const c = ctx();
    runCreateArtifact(
      {
        data: prices,
        artifact: {
          type: "chart",
          chartType: "pie",
          angleKey: "close",
          calloutLabelKey: "symbol",
          name: "Pie",
          description: "",
        },
      },
      c,
    );
    const artifact = lastArtifactPayload(c.artifactQueue) as { chart_params: unknown };
    expect(artifact.chart_params).toEqual({
      chartType: "pie",
      angleKey: "close",
      calloutLabelKey: "symbol",
    });
  });
});

describe("runCreateArtifact — chart validation", () => {
  it("rejects chart artifacts whose keys are absent from the emitted rows", () => {
    const c = ctx();
    const text = runCreateArtifact(
      {
        data: energyRows,
        artifact: {
          type: "chart",
          chartType: "line",
          xKey: "year",
          yKey: ["renewable_energy_percent"],
          name: "Bad Keys",
          description: "should fail",
        },
      },
      c,
    );
    expect(text).toContain('chart columns not found: "year", "renewable_energy_percent"');
    expect(text).toContain('"Year"');
    expect(c.artifactQueue.length).toBe(0);
  });

  it("points to similarly named SQL aliases when chart keys miss the final output shape", () => {
    const c = ctx({
      drivers: [
        {
          year: 2024,
          scope3_total: 270900,
          avg_renewable_pct_scaled: 875000,
          avg_supplier_esg_pct_scaled: 720000,
        },
      ],
    });
    const text = runCreateArtifact(
      {
        sql: "SELECT * FROM drivers",
        artifact: {
          type: "chart",
          chartType: "line",
          xKey: "year",
          yKey: ["avg_renewable_pct", "avg_supplier_esg_pct"],
          name: "Scope 3 Reduction Drivers",
          description: "should fail with alias hint",
        },
      },
      c,
    );

    expect(text).toContain('chart columns not found: "avg_renewable_pct", "avg_supplier_esg_pct"');
    expect(text).not.toContain("Similar output aliases found");
    expect(c.artifactQueue.length).toBe(0);
  });

  it("rejects axis charts without a yKey array", () => {
    const c = ctx();
    const text = runCreateArtifact(
      {
        data: prices,
        artifact: {
          type: "chart",
          chartType: "line",
          xKey: "symbol",
          name: "Missing Y",
          description: "should fail",
        },
      },
      c,
    );
    expect(text).toContain("line/bar/scatter charts require");
    expect(c.artifactQueue.length).toBe(0);
  });
});

describe("createArtifactDescription", () => {
  it("documents the model-facing chart shape explicitly", () => {
    expect(createArtifactDescription).toContain("type: 'chart'");
    expect(createArtifactDescription).toContain("chartType: 'line'");
    expect(createArtifactDescription).toContain("yKey: ['column']");
    expect(createArtifactDescription).toContain("Never use type: 'line'");
    expect(createArtifactDescription).toContain("chart xKey/yKey must match the final SELECT output keys exactly");
    expect(createArtifactDescription).toContain("Do not switch to `data` unless you are passing raw row objects");
    expect(createArtifactDescription).toContain("Call peek_table before this tool");
    expect(createArtifactDescription).toContain("execute_sql result sets and CTE aliases are not persistent tables");
  });
});
