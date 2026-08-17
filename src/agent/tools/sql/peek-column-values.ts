/**
 * peek_column_values — show unique values for a column. Stateless.
 */

import { tool } from "ai";
import { z } from "zod";
import { buildDb, tableNotFoundMessage } from "./db";
import { NO_TABLES_LOADED_MESSAGE } from "./error-hints";
import { rejectUnsafeTableName } from "./safety";
import { getLogger } from "../../../lib/logger";
import { DISPLAY_SUMMARY_TOOL_TEXT, displaySummarySchema } from "../progress";

const logger = getLogger(["app", "tools", "sql", "peek_column_values"]);

const MAX_VALUES = 50;

export const peekColumnValuesSchema = z.object({
  display_summary: displaySummarySchema,
  column: z.string().describe("Sanitized column name to inspect."),
  table_name: z
    .string()
    .optional()
    .describe("Table name. Optional if only one table is loaded."),
});

export const peekColumnValuesDescription =
  "Show up to 50 unique values from a column. " +
  DISPLAY_SUMMARY_TOOL_TEXT + " " +
  "Useful for understanding categorical data before filtering with execute_sql.";

function sanitize(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/^(\d)/, "col_$1")
    .toLowerCase();
}

export interface PeekColumnValuesContext {
  pendingTables: Map<string, Record<string, unknown>[]>;
}

export function runPeekColumnValues(
  args: { column: string; table_name?: string },
  ctx: PeekColumnValuesContext,
): string {
  logger.info(
    `peek_column_values entry column=${JSON.stringify(args.column)} table=${args.table_name ?? "(default)"}`,
    {},
  );
  const { db, loaded } = buildDb(ctx.pendingTables);
  try {
    if (loaded.length === 0) return NO_TABLES_LOADED_MESSAGE;
    const target = args.table_name ?? loaded[0].tableName;
    const denyMsg = rejectUnsafeTableName(target);
    if (denyMsg) return denyMsg;
    if (!loaded.find((t) => t.tableName === target)) {
      return tableNotFoundMessage(target, loaded);
    }
    const col = sanitize(args.column);
    try {
      const rows = db
        .query(`SELECT DISTINCT "${col}" FROM "${target}" LIMIT ${MAX_VALUES}`)
        .all() as Record<string, unknown>[];
      const values = rows.map((r) => Object.values(r)[0]);
      return (
        `Column "${col}" in "${target}" — ${values.length} unique values (max ${MAX_VALUES} shown):\n` +
        JSON.stringify(values, null, 2)
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Query failed: ${msg}`;
    }
  } finally {
    db.close();
  }
}

export function makePeekColumnValuesTool(ctx: PeekColumnValuesContext) {
  return tool({
    description: peekColumnValuesDescription,
    inputSchema: peekColumnValuesSchema,
    execute: async (args) => runPeekColumnValues(args, ctx),
  });
}
