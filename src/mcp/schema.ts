import { z } from "zod";
import type { AgentTool } from "../protocol/types";

export function sanitizeMcpToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

type JsonSchemaProp = Record<string, unknown> & {
  type?: string | string[];
  enum?: unknown[];
  anyOf?: JsonSchemaProp[];
  oneOf?: JsonSchemaProp[];
  allOf?: JsonSchemaProp[];
  const?: unknown;
  description?: string;
  nullable?: boolean;
  items?: JsonSchemaProp;
  properties?: Record<string, JsonSchemaProp>;
  required?: string[];
  $ref?: string;
  additionalProperties?: boolean | JsonSchemaProp;
  patternProperties?: Record<string, JsonSchemaProp>;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
};

/** A tool schema's named definitions (`$defs`, or draft-07 `definitions`) that `$ref`s point into. */
type Defs = Record<string, JsonSchemaProp>;

// pydantic / FastMCP put every nested model in $defs and reference it, so a
// converter without $ref support hands the model `{}` for exactly the
// structured params that need a schema most.
const LOCAL_REF = /^#\/(?:\$defs|definitions)\/(.+)$/;

function jsonSchemaToZod(prop: JsonSchemaProp, defs: Defs = {}, seen: ReadonlySet<string> = new Set()): z.ZodTypeAny {
  if (typeof prop.$ref === "string") {
    const name = LOCAL_REF.exec(prop.$ref)?.[1];
    const target = name === undefined ? undefined : defs[name];
    // Unresolvable, or recursive on this path: stay permissive rather than loop.
    if (name === undefined || target === undefined || seen.has(name)) return z.unknown();
    // Sibling keywords (usually description) sit beside the $ref and win over the target's.
    const { $ref: _ref, ...siblings } = prop;
    return jsonSchemaToZod({ ...target, ...siblings }, defs, new Set([...seen, name]));
  }

  if (prop.const !== undefined) {
    const literal = z.literal(prop.const as string | number | boolean);
    return prop.description ? literal.describe(prop.description) : literal;
  }

  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    const stringValues = prop.enum.filter((v): v is string => typeof v === "string");
    if (stringValues.length === prop.enum.length && stringValues.length > 0) {
      const enumSchema = z.enum(stringValues as [string, ...string[]]);
      return prop.description ? enumSchema.describe(prop.description) : enumSchema;
    }
    const literals: z.ZodTypeAny[] = prop.enum.map((v) =>
      z.literal(v as string | number | boolean),
    );
    if (literals.length === 1) return literals[0];
    const union = z.union(literals as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
    return prop.description ? union.describe(prop.description) : union;
  }

  if (Array.isArray(prop.anyOf) && prop.anyOf.length > 0) {
    return buildUnion(prop.anyOf, prop.description, defs, seen);
  }
  if (Array.isArray(prop.oneOf) && prop.oneOf.length > 0) {
    return buildUnion(prop.oneOf, prop.description, defs, seen);
  }

  const types = Array.isArray(prop.type) ? prop.type : prop.type ? [prop.type] : [];
  const nullable = prop.nullable === true || types.includes("null");
  const nonNullTypes = types.filter((t) => t !== "null");

  const baseSchema = nonNullTypes.length > 1
    ? buildUnion(nonNullTypes.map((t) => ({ ...prop, type: t, nullable: false } as JsonSchemaProp)), undefined, defs, seen)
    : nonNullTypes.length === 1
      ? buildSingleTypeSchema(nonNullTypes[0], prop, defs, seen)
      : types.includes("null")
        ? z.null()
        : z.unknown();

  const withNullable = nullable ? baseSchema.nullable() : baseSchema;
  return prop.description && !withNullable.description
    ? withNullable.describe(prop.description)
    : withNullable;
}

