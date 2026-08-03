import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { upstream } from "./upstream-mock";
import {
  CONTENTS_CARD_STRUCTURED,
  CONTENTS_CARD_TEXT,
  CONTENTS_MIXED_STRUCTURED,
  CONTENTS_MIXED_TEXT,
  CONTENTS_WEB_STRUCTURED,
  CONTENTS_WEB_TEXT,
} from "./fixtures";

const { resetTakoClientForTests } = await import(
  "../../../../../../mcp-server/src/tools/backend/tako/client"
);
const { takoContentsHandler, takoContentsSchema } = await import(
  "../../../../../../mcp-server/src/tools/backend/tako/contents"
);

const CARD_URL = "https://tako.com/card/UB4jWl49yLz-o8VvKhEx/";
const savedToken = process.env.TAKO_API_TOKEN;

beforeEach(() => {
  delete process.env.TAKO_API_TOKEN;
  resetTakoClientForTests();
  upstream.reset();
});

afterEach(() => {
  if (savedToken === undefined) delete process.env.TAKO_API_TOKEN;
  else process.env.TAKO_API_TOKEN = savedToken;
});

const tableOf = (content: { text: string }[]): { name: string; rows: unknown[] } => {
  const entry = content.find((i) => i.text.includes('"sqlite_table"'));
  expect(entry).toBeDefined();
  return JSON.parse(entry!.text) as { name: string; rows: unknown[] };
};

describe("takoContentsSchema", () => {
  it("rejects an empty table_name rather than deriving a bare tako_ table", () => {
    expect(takoContentsSchema.table_name.parse("nvda_revenue")).toBe("nvda_revenue");
    expect(() => takoContentsSchema.table_name.parse("")).toThrow();
  });

  it("bounds max_rows to the upstream export ceiling", () => {
    expect(takoContentsSchema.max_rows.parse(2000)).toBe(2000);
    expect(() => takoContentsSchema.max_rows.parse(2001)).toThrow();
    expect(() => takoContentsSchema.max_rows.parse(0)).toThrow();
  });
});

describe("takoContentsHandler", () => {
  it("sends the batch urls[] form with json_records and emits a sqlite_table", async () => {
    upstream.response = {
      content: [{ type: "text", text: CONTENTS_CARD_TEXT }],
      structuredContent: CONTENTS_CARD_STRUCTURED,
      isError: false,
    };
    const res = await takoContentsHandler({
      url: CARD_URL,
      max_rows: 100,
      table_name: "nvda_revenue",
    });
    expect(upstream.calls).toEqual([
      {
        name: "tako_contents",
        args: {
          urls: [CARD_URL],
          content_format: "json_records",
          max_rows: 100,
        },
      },
    ]);
    const table = tableOf(res.content);
    expect(table.name).toBe("tako_nvda_revenue");
    expect(table.rows).toHaveLength(3);
  });

  it("omits max_rows when not supplied", async () => {
    await takoContentsHandler({ url: CARD_URL });
    expect(upstream.calls[0]?.args).toEqual({
      urls: [CARD_URL],
      content_format: "json_records",
    });
  });

  it("derives a tako_-prefixed table name from the url when table_name is absent", async () => {
    upstream.response = {
      content: [{ type: "text", text: CONTENTS_CARD_TEXT }],
      structuredContent: CONTENTS_CARD_STRUCTURED,
      isError: false,
    };
    const res = await takoContentsHandler({ url: "https://tako.com/card/nvda-revenue" });
    expect(tableOf(res.content).name).toBe("tako_nvda_revenue");
  });

  it("finds rows in a batch where an earlier entry failed", async () => {
    upstream.response = {
      content: [{ type: "text", text: CONTENTS_MIXED_TEXT }],
      structuredContent: CONTENTS_MIXED_STRUCTURED,
      isError: false,
    };
    const res = await takoContentsHandler({
      url: "https://tako.com/card/TZrt15wwcTTet7S6B_6x/",
      table_name: "us_gdp",
    });
    const table = tableOf(res.content);
    expect(table.name).toBe("tako_us_gdp");
    expect(table.rows).toHaveLength(2);
  });

  it("passes web page text through when the batch entry carries no records", async () => {
    upstream.response = {
      content: [{ type: "text", text: CONTENTS_WEB_TEXT }],
      structuredContent: CONTENTS_WEB_STRUCTURED,
      isError: false,
    };
    const res = await takoContentsHandler({
      url: "https://investor.nvidia.com/news/press-release-details/2026/NVIDIA-Announces-Financial-Results-for-First-Quarter-Fiscal-2027/default.aspx",
    });
    expect(res.content).toHaveLength(1);
    expect(res.content[0]?.text).toBe(CONTENTS_WEB_TEXT);
  });

  it("returns hinted error text on isError (e.g. non-exportable card)", async () => {
    upstream.response = {
      content: [{ type: "text", text: "Card is not exportable" }],
      structuredContent: undefined,
      isError: true,
    };
    const res = await takoContentsHandler({ url: CARD_URL });
    expect(res.content).toHaveLength(1);
    expect(res.content[0]?.text).toContain("not exportable");
    expect(res.content[0]?.text).toContain("TAKO_API_TOKEN");
  });

  it("substitutes fallback text when an isError result carries no detail", async () => {
    upstream.response = { content: [], structuredContent: undefined, isError: true };
    const res = await takoContentsHandler({ url: CARD_URL });
    expect(res.content[0]?.text).toContain("Tako returned an error with no detail.");
  });

  it("surfaces persistent errors as text", async () => {
    upstream.errors.push(new Error("fetch failed"), new Error("fetch failed"));
    const res = await takoContentsHandler({ url: CARD_URL });
    expect(res.content[0]?.text).toContain("Tako contents fetch failed");
  });

  it("lets a timeout reach the handler's catch without a second upstream call", async () => {
    upstream.errors.push(new Error("MCP error -32001: Request timed out"));
    const res = await takoContentsHandler({ url: CARD_URL });
    expect(upstream.calls).toHaveLength(1);
    expect(res.content[0]?.text).toContain("Tako contents fetch failed");
  });
});
