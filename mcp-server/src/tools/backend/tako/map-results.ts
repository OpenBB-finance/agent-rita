/**
 * Pure mappers from Tako MCP results into Rita typed content items.
 *
 * Loose validation on purpose: Tako's backend evolves its shape
 * independently, so every schema is .passthrough() with optional fields and
 * a failed parse degrades to plain-text passthrough (the model still gets a
 * usable answer; only the citation and table extras are lost).
 */
import { z } from "zod";
import {
  textItem,
  webCitationItem,
  sqliteTableItem,
  type ContentItem,
} from "../../../lib/typed";

/**
 * The inline preview of a card's underlying series. Exportable cards carry it
 * on every search, free tier included, so the model gets real numbers to
 * compute and chart from instead of the prose summary in the text channel.
 */
const datasetSchema = z
  .object({
    columns: z.array(z.object({ name: z.string() }).passthrough()),
    rows: z.array(z.array(z.unknown())),
  })
  .passthrough();

const cardSchema = z
  .object({
    title: z.string().nullable().optional(),
    webpage_url: z.string().nullable().optional(),
    content: z
      .object({ dataset: datasetSchema.nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
type TakoCard = z.infer<typeof cardSchema>;

const webResultSchema = z
  .object({ title: z.string(), url: z.string() })
  .passthrough();

/** Shape shared by tako_search and tako_answer: both ground on cards + web results. */
const citedResultSchema = z
  .object({
    cards: z.array(cardSchema).optional(),
    web_results: z.array(z.unknown()).optional(),
  })
  .passthrough();

/**
 * One entry of tako_contents' batch response. Rows live per-URL under
 * `results[]`, not at the top level: the endpoint accepts several URLs and
 * reports each independently, so a single URL's failure arrives as `error`
 * on its own entry while the others still carry payloads.
 */
const contentsEntrySchema = z
  .object({
    url: z.string().optional(),
    error: z.string().nullable().optional(),
    records: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
    data: z.string().nullable().optional(),
    total_rows: z.number().nullable().optional(),
    truncated: z.boolean().nullable().optional(),
  })
  .passthrough();

const contentsStructuredSchema = z
  .object({ results: z.array(z.unknown()).optional() })
  .passthrough();

const MAX_CITATIONS = 10;
/**
 * Upstream caps rows per request, but that cap is a request hint the server
 * is free to exceed. These rows are JSON-stringified across two HTTP hops and
 * held in request-scoped agent state, so bound them here too.
 */
const MAX_TABLE_ROWS = 2000;
/** Matches fetch_webpage's cap, so no single tool can flood model context. */
const MAX_TEXT_CHARS = 20_000;

function capText(text: string): string {
  return text.length > MAX_TEXT_CHARS
    ? `${text.slice(0, MAX_TEXT_CHARS)}\n[truncated]`
    : text;
}
function isHttpUrl(u: string): boolean {
  try {
    const p = new URL(u).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}

function citationItems(pairs: { url: string; title: string }[]): ContentItem[] {
  const seen = new Set<string>();
  const items: ContentItem[] = [];
  for (const p of pairs) {
    if (seen.has(p.url)) continue;
    seen.add(p.url);
    items.push(webCitationItem({ url: p.url, title: p.title }));
    if (items.length >= MAX_CITATIONS) break;
  }
  return items;
}

/**
 * Cards and web results are the citation source for BOTH search and answer.
 * Upstream renders its source list as bare `URL: <url>` lines rather than
 * markdown links, so the structured channel is the only reliable extraction
 * point.
 */
function citationPairs(
  cards: TakoCard[],
  rawWebResults: unknown[],
): { url: string; title: string }[] {
  const pairs: { url: string; title: string }[] = [];
  for (const c of cards) {
    if (c.webpage_url && isHttpUrl(c.webpage_url)) {
      pairs.push({ url: c.webpage_url, title: c.title ?? "Tako chart" });
    }
  }
  for (const w of rawWebResults) {
    const wr = webResultSchema.safeParse(w);
    if (wr.success && isHttpUrl(wr.data.url)) {
      pairs.push({ url: wr.data.url, title: wr.data.title });
    }
  }
  return pairs;
}

/** At most this many card series become tables, so a broad search cannot flood state. */
const MAX_CARD_TABLES = 3;

/** Turn a card's column/row dataset into row objects keyed by column name. */
function cardTable(card: TakoCard): { name: string; rows: Record<string, unknown>[] } | null {
  const dataset = card.content?.dataset;
  if (!dataset || dataset.rows.length === 0) return null;
  const names = dataset.columns.map((c) => c.name);
  const rows = dataset.rows.slice(0, MAX_TABLE_ROWS).map((row) => {
    const out: Record<string, unknown> = {};
    names.forEach((n, i) => {
      out[n] = row[i] ?? null;
    });
    return out;
  });
  return { name: deriveTableName(card.webpage_url ?? "", card.title ?? undefined), rows };
}

/**
 * No chart artifact, deliberately. A Tako card cannot be displayed inline: the
 * Workspace strips `<iframe>` from html artifacts, and both the embed and the
 * card page refuse to be framed, so every rendering attempt produced an empty
 * panel. Cards surface as citations, and their underlying series ships as a
 * SQL table so the agent can compute over it and chart it with its own
 * artifact — which the workspace does render.
 */
export function mapSearchResult(text: string, structured: unknown): ContentItem[] {
  const parsed = citedResultSchema.safeParse(structured);
  if (!parsed.success) return [textItem(capText(text))];

  const cards = parsed.data.cards ?? [];
  const pairs = citationPairs(cards, parsed.data.web_results ?? []);

  const tables: ContentItem[] = [];
  const loaded: string[] = [];
  const seen = new Set<string>();
  for (const card of cards) {
    if (loaded.length >= MAX_CARD_TABLES) break;
    const table = cardTable(card);
    if (!table || seen.has(table.name)) continue;
    seen.add(table.name);
    tables.push(sqliteTableItem(table.name, table.rows));
    loaded.push(`"${table.name}" (${table.rows.length} rows)`);
  }

  const body = capText(text);
  const ack =
    loaded.length > 0
      ? `\n\nUnderlying data loaded as SQL ${loaded.length === 1 ? "table" : "tables"}: ${loaded.join(", ")}. These are the most recent rows, not necessarily the full series. Query them with execute_sql, and build any chart with create_artifact from that result rather than from the summary text above.`
      : "";
  return [...tables, textItem(`${body}${ack}`), ...citationItems(pairs)];
}

export function mapAnswerResult(text: string, structured: unknown): ContentItem[] {
  const parsed = citedResultSchema.safeParse(structured);
  if (!parsed.success) return [textItem(capText(text))];
  const pairs = citationPairs(parsed.data.cards ?? [], parsed.data.web_results ?? []);
  return [textItem(capText(text)), ...citationItems(pairs)];
}

export function mapContentsResult(
  text: string,
  structured: unknown,
  tableName: string,
): ContentItem[] {
  const parsed = contentsStructuredSchema.safeParse(structured);
  if (!parsed.success) return [textItem(capText(text))];

  // Batch response: take the first entry that actually carries rows, so a
  // leading per-URL error doesn't hide a later payload.
  let entry: z.infer<typeof contentsEntrySchema> | null = null;
  for (const raw of parsed.data.results ?? []) {
    const e = contentsEntrySchema.safeParse(raw);
    if (e.success && (e.data.records?.length ?? 0) > 0) {
      entry = e.data;
      break;
    }
  }
  if (!entry) return [textItem(capText(text))];

  const records = (entry.records ?? []).slice(0, MAX_TABLE_ROWS);
  const total = entry.total_rows;
  const truncatedNote =
    entry.truncated === true
      ? ` (truncated${typeof total === "number" ? ` from ${total} total rows; raise max_rows to fetch more` : ""})`
      : "";
  return [
    sqliteTableItem(tableName, records),
    textItem(
      `Loaded ${records.length} rows into SQL table "${tableName}"${truncatedNote}. Query it with execute_sql.`,
    ),
  ];
}

const TABLE_NAME_MAX = 40;

/**
 * Always `tako_`-prefixed: a model-supplied override must not be able to
 * shadow a widget table already loaded in the conversation, since
 * setPendingTable overwrites by name.
 */
export function deriveTableName(url: string, override?: string): string {
  let base = override;
  if (!base) {
    try {
      base = new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "data";
    } catch {
      base = "data";
    }
  }
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^tako_/, "")
    .slice(0, TABLE_NAME_MAX);
  return slug.length === 0 ? "tako_data" : `tako_${slug}`;
}
