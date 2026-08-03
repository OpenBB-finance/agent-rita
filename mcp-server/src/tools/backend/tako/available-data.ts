import { z } from "zod";
import { textItem, type ContentItem } from "../../../lib/typed";
import { callTakoTool, withFreeTierHint, errorText } from "./client";

export const takoAvailableDataSchema = {
  q: z
    .string()
    .min(2)
    .describe(
      'The NAME of one entity or one metric (e.g. "Carnival", "unemployment rate") — not a full question. Look up the entity, then read the returned coverage list for the metric you need.',
    ),
  types: z
    .enum(["entity", "metric"])
    .optional()
    .describe(
      'Narrow resolution to a "thing" (entity) or a "measure" (metric). Omit to search both.',
    ),
};

export const takoAvailableDataDescription =
  "Check what data Tako actually has for one entity or metric — free and fast. Call this before tako_search when unsure coverage exists; it returns the exact metric names to search with, avoiding wasted searches.";

export async function takoAvailableDataHandler({
  q,
  types,
}: {
  q: string;
  types?: "entity" | "metric";
}): Promise<{ content: ContentItem[] }> {
  try {
    const res = await callTakoTool("tako_available_data", {
      q,
      ...(types ? { types } : {}),
    });
    if (res.isError) return { content: [textItem(withFreeTierHint(errorText(res.text)))] };
    return { content: [textItem(res.text)] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [textItem(withFreeTierHint(`Tako coverage lookup failed: ${msg}.`))],
    };
  }
}
