import { tool } from "ai";
import { z } from "zod";
import type { Widget } from "../../protocol/types";
import { searchWidgets, type TieredWidget, type WidgetTier } from "../../widgets/tiers";
import { getLogger } from "../../lib/logger";
import { DISPLAY_SUMMARY_TOOL_TEXT, displaySummarySchema } from "./progress";

const logger = getLogger(["app", "tools", "search_widgets"]);

const SEARCH_RESULT_CAP = 100;

export const searchWidgetsSchema = z.object({
  display_summary: displaySummarySchema,
  query: z
    .string()
    .describe(
      "Search query — matches against widget name, description, category, and origin. " +
        "Use keywords from the user's question. " +
        "Pass an empty string \"\" to list connected widgets — those added to context first, then those on the current dashboard, then the rest.",
    ),
});

const DISPLAY_ONLY_PREFIXES = ["rich_note", "copilot_table", "iframe", "youtube"];

export type WidgetLocation = "added_to_context" | "on_dashboard" | "connected";

const TIER_TO_LOCATION: Record<WidgetTier, WidgetLocation> = {
  primary: "added_to_context",
  secondary: "on_dashboard",
  extra: "connected",
};

function widgetKind(w: Widget): "data" | "note" | "display" {
  if (w.widget_id.startsWith("rich_note")) return "note";
  if (DISPLAY_ONLY_PREFIXES.some((p) => w.widget_id.startsWith(p))) return "display";
  return "data";
}

export function makeSearchWidgetsTool(
  tiered: TieredWidget[],
  options?: { prepareClientSqlEnabled?: boolean },
) {
  const prepareClientSqlEnabled = Boolean(options?.prepareClientSqlEnabled);
  // The model decides what to do with a match immediately after reading this
  // description, so the routing rule has to live here — a system-prompt section
  // thousands of characters away loses to "pass uuid verbatim to get_widget_data".
  const clientSqlRouting = prepareClientSqlEnabled
    ? " ROUTING for `location: 'connected'` matches: if the question needs filtering, aggregation, top-N, sorting or a join, " +
      "do NOT call get_widget_data — call prepare_client_sql_tables with that match's `widget_id` + `origin` (plus input_args " +
      "for its params), then execute_client_sql against the table it returns. get_widget_data on a connected widget ships every " +
      "row over the wire; use it only when you need the full raw payload."
    : "";
  return tool({
    description:
      `Search for widgets in the user's workspace. Returns up to ${SEARCH_RESULT_CAP} matches plus the total count, ` +
      "with identifiers, descriptions, `kind`, and `location`. " +
      DISPLAY_SUMMARY_TOOL_TEXT + " " +
      "The `uuid` field is the canonical identifier — pass it verbatim to get_widget_data. " +
      "The `widget_id` field is the catalog widget type — pass it with `origin` to create_widget when adding a connected widget to the dashboard. " +
      "Identifiers are often slugs (e.g. 'home_cards', 'market_indices'), not UUID-format. " +
      "Kinds: 'data' (fetchable endpoint — use get_widget_data), 'note' (user text), 'display' (embedded). " +
      "Locations: 'added_to_context' (the user pinned it to this conversation), 'on_dashboard' (visible on the current dashboard), 'connected' (in the user's account but not on the current dashboard). " +
      "Results rank by relevance, then by location (added_to_context > on_dashboard > connected). " +
      "When describing widgets to the user, use these plain phrases — never the words 'primary', 'secondary', 'extra', or 'tier'. " +
      "Prefer 'data' for actual numbers. If both data and note widgets match, ask which the user wants. " +
      "Empty query lists all connected widgets, with widgets added to context first." +
      clientSqlRouting,
    inputSchema: searchWidgetsSchema,
    execute: async ({ query }) => {
      const matches = searchWidgets(tiered, query);
      const results = matches.slice(0, SEARCH_RESULT_CAP).map(({ widget: w, tier }) => ({
        uuid: w.uuid,
        widget_id: w.widget_id,
        name: w.name,
        description: w.description,
        category: w.category ?? "",
        origin: w.origin,
        kind: widgetKind(w),
        location: TIER_TO_LOCATION[tier],
        params: w.params.length
          ? w.params.map(
              (p) =>
                `${p.name}:${p.type}=${p.current_value ?? p.default_value ?? "REQUIRED"}`,
            )
          : undefined,
        // Carried on the row itself so the routing rule is in front of the model
        // at the moment it picks the next tool, not only in the tool description.
        ...(prepareClientSqlEnabled && tier === "extra" && widgetKind(w) === "data"
          ? { sql_ready: "prepare_client_sql_tables" as const }
          : {}),
      }));
      logger.info("Widget search", { query, results: results.length, total: matches.length });
      return {
        matches: results,
        total: matches.length,
        ...(prepareClientSqlEnabled
          ? {
              note: "Matches tagged sql_ready are not on the dashboard. For filter/aggregate/top-N/sort/join questions load them with prepare_client_sql_tables and query with execute_client_sql instead of get_widget_data.",
            }
          : {}),
      };
    },
  });
}
