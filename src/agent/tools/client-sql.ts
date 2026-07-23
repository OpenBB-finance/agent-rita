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
