import { describe, it, expect } from "bun:test";
import { z } from "zod";
import {
  sanitizeMcpToolName,
  buildToolInputSchema,
} from "../../../../src/mcp/schema";

describe("sanitizeMcpToolName", () => {
  it("passes through valid identifier characters", () => {
    expect(sanitizeMcpToolName("execute_sql")).toBe("execute_sql");
    expect(sanitizeMcpToolName("search123")).toBe("search123");
  });

  it("replaces special characters with underscores", () => {
    expect(sanitizeMcpToolName("foo-bar")).toBe("foo_bar");
    expect(sanitizeMcpToolName("foo.bar.baz")).toBe("foo_bar_baz");
    expect(sanitizeMcpToolName("foo:bar")).toBe("foo_bar");
  });

  it("collapses runs of underscores", () => {
    expect(sanitizeMcpToolName("foo--bar")).toBe("foo_bar");
    expect(sanitizeMcpToolName("foo___bar")).toBe("foo_bar");
  });

  it("strips leading and trailing underscores", () => {
    expect(sanitizeMcpToolName("_foo_")).toBe("foo");
    expect(sanitizeMcpToolName("__foo__")).toBe("foo");
    expect(sanitizeMcpToolName("---foo---")).toBe("foo");
  });
});

describe("buildToolInputSchema", () => {
  it("returns z.object with display_summary when input_schema is missing", () => {
    const schema = buildToolInputSchema(undefined);
    expect(schema).toBeInstanceOf(z.ZodObject);
    expect(schema.parse({})).toEqual({});
    expect(schema.parse({ display_summary: "Checking data" })).toEqual({
      display_summary: "Checking data",
    });
  });

  it("returns z.object with display_summary when properties is missing", () => {
    const schema = buildToolInputSchema({ required: ["x"] });
    expect(schema.parse({})).toEqual({});
    expect(Object.keys(schema.shape)).toEqual(["display_summary"]);
  });

  it("strips x-agentrita-* keys from model-facing schema", () => {
    const schema = buildToolInputSchema({
      properties: {
        sql: { type: "string" },
        "x-agentrita-conversation-id": { type: "string" },
        "x-agentrita-tables": { type: "object" },
      },
      required: ["sql"],
    });
    const shape = schema.shape;
    expect(Object.keys(shape).sort()).toEqual(["display_summary", "sql"]);
    expect("x-agentrita-conversation-id" in shape).toBe(false);
    expect("x-agentrita-tables" in shape).toBe(false);
  });

  it("marks non-required props as optional", () => {
    const schema = buildToolInputSchema({
      properties: {
        a: { type: "string" },
        b: { type: "string" },
      },
      required: ["a"],
    });
    expect(schema.parse({ a: "x" })).toEqual({ a: "x" });
    expect(() => schema.parse({})).toThrow();
  });

  it("treats no `required` as all-optional", () => {
    const schema = buildToolInputSchema({
      properties: { a: { type: "string" } },
    });
    expect(schema.parse({})).toEqual({});
  });

  it("propagates description from JSON Schema", () => {
    const schema = buildToolInputSchema({
      properties: {
        name: { type: "string", description: "User name" },
      },
      required: ["name"],
    });
    expect(schema.shape.name.description).toBe("User name");
  });
});

describe("buildToolInputSchema — primitive types", () => {
  it("string", () => {
    const s = buildToolInputSchema({
      properties: { x: { type: "string" } },
      required: ["x"],
    });
    expect(s.parse({ x: "ok" })).toEqual({ x: "ok" });
    expect(() => s.parse({ x: 1 })).toThrow();
  });

  it("number and integer both map to z.number", () => {
    const s = buildToolInputSchema({
      properties: { n: { type: "number" }, i: { type: "integer" } },
      required: ["n", "i"],
    });
    expect(s.parse({ n: 1.5, i: 2 })).toEqual({ n: 1.5, i: 2 });
    expect(() => s.parse({ n: "1", i: 2 })).toThrow();
  });

  it("boolean", () => {
    const s = buildToolInputSchema({
      properties: { b: { type: "boolean" } },
      required: ["b"],
    });
    expect(s.parse({ b: true })).toEqual({ b: true });
    expect(() => s.parse({ b: "true" })).toThrow();
  });

  it("null type accepts only null", () => {
    const s = buildToolInputSchema({
      properties: { n: { type: "null" } },
      required: ["n"],
    });
    expect(s.parse({ n: null })).toEqual({ n: null });
    expect(() => s.parse({ n: 0 })).toThrow();
  });

  it("keeps string length and pattern constraints", () => {
    const s = buildToolInputSchema({
      properties: { k: { type: "string", minLength: 1, maxLength: 4, pattern: "^[a-z]+$" } },
      required: ["k"],
    });
    expect(s.parse({ k: "ab" })).toEqual({ k: "ab" });
    expect(() => s.parse({ k: "" })).toThrow();
    expect(() => s.parse({ k: "abcde" })).toThrow();
    expect(() => s.parse({ k: "AB" })).toThrow();
  });

  it("keeps integer and numeric bounds", () => {
    const s = buildToolInputSchema({
      properties: { i: { type: "integer", minimum: 1, maximum: 10 } },
      required: ["i"],
    });
    expect(s.parse({ i: 3 })).toEqual({ i: 3 });
    expect(() => s.parse({ i: 1.5 })).toThrow();
    expect(() => s.parse({ i: 0 })).toThrow();
    expect(() => s.parse({ i: 11 })).toThrow();
  });

  it("a nullable non-empty string rejects the empty string", () => {
    const s = buildToolInputSchema({
      properties: { cursor: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] } },
      required: ["cursor"],
    });
    expect(s.parse({ cursor: null })).toEqual({ cursor: null });
    expect(s.parse({ cursor: "c1" })).toEqual({ cursor: "c1" });
    expect(() => s.parse({ cursor: "" })).toThrow();
  });
});