function buildUnion(schemas: JsonSchemaProp[], description: string | undefined, defs: Defs, seen: ReadonlySet<string>): z.ZodTypeAny {
  const zodSchemas = schemas.map((s) => jsonSchemaToZod(s, defs, seen));
  if (zodSchemas.length === 1) {
    return description ? zodSchemas[0].describe(description) : zodSchemas[0];
  }
  const union = z.union(zodSchemas as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  return description ? union.describe(description) : union;
}

function buildSingleTypeSchema(type: string, prop: JsonSchemaProp, defs: Defs, seen: ReadonlySet<string>): z.ZodTypeAny {
  switch (type) {
    case "string": {
      // Constraints reach the model as part of the schema; without them it
      // sends values (an empty cursor, a free-form id) the server rejects.
      let s = z.string();
      if (typeof prop.minLength === "number") s = s.min(prop.minLength);
      if (typeof prop.maxLength === "number") s = s.max(prop.maxLength);
      if (typeof prop.pattern === "string") {
        try {
          s = s.regex(new RegExp(prop.pattern));
        } catch {
          // Not an ECMA-262 pattern: leave it to the server to enforce.
        }
      }
      return s;
    }
    case "number":
    case "integer": {
      let n = type === "integer" ? z.number().int() : z.number();
      if (typeof prop.minimum === "number") n = n.min(prop.minimum);
      if (typeof prop.maximum === "number") n = n.max(prop.maximum);
      return n;
    }
    case "boolean":
      return z.boolean();
    case "null":
      return z.null();
    case "array": {
      let a = z.array(prop.items ? jsonSchemaToZod(prop.items, defs, seen) : z.unknown());
      if (typeof prop.minItems === "number") a = a.min(prop.minItems);
      if (typeof prop.maxItems === "number") a = a.max(prop.maxItems);
      return a;
    }
    case "object": {
      if (!prop.properties) {
        // A map (e.g. panel id -> panel): its key and value schemas are the
        // parts the model needs, given by patternProperties or additionalProperties.
        const patterns = Object.entries(prop.patternProperties ?? {});
        if (patterns.length > 0) {
          const values = patterns.map(([, v]) => v);
          let key = z.string();
          if (patterns.length === 1) {
            try {
              key = key.regex(new RegExp(patterns[0][0]));
            } catch {
              // Not an ECMA-262 pattern: leave it to the server to enforce.
            }
          }
          return z.record(key, buildUnion(values, undefined, defs, seen));
        }
        const values = prop.additionalProperties;
        return z.record(
          z.string(),
          typeof values === "object" && values !== null ? jsonSchemaToZod(values as JsonSchemaProp, defs, seen) : z.unknown(),
        );
      }
      const shape: Record<string, z.ZodTypeAny> = {};
      const required = new Set(prop.required ?? []);
      for (const [key, sub] of Object.entries(prop.properties)) {
        let s = jsonSchemaToZod(sub, defs, seen);
        if (!required.has(key)) s = s.optional();
        shape[key] = s;
      }
      // Servers that forbid extra keys reject them; z.object would silently
      // accept them, so the model never learns why the call failed.
      return prop.additionalProperties === false ? z.strictObject(shape) : z.object(shape);
    }
    default:
      return z.unknown();
  }
}

/**
 * Keys with this prefix are agent-managed decoration (e.g.
 * x-agentrita-conversation-id, x-agentrita-tables). They MUST NOT be exposed
 * to the LLM — the agent injects them on the way out, the MCP server reads
 * them on the way in. Stripping them from the model-facing schema avoids the
 * model hallucinating values for them.
 */
const INTERNAL_PARAM_PREFIX = "x-agentrita-";
const DISPLAY_SUMMARY_DESCRIPTION =
  "Display-only progress summary shown to the user before the tool runs. " +
  "Use a short human-readable gerund phrase, e.g. 'Checking renewable energy trend'. " +
  "The UI shows this directly as the progress message. " +
  "This value is not forwarded to the MCP tool and does not replace required arguments.";

export function buildToolInputSchema(
  inputSchema?: AgentTool["input_schema"],
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {
    display_summary: z.string().optional().describe(DISPLAY_SUMMARY_DESCRIPTION),
  };
  if (!inputSchema?.properties) return z.object(shape);

  const required = new Set(inputSchema.required ?? []);
  const defs = (inputSchema.$defs ?? inputSchema.definitions ?? {}) as Defs;

  for (const [key, prop] of Object.entries(inputSchema.properties)) {
    if (key === "display_summary") continue;
    if (key.startsWith(INTERNAL_PARAM_PREFIX)) continue;
    let zodProp = jsonSchemaToZod(prop as JsonSchemaProp, defs);
    if (!required.has(key)) zodProp = zodProp.optional();
    shape[key] = zodProp;
  }

  return z.object(shape);
}
