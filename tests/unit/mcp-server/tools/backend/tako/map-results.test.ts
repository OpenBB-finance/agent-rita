import { describe, it, expect } from "bun:test";
import {
  mapSearchResult,
  mapAnswerResult,
  mapContentsResult,
  deriveTableName,
} from "../../../../../../mcp-server/src/tools/backend/tako/map-results";
import {
  SEARCH_TEXT,
  SEARCH_STRUCTURED,
  ANSWER_TEXT,
  ANSWER_STRUCTURED,
  CONTENTS_CARD_STRUCTURED,
  CONTENTS_CARD_TEXT,
  CONTENTS_WEB_STRUCTURED,
  CONTENTS_WEB_TEXT,
  CONTENTS_MIXED_STRUCTURED,
  CONTENTS_MIXED_TEXT,
  CONTENTS_ALL_FAILED_STRUCTURED,
  contentsStructuredWithRows,
} from "./fixtures";

interface Item {
  text: string;
}

const citationsOf = (items: Item[]): { type: string; url: string; title: string }[] =>
  items
    .filter((i) => i.text.includes('"citation"'))
    .map(
      (i) =>
        (JSON.parse(i.text) as { citation: { type: string; url: string; title: string } }).citation,
    );

const tableOf = (items: Item[]): { name: string; rows: Record<string, unknown>[] } =>
  JSON.parse(items[0]!.text) as { name: string; rows: Record<string, unknown>[] };

/** The plain-text item — index is not stable, tables are emitted before it. */
const textOf = (items: Item[]): string => {
  for (const i of items) {
    try {
      if ((JSON.parse(i.text) as { $rita_kind?: string }).$rita_kind) continue;
    } catch {
      /* not JSON, so it is the plain text item */
    }
    return i.text;
  }
  return "";
};

const CARD = SEARCH_STRUCTURED.cards[0]!;
const WEB = SEARCH_STRUCTURED.web_results[0]!;


/** No Tako mapper may emit an artifact: cards cannot be framed inline. */
function expectNoArtifact(items: { text: string }[]): void {
  for (const item of items) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(item.text);
    } catch {
      continue;
    }
    expect((parsed as { $rita_kind?: string }).$rita_kind).not.toBe("artifact");
  }
}

