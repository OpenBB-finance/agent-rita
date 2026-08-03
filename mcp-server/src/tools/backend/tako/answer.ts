import { z } from "zod";
import { textItem, type ContentItem } from "../../../lib/typed";
import { callTakoTool, withFreeTierHint, errorText } from "./client";
import { mapAnswerResult } from "./map-results";

export const takoAnswerSchema = {
  query: z
    .string()
    .min(1)
    .describe(
      'A specific data question to answer with grounded prose (e.g. "What was US GDP growth in 2024?"). For charts or multiple results use tako_search instead.',
    ),
};

export const takoAnswerDescription =
  "Ask one specific data question and get a concise, citation-backed answer grounded in live financial, economic, and web data. This tool supplies the data itself — no connected widget or upload is needed. Best for a single factual metric; use tako_search when the user wants a chart, a calculation over a series, or several results.";

export async function takoAnswerHandler({
  query,
}: {
  query: string;
}): Promise<{ content: ContentItem[] }> {
  try {
    const res = await callTakoTool("tako_answer", { query });
    if (res.isError) return { content: [textItem(withFreeTierHint(errorText(res.text)))] };
    return { content: mapAnswerResult(res.text, res.structured) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [
        textItem(
          withFreeTierHint(
            `Tako answer failed: ${msg}. Try again once; if it persists, answer from other tools.`,
          ),
        ),
      ],
    };
  }
}
