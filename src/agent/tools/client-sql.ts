/**
 * Round-trip tool: agent writes DuckDB SQL, workspace executes in browser WASM.
 * No local execute — harness emits execute_client_sql SSE and waits for re-POST.
 */

import { tool } from "ai";
import { z } from "zod";
import { DISPLAY_SUMMARY_TOOL_TEXT, displaySummarySchema } from "./progress";

const clientSqlQuerySchema = z.object({
  sql: z
    .string()
    .describe(
      "DuckDB SELECT/WITH SQL. Joins across registered widget tables are allowed. " +
        "Do not use ATTACH, INSTALL, LOAD, COPY, PRAGMA, SET, or multi-statement SQL.",
    ),
  widget_uuids: z
    .array(z.string())
    .min(1)
    .describe(
      "UUIDs of widgets whose tables this query needs. Workspace registers them in DuckDB before running SQL.",
    ),
  row_limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe(
      "Max rows to return (default 500, max 1000). If the result has exactly row_limit rows it may be truncated — refine/aggregate further.",
    ),
});

export const clientSqlSchema = z.object({
  display_summary: displaySummarySchema,
  queries: z
    .array(clientSqlQuerySchema)
    .min(1)
    .max(5)
    .describe("One or more DuckDB queries to run against client-registered widget tables."),
});

export type ClientSqlArgs = z.infer<typeof clientSqlSchema>;

export const CLIENT_SQL_TOOL_NAME = "execute_client_sql" as const;

/**
 * A widget that is connected to the user's account but not on the dashboard has
 * no rows in the browser and no instance uuid, so it cannot be queried yet.
 * This ref mirrors get_widget_data's data-source shape: an instance uuid, or
 * origin + widget_id for a catalog widget.
 */
const prepareWidgetSchema = z
  .object({
    widget_uuid: z
      .string()
      .optional()
      .describe(
        "Instance uuid, for a widget that already exists on a dashboard. " +
          "Use the `uuid` returned by search_widgets when `location` is not 'connected'.",
      ),
    widget_id: z
      .string()
      .optional()
      .describe(
        "Catalog widget id, for a connected widget with no dashboard instance " +
          "(search_widgets `location: 'connected'`). Requires `origin`.",
      ),
    origin: z.string().optional().describe("Widget origin, required with widget_id."),
    input_args: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Parameter values to fetch with, e.g. { ticker: 'NVDA' }. REQUIRED when the " +
          "widget has params — a connected widget has no user-chosen values to fall back " +
          "on, so omitting them is refused rather than silently answered for a default.",
      ),
  })
  .refine((w) => Boolean(w.widget_uuid || w.widget_id), {
    message: "Either widget_uuid or widget_id is required",
  });

export const prepareClientSqlSchema = z.object({
  display_summary: displaySummarySchema,
  widgets: z
    .array(prepareWidgetSchema)
    .min(1)
    .max(10)
    .describe("Widgets to load into the browser DuckDB instance."),
});

export type PrepareClientSqlArgs = z.infer<typeof prepareClientSqlSchema>;

export const PREPARE_CLIENT_SQL_TOOL_NAME = "prepare_client_sql_tables" as const;

export function makePrepareClientSqlTool() {
  return tool({
    description:
      "Load a widget that is NOT on the current dashboard into the browser DuckDB instance so it becomes queryable. " +
      "Returns the real table schema (table_name, column names and types, row count) derived from the rows that " +
      "actually arrived, plus the params they were fetched with. " +
      "Use it when search_widgets found a widget with location 'connected' and the question needs filtering, " +
      "aggregation, or a join. " +
      "Widgets already listed under '## Client-Queryable Widgets' are loaded — do not prepare those again. " +
      "Then pass the returned widget_uuid in execute_client_sql.widget_uuids and use the returned table_name in SQL. " +
      "Supply input_args for every param the widget declares; a connected widget has no user-selected values, so " +
      "guessing produces an answer about the wrong entity. " +
      DISPLAY_SUMMARY_TOOL_TEXT,
    inputSchema: prepareClientSqlSchema,
  });
}

export function makeClientSqlTool() {
  return tool({
    description:
      "Run DuckDB SQL in the user's browser against widget tables already loaded on the dashboard. " +
      "Use this instead of get_widget_data when you need to filter, aggregate, or join client-queryable widgets " +
      "(see '## Client-Queryable Widgets'). " +
      "Dialect: DuckDB. Results are capped (default 500, max 1000 rows). " +
      "If the result has exactly row_limit rows it may be truncated — refine the SQL or aggregate. " +
      "On SQL errors, the DuckDB message is returned verbatim so you can fix and retry. " +
      DISPLAY_SUMMARY_TOOL_TEXT,
    inputSchema: clientSqlSchema,
  });
}
