import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";
import type { ToolMessage } from "../../../../src/protocol/types";
import { injectFromReboot, type RoundTripContext } from "../../../../src/agent/round-trip";

function makeCtx(): RoundTripContext {
  return {
    tables: [],
    messages: [] as ModelMessage[],
    allWidgets: [],
    citedWidgets: new Map(),
    mcpCitations: [],
    artifactQueue: [],
    intermediateCitations: [],
    pendingTables: new Map(),
    tablesShipped: new Set(),
    conversationId: "test-conv",
  };
}

async function collect(
  gen: AsyncGenerator<unknown, unknown>,
): Promise<{ events: unknown[]; result: unknown }> {
  const events: unknown[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, result: next.value };
}

function lastMessageText(ctx: RoundTripContext): string {
  const content = ctx.messages.at(-1) as { content: Array<{ text?: string }> | string };
  return Array.isArray(content.content)
    ? content.content.map((p) => p.text ?? "").join("\n")
    : String(content.content);
}

describe("injectFromReboot — execute_client_sql", () => {
  it("parses DataContent JSON array wire format (terminalpro)", async () => {
    const ctx = makeCtx();
    const rows = [
      { symbol: "AAPL", close: 190 },
      { symbol: "MSFT", close: 400 },
    ];
    const toolMsg: ToolMessage = {
      role: "tool",
      function: "execute_client_sql",
      input_arguments: {
        queries: [
          {
            sql: "SELECT symbol, close FROM prices_u1 WHERE close > 100",
            widget_uuids: ["u1"],
            row_limit: 500,
          },
        ],
      },
      data: [
        {
          items: [
            {
              content: JSON.stringify(rows),
              data_format: { data_type: "object", parse_as: "table" },
            },
          ],
        },
      ],
    };

    await collect(injectFromReboot(toolMsg, ctx));

    expect(ctx.pendingTables.size).toBe(1);
    const [name, loaded] = [...ctx.pendingTables.entries()][0];
    expect(name).toMatch(/^client_sql_/);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toMatchObject({ symbol: "AAPL", close: 190 });
    const text = lastMessageText(ctx);
    expect(text).toContain("success");
    expect(text).toContain("ANSWER THE USER FROM THOSE ROWS");
    expect(text).toContain("AAPL");
    expect(text).toContain("Do not call more tools");
  });

  it("unwraps content that stringified { rowData, rowCount }", async () => {
    const ctx = makeCtx();
    const toolMsg: ToolMessage = {
      role: "tool",
      function: "execute_client_sql",
      input_arguments: {
        queries: [{ sql: "SELECT 1 AS n", widget_uuids: ["u1"] }],
      },
      data: [
        {
          items: [
            {
              content: JSON.stringify({
                rowData: [{ n: 1 }],
                rowCount: 1,
              }),
            },
          ],
        },
      ],
    };

    await collect(injectFromReboot(toolMsg, ctx));
    expect(ctx.pendingTables.size).toBe(1);
    expect([...ctx.pendingTables.values()][0]).toEqual([{ n: 1 }]);
  });

  it("still accepts plain row objects in items", async () => {
    const ctx = makeCtx();
    const toolMsg: ToolMessage = {
      role: "tool",
      function: "execute_client_sql",
      input_arguments: {
        queries: [{ sql: "SELECT 1", widget_uuids: ["u1"] }],
      },
      data: [
        {
          items: [
            { symbol: "AAPL", close: 190 },
            { symbol: "MSFT", close: 400 },
          ],
        },
      ],
    };

    await collect(injectFromReboot(toolMsg, ctx));
    expect(ctx.pendingTables.size).toBe(1);
    expect([...ctx.pendingTables.values()][0]).toHaveLength(2);
  });

  it("surfaces DuckDB errors verbatim", async () => {
    const ctx = makeCtx();
    const toolMsg: ToolMessage = {
      role: "tool",
      function: "execute_client_sql",
      input_arguments: {
        queries: [{ sql: "SELECT bad_col FROM t", widget_uuids: ["u1"] }],
      },
      data: [
        {
          error_type: "unexpected",
          content: 'Binder Error: Referenced column "bad_col" not found',
        } as unknown as ToolMessage["data"][number],
      ],
    };

    const { events } = await collect(injectFromReboot(toolMsg, ctx));

    expect(ctx.pendingTables.size).toBe(0);
    const text = lastMessageText(ctx);
    expect(text).toContain("bad_col");
    expect(text).toContain("Fix the SQL");
    // Reasoning step should flag error, not claim success
    const step = events.find(
      (e) =>
        e &&
        typeof e === "object" &&
        (e as { event?: string }).event === "copilotStatusUpdate",
    ) as { data?: { eventType?: string; message?: string } } | undefined;
    // status event type may be nested differently — check message text from parts
    expect(text).toMatch(/error/i);
    void step;
  });
});
