import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { upstream } from "./upstream-mock";
import { AVAILABLE_DATA_TEXT, AVAILABLE_DATA_STRUCTURED } from "./fixtures";

const { resetTakoClientForTests } = await import(
  "../../../../../../mcp-server/src/tools/backend/tako/client"
);
const { takoAvailableDataHandler, takoAvailableDataSchema } = await import(
  "../../../../../../mcp-server/src/tools/backend/tako/available-data"
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

describe("takoAvailableDataSchema", () => {
  it("exposes only the params upstream actually accepts (q, types)", () => {
    // `coverage_filter` was invented by the wrapper and silently ignored
    // upstream — the model would narrow a lookup that never narrowed.
    expect(Object.keys(takoAvailableDataSchema).sort()).toEqual(["q", "types"]);
  });

  it("types is an entity|metric enum", () => {
    expect(takoAvailableDataSchema.types.parse("entity")).toBe("entity");
    expect(takoAvailableDataSchema.types.parse("metric")).toBe("metric");
    expect(takoAvailableDataSchema.types.parse(undefined)).toBeUndefined();
    expect(() => takoAvailableDataSchema.types.parse("cruise days")).toThrow();
  });

  it("q requires at least 2 characters", () => {
    expect(takoAvailableDataSchema.q.parse("Nvidia")).toBe("Nvidia");
    expect(() => takoAvailableDataSchema.q.parse("N")).toThrow();
  });
});

describe("takoAvailableDataHandler", () => {
  it("forwards q + types and passes the coverage text through verbatim", async () => {
    upstream.response = {
      content: [{ type: "text", text: AVAILABLE_DATA_TEXT }],
      structuredContent: AVAILABLE_DATA_STRUCTURED,
      isError: false,
    };
    const res = await takoAvailableDataHandler({ q: "Nvidia", types: "entity" });
    expect(upstream.calls).toEqual([
      { name: "tako_available_data", args: { q: "Nvidia", types: "entity" } },
    ]);
    expect(res.content).toHaveLength(1);
    expect(res.content[0]?.text).toBe(AVAILABLE_DATA_TEXT);
    expect(res.content[0]?.text).toContain("NVIDIA Corporation (ORG)");
  });

  it("omits types when absent", async () => {
    await takoAvailableDataHandler({ q: "Nvidia" });
    expect(upstream.calls[0]?.args).toEqual({ q: "Nvidia" });
  });

  it("returns hinted error text on isError", async () => {
    upstream.response = {
      content: [{ type: "text", text: "Rate limited" }],
      structuredContent: undefined,
      isError: true,
    };
    const res = await takoAvailableDataHandler({ q: "Nvidia" });
    expect(res.content[0]?.text).toContain("Rate limited");
    expect(res.content[0]?.text).toContain("TAKO_API_TOKEN");
  });

  it("substitutes fallback text when an isError result carries no detail", async () => {
    upstream.response = { content: [], structuredContent: undefined, isError: true };
    const res = await takoAvailableDataHandler({ q: "Nvidia" });
    expect(res.content[0]?.text).toContain("Tako returned an error with no detail.");
  });

  it("surfaces persistent errors as text", async () => {
    upstream.errors.push(new Error("fetch failed"), new Error("fetch failed"));
    const res = await takoAvailableDataHandler({ q: "x" });
    expect(res.content[0]?.text).toContain("Tako coverage lookup failed");
  });

  it("lets a timeout reach the handler's catch without a second upstream call", async () => {
    upstream.errors.push(new Error("MCP error -32001: Request timed out"));
    const res = await takoAvailableDataHandler({ q: "Nvidia" });
    expect(upstream.calls).toHaveLength(1);
    expect(res.content[0]?.text).toContain("Tako coverage lookup failed");
  });
});
