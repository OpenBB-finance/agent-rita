import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { upstream } from "./upstream-mock";
import { SEARCH_STRUCTURED } from "./fixtures";

const {
  isTakoEnabled,
  isTakoAuthed,
  withFreeTierHint,
  errorText,
  callTakoTool,
  resetTakoClientForTests,
} = await import("../../../../../../mcp-server/src/tools/backend/tako/client");

const savedEnv = {
  TAKO_ENABLED: process.env.TAKO_ENABLED,
  TAKO_API_TOKEN: process.env.TAKO_API_TOKEN,
  TAKO_MCP_URL: process.env.TAKO_MCP_URL,
};

beforeEach(() => {
  delete process.env.TAKO_ENABLED;
  delete process.env.TAKO_API_TOKEN;
  delete process.env.TAKO_MCP_URL;
  resetTakoClientForTests();
  upstream.reset();
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("gating helpers", () => {
  it("isTakoEnabled defaults true, false only on the literal string 'false'", () => {
    expect(isTakoEnabled()).toBe(true);
    process.env.TAKO_ENABLED = "false";
    expect(isTakoEnabled()).toBe(false);
    process.env.TAKO_ENABLED = "true";
    expect(isTakoEnabled()).toBe(true);
  });

  it("isTakoAuthed reflects TAKO_API_TOKEN presence", () => {
    expect(isTakoAuthed()).toBe(false);
    process.env.TAKO_API_TOKEN = "tk-123";
    expect(isTakoAuthed()).toBe(true);
  });

  it("withFreeTierHint appends the hint only when unauthed", () => {
    expect(withFreeTierHint("msg")).toContain("TAKO_API_TOKEN");
    process.env.TAKO_API_TOKEN = "tk-123";
    expect(withFreeTierHint("msg")).toBe("msg");
  });

  it("the free-tier hint promises no specific rate number", () => {
    // The anonymous limit is enforced per edge location, so any figure the
    // server stated would be a guess the model repeats to the user.
    const hint = withFreeTierHint("msg");
    expect(hint).not.toMatch(/\d+\s*(req|request|rpm|per minute)/i);
    expect(hint).not.toContain("10 req/min");
  });
});

describe("errorText", () => {
  it("passes real upstream error text through unchanged", () => {
    expect(errorText("Card is not exportable")).toBe("Card is not exportable");
  });

  it("substitutes a fallback when upstream sends no detail", () => {
    // The agent drops empty content items; without this the model sees a tool
    // call that returned nothing at all and invents a result.
    expect(errorText("")).toBe("Tako returned an error with no detail.");
    expect(errorText("   \n  ")).toBe("Tako returned an error with no detail.");
  });
});

describe("callTakoTool", () => {
  it("connects lazily, joins text items, passes structured + isError through", async () => {
    upstream.response = {
      content: [
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
      ],
      structuredContent: SEARCH_STRUCTURED,
      isError: false,
    };
    const res = await callTakoTool("tako_search", { query: "nvidia revenue" });
    expect(upstream.connects).toBe(1);
    expect(upstream.calls).toEqual([{ name: "tako_search", args: { query: "nvidia revenue" } }]);
    expect(res.text).toBe("line one\nline two");
    expect(res.structured).toEqual(SEARCH_STRUCTURED);
    expect(res.isError).toBe(false);
  });

  it("sends the 150s per-call deadline that upstream's own budget needs", async () => {
    await callTakoTool("tako_search", { query: "x" });
    expect(upstream.callOptions[0]?.timeout).toBe(150_000);
  });

  it("reuses the client across calls (singleton)", async () => {
    await callTakoTool("tako_search", { query: "a" });
    await callTakoTool("tako_answer", { query: "b" });
    expect(upstream.connects).toBe(1);
  });

  it("uses the default endpoint and honors TAKO_MCP_URL override", async () => {
    await callTakoTool("tako_search", { query: "x" });
    expect(upstream.transportUrls[0]).toBe("https://mcp.tako.com/mcp");
    resetTakoClientForTests();
    process.env.TAKO_MCP_URL = "http://localhost:9999/mcp";
    await callTakoTool("tako_search", { query: "x" });
    expect(upstream.transportUrls[1]).toBe("http://localhost:9999/mcp");
  });

  it("reconnects once on a connection-level failure, then succeeds", async () => {
    upstream.errors.push(new Error("session expired"));
    const res = await callTakoTool("tako_search", { query: "x" });
    expect(res.text).toBe("upstream text");
    expect(upstream.calls).toHaveLength(2);
    expect(upstream.connects).toBe(2);
  });

  it("closes the dead client before reconnecting, instead of leaking the transport", async () => {
    await callTakoTool("tako_search", { query: "warm the singleton" });
    expect(upstream.closes).toBe(0);
    upstream.errors.push(new Error("fetch failed"));
    await callTakoTool("tako_search", { query: "x" });
    expect(upstream.closes).toBe(1);
    expect(upstream.connects).toBe(2);
  });

  it("retries every connection-level failure mode", async () => {
    for (const msg of [
      "SSE session closed",
      "connection reset by peer",
      "socket hang up",
      "read ECONNRESET",
      "connect ECONNREFUSED 127.0.0.1:443",
      "network error",
      "fetch failed",
    ]) {
      resetTakoClientForTests();
      upstream.reset();
      upstream.errors.push(new Error(msg));
      await callTakoTool("tako_search", { query: "x" });
      expect(upstream.calls).toHaveLength(2);
    }
  });

  it("does NOT retry a timeout — the call may already be running and billed", async () => {
    upstream.errors.push(new Error("MCP error -32001: Request timed out"));
    await expect(callTakoTool("tako_search", { query: "x" })).rejects.toThrow("timed out");
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.connects).toBe(1);
    expect(upstream.closes).toBe(0);
  });

  it("does NOT retry a plain 'timeout' message either", async () => {
    upstream.errors.push(new Error("Request timeout after 150000ms"));
    await expect(callTakoTool("tako_answer", { query: "x" })).rejects.toThrow("timeout");
    expect(upstream.calls).toHaveLength(1);
  });

  it("does NOT retry an application-level rejection", async () => {
    upstream.errors.push(new Error("MCP error -32602: Invalid params"));
    await expect(callTakoTool("tako_contents", { urls: ["x"] })).rejects.toThrow("Invalid params");
    expect(upstream.calls).toHaveLength(1);
  });

  it("throws when both connection attempts fail", async () => {
    upstream.errors.push(new Error("fetch failed"), new Error("fetch failed"));
    await expect(callTakoTool("tako_search", { query: "x" })).rejects.toThrow("fetch failed");
    expect(upstream.calls).toHaveLength(2);
  });

  // An endpoint that accepts the socket but never answers `initialize` would
  // otherwise leave the tool waiting forever and the chat looking frozen.
  it("bounds the handshake with its own, tighter deadline", async () => {
    await callTakoTool("tako_search", { query: "x" });
    expect(upstream.connectOptions[0]?.timeout).toBe(15_000);
    expect(upstream.connectOptions[0]!.timeout!).toBeLessThan(
      upstream.callOptions[0]!.timeout!,
    );
  });

  it("keeps the token on the transport and out of everything else", async () => {
    process.env.TAKO_API_TOKEN = "tk-secret-value";
    resetTakoClientForTests();
    upstream.reset();
    upstream.errors.push(new Error("fetch failed"), new Error("fetch failed"));
    let thrown = "";
    try {
      await callTakoTool("tako_search", { query: "x" });
    } catch (e) {
      thrown = e instanceof Error ? e.message : String(e);
    }
    // The header is the ONLY place the value may appear.
    expect(upstream.transportHeaders[0]?.Authorization).toBe("Bearer tk-secret-value");
    expect(thrown).not.toContain("tk-secret-value");
    expect(JSON.stringify(upstream.calls)).not.toContain("tk-secret-value");
    expect(JSON.stringify(upstream.transportUrls)).not.toContain("tk-secret-value");
    delete process.env.TAKO_API_TOKEN;
  });

  // The first call of the process opens its client *inside* the attempt, so a
  // handle captured before the attempt would be null and the broken transport
  // would leak instead of being closed.
  it("closes the dead client even when the failure is on the very first call", async () => {
    resetTakoClientForTests();
    upstream.reset();
    upstream.errors.push(new Error("session expired"));
    await callTakoTool("tako_search", { query: "x" });
    expect(upstream.closes).toBe(1);
    expect(upstream.connects).toBe(2);
  });
});
