/**
 * `create_table_from_text` — extract a tabular dataset from unstructured text.
 *
 * The model passes a chunk of free text (e.g. pasted from a press release) and
 * a target name/description; we call the cheap LLM helper to produce a JSON
 * array of objects, drop it into `pendingTables` for downstream SQL, and emit
 * a `TableArtifact` so the workspace renders the result immediately.
 *
 * State-bound — closes over `pendingTables` + `artifactQueue` and reads no
 * MCP server state, satisfying the CLAUDE.md "execute only when state-bound
 * to in-process data" rule.
 */

import { tool } from "ai";
import { z } from "zod";
import { singleShotLlm, parseJsonResponse } from "../../lib/llm";
import { messageArtifact } from "../../protocol/events";
import { analyzeTable, type TableInfo } from "../../sql/loader";
import { rememberRows } from "../row-cache";
import { setPendingTable } from "../pending-tables";
import type { SSEEvent, TableArtifact } from "../../protocol/types";
import { getLogger } from "../../lib/logger";

const logger = getLogger(["app", "tools", "table_from_text"]);

const MAX_TEXT_CHARS = 50_000;
const MAX_ROWS = 500;

export const tableFromTextSchema = z.object({
  text: z
    .string()
    .min(1)
    .describe(
      "The raw unstructured text to extract a table from. Up to 50k chars.",
    ),
  name: z
    .string()
    .min(1)
    .describe("Display + SQL table name. snake_case-ish; will be sanitized."),
  description: z
    .string()
    .describe("Short description of what the table represents."),
});

export const tableFromTextDescription =
  "Extract structured rows from unstructured text and emit a table artifact. " +
  "Use when the user pastes a passage that lists items + attributes (financial table in prose, list of companies with metrics, etc.). " +
  "The resulting table is also loaded into the SQL family so you can immediately execute_sql against it.";

export type TableFromTextArgs = z.infer<typeof tableFromTextSchema>;

export interface TableFromTextContext {
  pendingTables: Map<string, Record<string, unknown>[]>;
  tablesShipped: Set<string>;
  artifactQueue: SSEEvent[];
  tables: TableInfo[];
  conversationId: string;
}

export async function runTableFromText(
  args: TableFromTextArgs,
  ctx: TableFromTextContext,
): Promise<string> {
  const startedAt = Date.now();
  const text = args.text.slice(0, MAX_TEXT_CHARS);
  const prompt =
    "Extract a single tabular dataset from the text below. " +
    "Return ONLY a JSON array of objects (one per row). " +
    "Keys must be lowercase snake_case. Numeric values must be numbers, not strings. " +
    "If no table can reasonably be extracted, return [].\n\n" +
    `Text:\n${text}\n\nJSON:`;
  const raw = await singleShotLlm(prompt, { maxTokens: 2048, functionId: "tool.create-table-from-text" });
  const rows = parseJsonResponse<Record<string, unknown>[]>(raw, []);

  if (!Array.isArray(rows) || rows.length === 0) {
    logger.warn("create_table_from_text produced no rows", {
      name: args.name,
      rawPreview: raw.slice(0, 200),
    });
    return `Could not extract a table from the provided text. LLM response: ${raw.slice(0, 200)}`;
  }
  const limited = rows.length > MAX_ROWS ? rows.slice(0, MAX_ROWS) : rows;

  const tableInfo = analyzeTable(args.name, limited);
  ctx.tables.push(tableInfo);
  setPendingTable(tableInfo.tableName, limited, ctx.pendingTables, ctx.tablesShipped);
  rememberRows(ctx.conversationId, tableInfo.tableName, limited);

  const artifact: TableArtifact = {
    type: "table",
    uuid: crypto.randomUUID(),
    name: args.name,
    description: args.description,
    content: limited,
  };
  ctx.artifactQueue.push(messageArtifact(artifact));

  logger.info("create_table_from_text exit", {
    name: args.name,
    rows: limited.length,
    tableName: tableInfo.tableName,
    ms: Date.now() - startedAt,
  });
  return (
    `Extracted ${limited.length} row${limited.length === 1 ? "" : "s"} into table "${tableInfo.tableName}". ` +
    "Query with execute_sql. The table artifact is already rendered."
  );
}

export function makeTableFromTextTool(ctx: TableFromTextContext) {
  return tool({
    description: tableFromTextDescription,
    inputSchema: tableFromTextSchema,
    execute: async (args) =>
      runTableFromText(args as TableFromTextArgs, ctx),
  });
}
