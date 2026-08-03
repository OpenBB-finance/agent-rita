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
      .join("; ")}.`
    : " No tables shipped — did the widget data load? If you loaded a widget with " +
      "prepare_client_sql_tables, its table lives in the user's browser and this engine cannot " +
      "see it: query that table with execute_client_sql instead.";
}
