import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";
import type { ToolMessage } from "../../../../src/protocol/types";
import { injectFromReboot, type RoundTripContext } from "../../../../src/agent/round-trip";
import {
  makePrepareClientSqlTool,
  PREPARE_CLIENT_SQL_TOOL_NAME,
  prepareClientSqlSchema,
} from "../../../../src/agent/tools/client-sql";

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

async function collect(gen: AsyncGenerator<unknown, unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return events;
}

function lastMessageText(ctx: RoundTripContext): string {
  const message = ctx.messages.at(-1) as { content: Array<{ text?: string }> | string };
  return Array.isArray(message.content)
    ? message.content.map((p) => p.text ?? "").join("\n")
    : String(message.content);
}

function toolMessage(data: unknown[]): ToolMessage {
  return {
    role: "tool",
    function: PREPARE_CLIENT_SQL_TOOL_NAME,
    input_arguments: { widgets: [{ widget_id: "holdings", origin: "My Backend" }] },
    data,
  } as ToolMessage;
}

function schemaItem(payload: Record<string, unknown>) {
  return {
    items: [
      {
        content: JSON.stringify(payload),
        data_format: { data_type: "object", parse_as: "text" },
      },
    ],
  };
}

describe("prepareClientSqlSchema", () => {
  it("accepts an instance uuid", () => {
    const parsed = prepareClientSqlSchema.parse({
      display_summary: "Loading holdings",
      widgets: [{ widget_uuid: "u-1" }],
    });
    expect(parsed.widgets[0].widget_uuid).toBe("u-1");
  });

  it("accepts origin + widget_id with input_args", () => {
    const parsed = prepareClientSqlSchema.parse({
      display_summary: "Loading holdings",
      widgets: [
        { widget_id: "holdings", origin: "My Backend", input_args: { ticker: "NVDA" } },
      ],
    });
    expect(parsed.widgets[0].input_args).toEqual({ ticker: "NVDA" });
  });

  it("rejects an entry with neither uuid nor widget_id", () => {
    expect(() =>
      prepareClientSqlSchema.parse({
        display_summary: "Loading",
        widgets: [{ input_args: { ticker: "NVDA" } }],
      }),
    ).toThrow();
  });
});

describe("makePrepareClientSqlTool", () => {
  it("has no execute (round-trip tool — loop owns dispatch)", () => {
    expect(
      (makePrepareClientSqlTool() as { execute?: unknown }).execute,
    ).toBeUndefined();
  });
});

describe("injectFromReboot — prepare_client_sql_tables", () => {
  it("surfaces the table schema, ref and params the rows were fetched with", async () => {
    const ctx = makeCtx();
    await collect(
      injectFromReboot(
        toolMessage([
          schemaItem({
            widget_uuid: "global::My Backend::holdings::1a2b3c",
            table_name: "holdings_1a2b3c",
            row_count: 42,
            params_used: { ticker: "NVDA" },
            columns: [
              { name: "ticker", type: "VARCHAR" },
              { name: "weight", type: "DOUBLE" },
            ],
          }),
        ]),
        ctx,
      ) as AsyncGenerator<unknown, unknown>,
    );

    const text = lastMessageText(ctx);
    expect(text).toContain("holdings_1a2b3c");
    expect(text).toContain("global::My Backend::holdings::1a2b3c");
    expect(text).toContain("ticker (VARCHAR)");
    expect(text).toContain("weight (DOUBLE)");
    expect(text).toContain('{"ticker":"NVDA"}');
    expect(text).toContain("execute_client_sql");
  });

  it("reports failures so the model can supply params or fall back", async () => {
    const ctx = makeCtx();
    await collect(
      injectFromReboot(
        toolMessage([
          { error_type: "unexpected", content: "Widget holdings requires ticker" },
        ]),
        ctx,
      ) as AsyncGenerator<unknown, unknown>,
    );

    const text = lastMessageText(ctx);
    expect(text).toContain("Failed to load 1 widget");
    expect(text).toContain("requires ticker");
    expect(text).toContain("get_widget_data");
  });
});