describe("buildToolInputSchema — $ref", () => {
  // The shape pydantic / FastMCP emit: object params live in $defs.
  const schema = {
    properties: {
      definition: { $ref: "#/$defs/Definition" },
      target: { $ref: "#/$defs/Target" },
    },
    required: ["definition", "target"],
    $defs: {
      Definition: {
        type: "object",
        properties: { title: { type: "string" }, data: { $ref: "#/$defs/Data" } },
        required: ["title", "data"],
      },
      Data: {
        type: "object",
        properties: { symbol: { type: "string" }, interval: { enum: ["1m", "5m"] } },
        required: ["symbol", "interval"],
      },
      Target: {
        oneOf: [
          { type: "object", properties: { mode: { const: "headless" } }, required: ["mode"] },
          { type: "object", properties: { mode: { const: "workspace" }, id: { type: "string" } }, required: ["mode", "id"] },
        ],
      },
    },
  };

  it("resolves $ref against $defs, including nested refs", () => {
    const s = buildToolInputSchema(schema);
    const ok = {
      definition: { title: "t", data: { symbol: "AAPL.US", interval: "5m" } },
      target: { mode: "headless" },
    };
    expect(s.parse(ok)).toEqual(ok);
    expect(() => s.parse({ ...ok, definition: JSON.stringify(ok.definition) })).toThrow();
    expect(() => s.parse({ ...ok, definition: { title: "t", data: { symbol: "AAPL.US", interval: "2m" } } })).toThrow();
    expect(() => s.parse({ ...ok, target: { mode: "nowhere" } })).toThrow();
  });

  it("shows the model the referenced structure, not an empty schema", () => {
    const json = z.toJSONSchema(buildToolInputSchema(schema)) as {
      properties: Record<string, { type?: string; properties?: Record<string, unknown> }>;
    };
    expect(json.properties.definition.type).toBe("object");
    expect(Object.keys(json.properties.definition.properties ?? {}).sort()).toEqual(["data", "title"]);
  });

  it("a recursive $ref terminates instead of looping", () => {
    const s = buildToolInputSchema({
      properties: { node: { $ref: "#/$defs/Node" } },
      required: ["node"],
      $defs: {
        Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } },
      },
    });
    expect(s.parse({ node: { next: { next: {} } } })).toEqual({ node: { next: { next: {} } } });
  });

  it("an unresolvable $ref falls back to z.unknown()", () => {
    const s = buildToolInputSchema({
      properties: { v: { $ref: "#/$defs/Missing" } },
      required: ["v"],
    });
    expect(s.parse({ v: 1 })).toEqual({ v: 1 });
  });
});

describe("buildToolInputSchema — array", () => {
  it("with items", () => {
    const s = buildToolInputSchema({
      properties: { xs: { type: "array", items: { type: "string" } } },
      required: ["xs"],
    });
    expect(s.parse({ xs: ["a", "b"] })).toEqual({ xs: ["a", "b"] });
    expect(() => s.parse({ xs: [1] })).toThrow();
  });

  it("without items falls back to z.array(z.unknown())", () => {
    const s = buildToolInputSchema({
      properties: { xs: { type: "array" } },
      required: ["xs"],
    });
    expect(s.parse({ xs: [1, "a", true] })).toEqual({ xs: [1, "a", true] });
  });
});

describe("buildToolInputSchema — nested object", () => {
  it("with properties", () => {
    const s = buildToolInputSchema({
      properties: {
        person: {
          type: "object",
          properties: {
            name: { type: "string" },
            age: { type: "integer" },
          },
          required: ["name"],
        },
      },
      required: ["person"],
    });
    expect(s.parse({ person: { name: "alice" } })).toEqual({ person: { name: "alice" } });
    expect(() => s.parse({ person: {} })).toThrow();
  });

  it("a map with an additionalProperties schema validates each value", () => {
    const s = buildToolInputSchema({
      properties: {
        panels: {
          type: "object",
          additionalProperties: { type: "object", properties: { top: { type: "number" } }, required: ["top"] },
        },
      },
      required: ["panels"],
    });
    expect(s.parse({ panels: { P1: { top: 0 } } })).toEqual({ panels: { P1: { top: 0 } } });
    expect(() => s.parse({ panels: { P1: {} } })).toThrow();
  });

  it("without properties falls back to z.record(z.string(), z.unknown())", () => {
    const s = buildToolInputSchema({
      properties: { meta: { type: "object" } },
      required: ["meta"],
    });
    expect(s.parse({ meta: { a: 1, b: "x" } })).toEqual({ meta: { a: 1, b: "x" } });
  });
});

