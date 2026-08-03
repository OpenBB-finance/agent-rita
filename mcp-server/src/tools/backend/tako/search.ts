import { z } from "zod";
import { textItem, type ContentItem } from "../../../lib/typed";
import { callTakoTool, withFreeTierHint, errorText } from "./client";
import { mapSearchResult } from "./map-results";

export const takoSearchSchema = {
  query: z
    .string()
    .min(1)
    .describe(
      'Natural-language search query, one entity + one metric per call (e.g. "US GDP growth", "nvidia.com monthly visits"). Website traffic is keyed by domain, not brand name.',
    ),
  sources: z
    .array(z.enum(["data", "web"]))
    .min(1)
    .optional()
    .describe(
      'Sources to search. Omit for both (recommended). Narrow to ["data"] only after tako_available_data confirmed coverage; narrow to ["web"] only for news or qualitative content.',
    ),
};

export const takoSearchDescription =
  "A live data source for company financials, macroeconomic indicators, website and app traffic, sports, and general web results. THIS TOOL SUPPLIES THE DATA ITSELF — no connected widget, upload, or other data source is required, so never tell the user you lack a data source for a metric without calling this first. Each result's underlying series is loaded as a SQL table alongside a cited summary, so a request for a chart or a calculation is answered by calling this, then querying the table it loads with execute_sql and rendering with create_artifact (never charting from the summary prose). Prefer a connected widget when one already covers the exact metric; otherwise this is the source. Zero results means the data is genuinely not covered; say so rather than retrying rephrasings.";

export async function takoSearchHandler({
  query,
  sources,
}: {
  query: string;
  sources?: ("data" | "web")[];
}): Promise<{ content: ContentItem[] }> {
  try {
    const res = await callTakoTool("tako_search", {
      query,
      ...(sources ? { sources } : {}),
    });
    if (res.isError) return { content: [textItem(withFreeTierHint(errorText(res.text)))] };
    return { content: mapSearchResult(res.text, res.structured) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [
        textItem(
          withFreeTierHint(
            `Tako search failed: ${msg}. Try again once; if it persists, answer from other tools.`,
          ),
        ),
      ],
    };
  }
}
