import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { upstream } from "./upstream-mock";
import { ANSWER_TEXT, ANSWER_STRUCTURED } from "./fixtures";

const { resetTakoClientForTests } = await import(
  "../../../../../../mcp-server/src/tools/backend/tako/client"
);
const { takoAnswerHandler } = await import(
  "../../../../../../mcp-server/src/tools/backend/tako/answer"
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

function realAnswerResponse(): void {
  upstream.response = {
    content: [{ type: "text", text: ANSWER_TEXT }],
    structuredContent: ANSWER_STRUCTURED,
    isError: false,
  };
}

describe("takoAnswerHandler", () => {
  it("forwards the query and cites the cards + web results from structuredContent", async () => {
    realAnswerResponse();
    const res = await takoAnswerHandler({ query: "What was US GDP growth in 2024?" });
    expect(upstream.calls).toEqual([
      { name: "tako_answer", args: { query: "What was US GDP growth in 2024?" } },
    ]);
    expect(res.content[0]?.text).toContain("US real GDP grew 2.8% in 2024.");
    const citations = res.content.filter((i) => i.text.includes('"citation"'));
    expect(citations).toHaveLength(6); // 3 cards + 3 web results
    expect(citations.some((c) => c.text.includes("https://tako.com/card/-Nrdha0K3vRVkPKxHvBj/"))).toBe(
      true,
    );
    expect(
      citations.some((c) =>
        c.text.includes("https://www.bea.gov/sites/default/files/2025-03/gdp4q24-3rd.pdf"),
      ),
    ).toBe(true);
  });

  it("still cites when the answer text carries only bare URL: lines (no markdown links)", async () => {
    realAnswerResponse();
    const res = await takoAnswerHandler({ query: "q" });
    expect(res.content[0]?.text).not.toMatch(/\]\(https?:\/\//);
    expect(res.content[0]?.text).toContain("URL: https://bea.gov/news/2025/");
    expect(res.content.some((i) => i.text.includes('"citation"'))).toBe(true);
  });

  it("returns only text when the response has no cards or web results", async () => {
    upstream.response = {
      content: [{ type: "text", text: "US real GDP grew 2.8% in 2024." }],
      structuredContent: { answer: "US real GDP grew 2.8% in 2024.", request_id: "r1" },
      isError: false,
    };
    const res = await takoAnswerHandler({ query: "q" });
    expect(res.content).toHaveLength(1);
  });

  it("returns hinted error text on isError", async () => {
    upstream.response = {
      content: [{ type: "text", text: "Rate limited" }],
      structuredContent: undefined,
      isError: true,
    };
    const res = await takoAnswerHandler({ query: "x" });
    expect(res.content).toHaveLength(1);
    expect(res.content[0]?.text).toContain("Rate limited");
    expect(res.content[0]?.text).toContain("TAKO_API_TOKEN");
  });

  it("substitutes fallback text when an isError result carries no detail", async () => {
    upstream.response = {
      content: [{ type: "text", text: "   " }],
      structuredContent: undefined,
      isError: true,
    };
    const res = await takoAnswerHandler({ query: "x" });
    expect(res.content[0]?.text).toContain("Tako returned an error with no detail.");
  });

  it("surfaces persistent errors as text", async () => {
    upstream.errors.push(new Error("fetch failed"), new Error("fetch failed"));
    const res = await takoAnswerHandler({ query: "x" });
    expect(res.content[0]?.text).toContain("Tako answer failed");
  });

  it("lets a timeout reach the handler's catch without a second upstream call", async () => {
    upstream.errors.push(new Error("MCP error -32001: Request timed out"));
    const res = await takoAnswerHandler({ query: "x" });
    expect(upstream.calls).toHaveLength(1);
    expect(res.content[0]?.text).toContain("Tako answer failed");
  });
});
