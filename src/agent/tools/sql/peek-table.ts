/**
 * peek_table — preview rows + schema from a loaded table.
 * Stateless: fresh in-memory DB per call.
 */

import { tool } from "ai";
import { z } from "zod";
import { buildDb, describeColumns, tableNotFoundMessage } from "./db";
import { NO_TABLES_LOADED_MESSAGE } from "./error-hints";
import { rejectUnsafeTableName } from "./safety";
import { getLogger } from "../../../lib/logger";
import { DISPLAY_SUMMARY_TOOL_TEXT, displaySummarySchema } from "../progress";

const logger = getLogger(["app", "tools", "sql", "peek_table"]);

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

export const peekTableSchema = z.object({
  display_summary: displaySummarySchema,
  table_name: z
    .string()
    .optional()
    .describe(
      "Queryable table name to preview. Optional if only one table is loaded. Use the sanitized table name shown in loaded table context.",
    ),
  limit: z
    .number()
    .optional()
    .describe(`Rows to show (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
});

export const peekTableDescription =
  "Preview rows + schema from a widget data table loaded for this conversation. " +
  DISPLAY_SUMMARY_TOOL_TEXT + " " +
  "Cheap, fast, and useful before writing SQL for execute_sql or create_artifact. " +
  "Use this first whenever table or column names are uncertain. " +
  "The output lists the exact queryable table and column names to use in SQL and chart xKey/yKey values; original widget labels are reference only. " +
  "Only use table names that have already been loaded into the conversation; widget ids are not queryable tables until get_widget_data has fetched that widget.";

export interface PeekTableContext {
  pendingTables: Map<string, Record<string, unknown>[]>;
}

export function runPeekTable(
  args: { table_name?: string; limit?: number },
  ctx: PeekTableContext,
): string {
  logger.info(
    `peek_table entry name=${args.table_name ?? "(default)"} limit=${args.limit ?? DEFAULT_LIMIT}`,
    {},
  );
  const { db, loaded } = buildDb(ctx.pendingTables);
  try {
    if (loaded.length === 0) {
      return NO_TABLES_LOADED_MESSAGE;
    }
    const target = args.table_name ?? loaded[0].tableName;
    const denyMsg = rejectUnsafeTableName(target);
    if (denyMsg) return denyMsg;
    const tInfo = loaded.find((t) => t.tableName === target);
    if (!tInfo) {
      return tableNotFoundMessage(target, loaded);
    }
    const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const rows = db
      .query(`SELECT * FROM "${target}" LIMIT ${limit}`)
      .all() as Record<string, unknown>[];
    return (
      `Table "${target}" (${tInfo.rowCount} rows total)\n` +
      `Columns:\n${describeColumns(tInfo)}\n\n` +
      `First ${rows.length} rows:\n${JSON.stringify(rows, null, 2)}`
    );
  } finally {
    db.close();
  }
}

export function makePeekTableTool(ctx: PeekTableContext) {
  return tool({
    description: peekTableDescription,
    inputSchema: peekTableSchema,
    execute: async (args) => runPeekTable(args, ctx),
  });
}