describe("buildToolInputSchema — enum", () => {
  it("string enum maps to z.enum", () => {
    const s = buildToolInputSchema({
      properties: { color: { type: "string", enum: ["red", "blue"] } },
      required: ["color"],
    });
    expect(s.parse({ color: "red" })).toEqual({ color: "red" });
    expect(() => s.parse({ color: "green" })).toThrow();
  });

  it("mixed-type enum maps to union of literals", () => {
    const s = buildToolInputSchema({
      properties: { v: { enum: [1, "two", true] } },
      required: ["v"],
    });
    expect(s.parse({ v: 1 })).toEqual({ v: 1 });
    expect(s.parse({ v: "two" })).toEqual({ v: "two" });
    expect(s.parse({ v: true })).toEqual({ v: true });
    expect(() => s.parse({ v: "one" })).toThrow();
  });

  it("single-value enum maps to single literal", () => {
    const s = buildToolInputSchema({
      properties: { kind: { enum: ["only"] } },
      required: ["kind"],
    });
    expect(s.parse({ kind: "only" })).toEqual({ kind: "only" });
    expect(() => s.parse({ kind: "other" })).toThrow();
  });
});

describe("buildToolInputSchema — const", () => {
  it("maps const to z.literal", () => {
    const s = buildToolInputSchema({
      properties: { tag: { const: "fixed" } },
      required: ["tag"],
    });
    expect(s.parse({ tag: "fixed" })).toEqual({ tag: "fixed" });
    expect(() => s.parse({ tag: "other" })).toThrow();
  });

  it("preserves description on const", () => {
    const s = buildToolInputSchema({
      properties: { tag: { const: "x", description: "fixed tag" } },
      required: ["tag"],
    });
    expect(s.shape.tag.description).toBe("fixed tag");
  });
});

describe("buildToolInputSchema — anyOf / oneOf", () => {
  it("anyOf builds a union", () => {
    const s = buildToolInputSchema({
      properties: { v: { anyOf: [{ type: "string" }, { type: "number" }] } },
      required: ["v"],
    });
    expect(s.parse({ v: "x" })).toEqual({ v: "x" });
    expect(s.parse({ v: 1 })).toEqual({ v: 1 });
    expect(() => s.parse({ v: true })).toThrow();
  });

  it("oneOf builds a union", () => {
    const s = buildToolInputSchema({
      properties: { v: { oneOf: [{ type: "string" }, { type: "boolean" }] } },
      required: ["v"],
    });
    expect(s.parse({ v: "x" })).toEqual({ v: "x" });
    expect(s.parse({ v: false })).toEqual({ v: false });
  });

  it("single-element anyOf collapses to that schema", () => {
    const s = buildToolInputSchema({
      properties: { v: { anyOf: [{ type: "string" }] } },
      required: ["v"],
    });
    expect(s.parse({ v: "x" })).toEqual({ v: "x" });
  });
});

describe("buildToolInputSchema — nullable", () => {
  it("nullable: true marks the field as nullable", () => {
    const s = buildToolInputSchema({
      properties: { v: { type: "string", nullable: true } },
      required: ["v"],
    });
    expect(s.parse({ v: null })).toEqual({ v: null });
    expect(s.parse({ v: "x" })).toEqual({ v: "x" });
  });

  it("type array containing 'null' implies nullable", () => {
    const s = buildToolInputSchema({
      properties: { v: { type: ["string", "null"] } },
      required: ["v"],
    });
    expect(s.parse({ v: null })).toEqual({ v: null });
    expect(s.parse({ v: "x" })).toEqual({ v: "x" });
  });

  it("multi-type array (non-null) builds a union", () => {
    const s = buildToolInputSchema({
      properties: { v: { type: ["string", "number"] } },
      required: ["v"],
    });
    expect(s.parse({ v: "x" })).toEqual({ v: "x" });
    expect(s.parse({ v: 1 })).toEqual({ v: 1 });
    expect(() => s.parse({ v: true })).toThrow();
  });
});

describe("buildToolInputSchema — unknown / fallback", () => {
  it("missing type falls back to z.unknown()", () => {
    const s = buildToolInputSchema({
      properties: { v: {} },
    });
    expect(s.parse({ v: { whatever: 1 } })).toEqual({ v: { whatever: 1 } });
    expect(s.parse({})).toEqual({});
  });
});
