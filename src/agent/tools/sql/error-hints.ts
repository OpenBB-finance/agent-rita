/**
 * Recovery step appended wherever the SQL family reports a table it cannot
 * find. Listing the loaded tables alone reads as terminal state, and the model
 * then reports the data as unavailable — or asks the user for permission to
 * load it — even though the widget is listed in the system prompt with its
 * uuid and one `get_widget_data` call would load it.
 */
export const FETCH_MISSING_TABLE_HINT =
  " Widget data becomes queryable only after you fetch it: if the table you need belongs to a widget that has not been fetched in this conversation, call get_widget_data for that widget now, then retry with the queryable table name it reports. Do not ask the user for permission first, and do not report the data as unavailable before that fetch has been tried.";

export const NO_TABLES_LOADED_MESSAGE =
  "No widget data is loaded for this conversation yet." + FETCH_MISSING_TABLE_HINT;

interface HintTable {
  tableName: string;
  rowCount: number;
  columns: { name: string }[];
}

function columnSummary(table: HintTable): string {
  return table.columns.map((column) => `"${column.name}"`).join(", ");
}

export function availableTablesHint(loaded: HintTable[]): string {
  return loaded.length > 0
    ? ` Available tables: ${loaded
      .map(
        (table) =>
          `"${table.tableName}" (${table.rowCount} rows; columns: ${columnSummary(table)})`,
      )
      .join("; ")}.${FETCH_MISSING_TABLE_HINT}`
    : ` ${NO_TABLES_LOADED_MESSAGE}`;
}
