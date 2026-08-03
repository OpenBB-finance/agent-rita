import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { upstream } from "./upstream-mock";
import { SEARCH_TEXT, SEARCH_STRUCTURED } from "./fixtures";

const { resetTakoClientForTests } = await import(
  "../../../../../../mcp-server/src/tools/backend/tako/client"
);
const { takoSearchHandler } = await import(
  "../../../../../../mcp-server/src/tools/backend/tako/search"
);

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

function realSearchResponse(): void {
  upstream.response = {
    content: [{ type: "text", text: SEARCH_TEXT }],
    structuredContent: SEARCH_STRUCTURED,
    isError: false,
  };
}

describe("takoSearchHandler", () => {
  it("forwards query + sources upstream and maps the real response", async () => {
    realSearchResponse();
    const res = await takoSearchHandler({ query: "nvidia revenue", sources: ["data"] });
    expect(upstream.calls).toEqual([
      { name: "tako_search", args: { query: "nvidia revenue", sources: ["data"] } },
    ]);
    expect(res.content.filter((i) => i.text.includes('"citation"'))).toHaveLength(3);
    expect(res.content.some((i) => i.text.includes("## Tako Data (1 card)"))).toBe(true);
  });

  it("omits sources upstream when not supplied", async () => {
    await takoSearchHandler({ query: "us gdp" });
    expect(upstream.calls[0]?.args).toEqual({ query: "us gdp" });
  });

  it("returns upstream error text with the free-tier hint on isError", async () => {
    upstream.response = {
      content: [{ type: "text", text: "Rate limit exceeded" }],
      structuredContent: undefined,
      isError: true,
    };
    const res = await takoSearchHandler({ query: "x" });
    expect(res.content).toHaveLength(1);
    expect(res.content[0]?.text).toContain("Rate limit exceeded");
    expect(res.content[0]?.text).toContain("TAKO_API_TOKEN");
  });

  it("substitutes fallback text when an isError result carries no detail", async () => {
    upstream.response = { content: [], structuredContent: undefined, isError: true };
    const res = await takoSearchHandler({ query: "x" });
    expect(res.content).toHaveLength(1);
    expect(res.content[0]?.text).toContain("Tako returned an error with no detail.");
  });

  it("surfaces a persistent transport error as a text item, never a crash", async () => {
    upstream.errors.push(new Error("connect ECONNREFUSED"), new Error("connect ECONNREFUSED"));
    const res = await takoSearchHandler({ query: "x" });
    expect(res.content).toHaveLength(1);
    expect(res.content[0]?.text).toContain("Tako search failed");
    expect(res.content[0]?.text).toContain("ECONNREFUSED");
  });

  it("lets a timeout reach the handler's catch without a second upstream call", async () => {
    upstream.errors.push(new Error("MCP error -32001: Request timed out"));
    const res = await takoSearchHandler({ query: "x" });
    expect(upstream.calls).toHaveLength(1);
    expect(res.content[0]?.text).toContain("Tako search failed");
    expect(res.content[0]?.text).toContain("timed out");
  });
});
