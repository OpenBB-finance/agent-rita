import { z } from "zod";
import { textItem, type ContentItem } from "../../../lib/typed";
import { callTakoTool, withFreeTierHint, errorText } from "./client";
import { mapContentsResult, deriveTableName } from "./map-results";

export const takoContentsSchema = {
  url: z
    .string()
    .min(1)
    .describe(
      "Must be a URL returned by a prior tako_search or tako_answer call — for any other URL use fetch_webpage instead. A Tako card webpage_url fetches its underlying rows; a web result url from those same results fetches the page text. Only exportable cards can be fetched; on a not-exportable error use the card's inline preview instead.",
    ),
  max_rows: z
    .number()
    .int()
    .min(1)
    .max(2000)
    .optional()
    .describe(
      "Card rows cap. Omit for the default 20 most-recent rows; raise up to 2000 when you need the full series.",
    ),
  table_name: z
    .string()
    .min(1)
    .optional()
    .describe(
      'SQL table name (snake_case) to store fetched card rows under, e.g. "nvda_revenue". Always stored with a tako_ prefix. Defaults to a name derived from the URL.',
    ),
};

export const takoContentsDescription =
  "Fetch the real content behind one tako_search / tako_answer result URL: a Tako card's underlying rows land as a SQL table you can query with execute_sql, and a web URL returns the page's text. Call after a search when you need the full data to compute over.";

export async function takoContentsHandler({
  url,
  max_rows,
  table_name,
}: {
  url: string;
  max_rows?: number;
  table_name?: string;
}): Promise<{ content: ContentItem[] }> {
  try {
    // `urls` is the current batch form; the single-URL `url` field is
    // deprecated upstream. We send one URL per call so a failure maps to one
    // tool result the model can act on.
    const res = await callTakoTool("tako_contents", {
      urls: [url],
      content_format: "json_records",
      ...(max_rows != null ? { max_rows } : {}),
    });
    if (res.isError) return { content: [textItem(withFreeTierHint(errorText(res.text)))] };
    return {
      content: mapContentsResult(res.text, res.structured, deriveTableName(url, table_name)),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [textItem(withFreeTierHint(`Tako contents fetch failed: ${msg}.`))],
    };
  }
}