describe("mapSearchResult (real tako_search response)", () => {
  it("passes text through unchanged with one citation per card and per web result, in order", () => {
    const items = mapSearchResult(SEARCH_TEXT, SEARCH_STRUCTURED);
    expect(textOf(items).startsWith(SEARCH_TEXT)).toBe(true);
    const cites = citationsOf(items);
    expect(cites).toHaveLength(3); // 1 card + 2 web results
    expect(cites[0]).toEqual({
      type: "web",
      url: "https://tako.com/card/UB4jWl49yLz-o8VvKhEx/",
      title: CARD.title,
    });
    expect(cites[1]?.url).toBe(WEB.url);
    expect(cites[2]?.url).toBe(SEARCH_STRUCTURED.web_results[1]!.url);
  });

  it("still cites the card by its webpage_url when it has neither embed nor image url", () => {
    const structured = {
      ...SEARCH_STRUCTURED,
      cards: [{ ...CARD, embed_url: null, image_url: null }],
      web_results: [],
    };
    const items = mapSearchResult("plain", structured);
    expect(textOf(items).startsWith("plain")).toBe(true);
    expect(citationsOf(items)).toHaveLength(1); // webpage_url is still cited
  });

  it("dedupes citations by url", () => {
    const structured = {
      ...SEARCH_STRUCTURED,
      cards: [CARD, { ...CARD, card_id: "dupe" }],
      web_results: [WEB, { ...WEB, title: "same url, different title" }],
    };
    expect(citationsOf(mapSearchResult(SEARCH_TEXT, structured))).toHaveLength(2);
  });

  it("caps citations at 10", () => {
    const structured = {
      ...SEARCH_STRUCTURED,
      web_results: Array.from({ length: 15 }, (_, i) => ({
        ...WEB,
        url: `${WEB.url}?page=${i}`,
        title: `NVIDIA press release ${i}`,
      })),
    };
    expect(citationsOf(mapSearchResult(SEARCH_TEXT, structured))).toHaveLength(10);
  });

  it("caps the text channel at 20000 chars with a truncation marker", () => {
    const items = mapSearchResult("x".repeat(20_050), SEARCH_STRUCTURED);
    const body = items.find((i) => i.text.startsWith("x"))!;
    expect(body.text).toContain("\n[truncated]");
    expect(body.text.startsWith("x".repeat(20_000))).toBe(true);
    expect(body.text).not.toContain("x".repeat(20_001));
  });

  it("does not truncate text at exactly the cap", () => {
    const exact = "y".repeat(20_000);
    const items = mapSearchResult(exact, { cards: [], web_results: [] });
    expect(items[0]?.text).toBe(exact);
  });

  it("falls back to plain text passthrough on invalid structuredContent", () => {
    const items = mapSearchResult("the raw text", { cards: "not-an-array" });
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe("the raw text");
  });

  it("falls back to plain text when structured is undefined", () => {
    const items = mapSearchResult(SEARCH_TEXT, undefined);
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe(SEARCH_TEXT);
  });

  it("drops the citation for a card whose webpage_url is javascript:, but keeps a sibling card with a valid url", () => {
    const badCard = { ...CARD, webpage_url: "javascript:alert(1)" };
    const structured = { ...SEARCH_STRUCTURED, cards: [badCard, CARD], web_results: [] };
    const cites = citationsOf(mapSearchResult("t", structured));
    expect(cites).toHaveLength(1);
    expect(cites[0]?.url).toBe(CARD.webpage_url);
  });

  it("emits no citation when the card's only url is javascript:", () => {
    const structured = {
      ...SEARCH_STRUCTURED,
      cards: [
        {
          ...CARD,
          embed_url: "javascript:alert(1)",
          image_url: "javascript:alert(2)",
          webpage_url: "javascript:alert(3)",
        },
      ],
      web_results: [],
    };
    const items = mapSearchResult("plain text", structured);
    expect(citationsOf(items)).toHaveLength(0);
    expect(textOf(items).startsWith("plain text")).toBe(true);
  });

  it("drops a javascript: web result url without losing the valid ones", () => {
    const structured = {
      ...SEARCH_STRUCTURED,
      cards: [],
      web_results: [{ ...WEB, url: "javascript:alert(1)" }, SEARCH_STRUCTURED.web_results[1]!],
    };
    const cites = citationsOf(mapSearchResult("t", structured));
    expect(cites).toHaveLength(1);
    expect(cites[0]?.url).toBe(SEARCH_STRUCTURED.web_results[1]!.url);
  });

  it("salvages valid cards and web results when one web_results entry is malformed", () => {
    const structured = {
      ...SEARCH_STRUCTURED,
      web_results: [WEB, { snippet: "no url, no title" }],
    };
    const items = mapSearchResult(SEARCH_TEXT, structured);
    expect(citationsOf(items)).toHaveLength(2); // card + the one good web result
  });
});


describe("mapSearchResult — card series become SQL tables", () => {
  const tablesOf = (items: Item[]) =>
    items
      .filter((i) => i.text.includes('"sqlite_table"'))
      .map((i) => JSON.parse(i.text) as { name: string; rows: Record<string, unknown>[] });

  // Without this the model only sees the prose summary ("latest value was
  // $215.9B…") and would have to invent the series to chart it.
  it("ships the card's inline dataset as rows keyed by column name", () => {
    const tables = tablesOf(mapSearchResult(SEARCH_TEXT, SEARCH_STRUCTURED));
    expect(tables).toHaveLength(1);
    expect(tables[0]!.name).toMatch(/^tako_/);
    const dataset = SEARCH_STRUCTURED.cards[0]!.content!.dataset!;
    expect(tables[0]!.rows).toHaveLength(dataset.rows.length);
    const [firstTs, firstValue] = dataset.rows[0]! as [string, number];
    expect(tables[0]!.rows[0]).toEqual({
      Timestamp: firstTs,
      [dataset.columns[1]!.name]: firstValue,
    });
  });

  it("tells the model the rows are a recent slice and to chart from them", () => {
    const items = mapSearchResult(SEARCH_TEXT, SEARCH_STRUCTURED);
    const body = textOf(items);
    expect(body).toContain("loaded as SQL");
    expect(body).toContain("most recent rows");
    expect(body).toContain("create_artifact");
  });

  it("emits no table and no ack for a card carrying no dataset", () => {
    const structured = {
      ...SEARCH_STRUCTURED,
      cards: [{ ...CARD, content: null }],
    };
    const items = mapSearchResult(SEARCH_TEXT, structured);
    expect(tablesOf(items)).toHaveLength(0);
    expect(items[0]?.text).toBe(SEARCH_TEXT);
  });

  it("caps how many card series load, so a broad search cannot flood state", () => {
    const structured = {
      ...SEARCH_STRUCTURED,
      cards: Array.from({ length: 6 }, (_, i) => ({
        ...CARD,
        title: `Series ${i}`,
        webpage_url: `https://tako.com/card/series-${i}/`,
      })),
      web_results: [],
    };
    expect(tablesOf(mapSearchResult(SEARCH_TEXT, structured))).toHaveLength(3);
  });

  it("does not load the same table name twice", () => {
    const structured = {
      ...SEARCH_STRUCTURED,
      cards: [CARD, { ...CARD, card_id: "dupe" }],
      web_results: [],
    };
    expect(tablesOf(mapSearchResult(SEARCH_TEXT, structured))).toHaveLength(1);
  });

  it("caps rows even when a card over-delivers", () => {
    const dataset = SEARCH_STRUCTURED.cards[0]!.content!.dataset!;
    const structured = {
      ...SEARCH_STRUCTURED,
      cards: [
        {
          ...CARD,
          content: {
            dataset: {
              columns: dataset.columns,
              rows: Array.from({ length: 2100 }, () => dataset.rows[0]!),
            },
          },
        },
      ],
      web_results: [],
    };
    expect(tablesOf(mapSearchResult(SEARCH_TEXT, structured))[0]!.rows).toHaveLength(2000);
  });
});

describe("no artifact — Tako cards cannot be framed inline", () => {
  it("holds for mapSearchResult", () => {
    expectNoArtifact(mapSearchResult(SEARCH_TEXT, SEARCH_STRUCTURED));
  });

  it("holds for mapAnswerResult", () => {
    expectNoArtifact(mapAnswerResult(ANSWER_TEXT, ANSWER_STRUCTURED));
  });

  it("holds for mapContentsResult", () => {
    expectNoArtifact(mapContentsResult(CONTENTS_CARD_TEXT, CONTENTS_CARD_STRUCTURED, "tako_t"));
  });
});

describe("mapAnswerResult (real tako_answer response)", () => {
  it("the real answer text has no markdown links — citations must come from structuredContent", () => {
    // Regression guard for the bug these tests used to miss: the old mapper
    // scraped `[title](url)` out of the text, and upstream never emits that
    // form — it writes bare `URL: <url>` lines.
    expect(ANSWER_TEXT).not.toMatch(/\]\(https?:\/\//);
    expect(ANSWER_TEXT).toContain("URL: https://www.bea.gov/sites/default/files/2025-03/");
    const items = mapAnswerResult(ANSWER_TEXT, ANSWER_STRUCTURED);
    expect(citationsOf(items)).toHaveLength(6); // 3 cards + 3 web results
  });

  it("passes the answer text through first, then card citations, then web citations", () => {
    const items = mapAnswerResult(ANSWER_TEXT, ANSWER_STRUCTURED);
    expect(items[0]?.text).toBe(ANSWER_TEXT);
    const cites = citationsOf(items);
    expect(cites[0]).toEqual({
      type: "web",
      url: "https://tako.com/card/-Nrdha0K3vRVkPKxHvBj/",
      title: "United States GDP Growth Rate",
    });
    expect(cites[3]?.url).toBe("https://www.bea.gov/sites/default/files/2025-03/gdp4q24-3rd.pdf");
    expect(cites[3]?.title).toBe("4th Quarter and Year 2024");
  });

  it("dedupes and caps citations at 10", () => {
    const structured = {
      ...ANSWER_STRUCTURED,
      cards: [ANSWER_STRUCTURED.cards[0]!, ANSWER_STRUCTURED.cards[0]!],
      web_results: Array.from({ length: 14 }, (_, i) => ({
        ...ANSWER_STRUCTURED.web_results[0]!,
        url: `https://bea.gov/news/${i}`,
      })),
    };
    const cites = citationsOf(mapAnswerResult(ANSWER_TEXT, structured));
    expect(cites).toHaveLength(10);
    expect(cites.filter((c) => c.url.startsWith("https://tako.com/card/"))).toHaveLength(1);
  });

  it("returns just the text when structuredContent carries no cards or web results", () => {
    const items = mapAnswerResult("US real GDP grew 2.8% in 2024.", {
      answer: "US real GDP grew 2.8% in 2024.",
      request_id: "69f20461-613b-4299-9a7b-01e92d7a1bba",
      usage: null,
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe("US real GDP grew 2.8% in 2024.");
  });

  it("falls back to plain text on invalid structuredContent", () => {
    const items = mapAnswerResult(ANSWER_TEXT, { cards: "nope" });
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe(ANSWER_TEXT);
  });

  it("caps the text channel at 20000 chars", () => {
    const items = mapAnswerResult("z".repeat(25_000), ANSWER_STRUCTURED);
    expect(items[0]?.text.endsWith("\n[truncated]")).toBe(true);
    expect(items[0]?.text).toHaveLength(20_000 + "\n[truncated]".length);
  });
});

describe("mapContentsResult (batch results[] shape)", () => {
  it("reads rows from results[].records and acks the sql table", () => {
    const items = mapContentsResult(
      CONTENTS_CARD_TEXT,
      CONTENTS_CARD_STRUCTURED,
      "tako_nvda_revenue",
    );
    const table = tableOf(items);
    expect(table.name).toBe("tako_nvda_revenue");
    expect(table.rows).toHaveLength(3);
    expect(table.rows[2]).toEqual({
      Timestamp: "2026-01-25T00:00:00+00:00",
      "total_revenues - NVIDIA Corporation Total Revenues (Normalized)": 215938000000,
    });
    expect(items[1]?.text).toContain('SQL table "tako_nvda_revenue"');
    expect(items[1]?.text).toContain("Loaded 3 rows");
    expect(items[1]?.text).toContain("truncated from 22 total rows");
    expect(items[1]?.text).toContain("execute_sql");
  });

  it("skips a failed batch entry and uses a later entry that carries rows", () => {
    const items = mapContentsResult(CONTENTS_MIXED_TEXT, CONTENTS_MIXED_STRUCTURED, "tako_us_gdp");
    const table = tableOf(items);
    expect(table.name).toBe("tako_us_gdp");
    expect(table.rows).toHaveLength(2);
    expect(table.rows[1]).toEqual({
      Timestamp: "2024-10-01T00:00:00+00:00",
      real_gdp_percent_change: 1.9,
    });
    expect(items[1]?.text).not.toContain("truncated");
  });

  it("passes web page text through when the entry carries data but no records", () => {
    const items = mapContentsResult(CONTENTS_WEB_TEXT, CONTENTS_WEB_STRUCTURED, "unused");
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe(CONTENTS_WEB_TEXT);
  });

  it("passes the upstream text through when every batch entry failed", () => {
    const items = mapContentsResult(CONTENTS_MIXED_TEXT, CONTENTS_ALL_FAILED_STRUCTURED, "tako_x");
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe(CONTENTS_MIXED_TEXT);
  });

  it("caps rows at 2000 even when upstream over-delivers", () => {
    const items = mapContentsResult("rows", contentsStructuredWithRows(2500), "tako_big");
    expect(tableOf(items).rows).toHaveLength(2000);
    expect(items[1]?.text).toContain("Loaded 2000 rows");
  });

  it("passes text through on invalid structured", () => {
    const items = mapContentsResult("raw", 42, "unused");
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe("raw");
  });

  it("caps the passthrough text at 20000 chars", () => {
    const items = mapContentsResult("q".repeat(25_000), undefined, "unused");
    expect(items[0]?.text.endsWith("\n[truncated]")).toBe(true);
  });
});

describe("deriveTableName", () => {
  it("always returns a tako_-prefixed name", () => {
    const names = [
      deriveTableName("https://tako.com/card/nvda-revenue"),
      deriveTableName("https://tako.com/card/UB4jWl49yLz-o8VvKhEx/"),
      deriveTableName("https://x.com", "My Table! 2024"),
      deriveTableName("not a url"),
      deriveTableName("https://x.com", "!!!"),
    ];
    for (const n of names) expect(n.startsWith("tako_")).toBe(true);
  });

  it("derives from the url's last path segment", () => {
    expect(deriveTableName("https://tako.com/card/nvda-revenue")).toBe("tako_nvda_revenue");
    expect(deriveTableName("https://tako.com/card/UB4jWl49yLz-o8VvKhEx/")).toBe(
      "tako_ub4jwl49ylz_o8vvkhex",
    );
  });

  it("sanitizes an override into a sql-safe snake_case name", () => {
    expect(deriveTableName("https://x.com", "nvda_revenue")).toBe("tako_nvda_revenue");
    expect(deriveTableName("https://x.com", "My Table! 2024")).toBe("tako_my_table_2024");
  });

  it("never doubles the prefix when the override already carries it", () => {
    expect(deriveTableName("https://x.com", "tako_nvda_revenue")).toBe("tako_nvda_revenue");
    expect(deriveTableName("https://tako.com/card/tako_us_gdp")).toBe("tako_us_gdp");
  });

  it("makes a digit-leading override sql-safe via the prefix", () => {
    expect(deriveTableName("https://x.com", "2024 revenue")).toBe("tako_2024_revenue");
  });

  it("falls back to tako_data on unparseable input", () => {
    expect(deriveTableName("not a url")).toBe("tako_data");
    expect(deriveTableName("https://x.com", "!!!")).toBe("tako_data");
    expect(deriveTableName("https://tako.com/")).toBe("tako_data");
  });

  it("bounds the derived slug length", () => {
    expect(deriveTableName("https://x.com", "a".repeat(200))).toBe(`tako_${"a".repeat(40)}`);
  });
});
