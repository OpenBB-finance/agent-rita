/**
 * Lazy singleton MCP client for Tako's hosted endpoint.
 *
 * Keyless connections land on Tako's anonymous free tier, which serves
 * tako_search, tako_answer and tako_available_data under a per-IP rate limit.
 * TAKO_API_TOKEN sends a bearer header and unlocks the account's own limits
 * plus tako_contents. This is the companion server's outbound dependency, the
 * same class as Tavily/Daytona/OpenAI calls — the agent itself still never
 * opens MCP connections.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getLogger } from "../../../lib/logger";

const logger = getLogger(["mcp", "tako"]);

const DEFAULT_TAKO_MCP_URL = "https://mcp.tako.com/mcp";
/**
 * Upstream budgets 130s for search/answer and 60s for contents, and
 * available_data pages several sub-requests. A shorter client deadline would
 * abort normal-latency calls that the server is still billing for.
 */
const TAKO_CALL_TIMEOUT_MS = 150_000;
/**
 * The handshake is a single round-trip, so it gets a much tighter deadline
 * than a call. Without one, an endpoint that accepts the connection but never
 * answers `initialize` leaves the tool waiting forever and the chat appears
 * frozen.
 */
const TAKO_CONNECT_TIMEOUT_MS = 15_000;

export function isTakoEnabled(): boolean {
  return process.env.TAKO_ENABLED !== "false";
}

export function isTakoAuthed(): boolean {
  return !!process.env.TAKO_API_TOKEN;
}

/**
 * No rate figure on purpose: the free tier's limit is enforced per edge
 * location and is not a number the server can promise, so stating one in
 * model-facing text would be misleading.
 */
export function withFreeTierHint(text: string): string {
  if (isTakoAuthed()) return text;
  return `${text}\n(Tako is running on the anonymous free tier. Set TAKO_API_TOKEN for higher limits and the full toolset.)`;
}

/**
 * An upstream error can carry no text at all. The agent drops empty content
 * items, which would leave the model seeing a tool call that returned nothing
 * and inventing a result, so always give it something to read.
 */
export function errorText(text: string): string {
  return text.trim().length > 0 ? text : "Tako returned an error with no detail.";
}

export interface TakoCallResult {
  text: string;
  structured: unknown;
  isError: boolean;
}

let clientPromise: Promise<Client> | null = null;

async function connect(): Promise<Client> {
  const url = process.env.TAKO_MCP_URL ?? DEFAULT_TAKO_MCP_URL;
  const token = process.env.TAKO_API_TOKEN;
  const transport = new StreamableHTTPClientTransport(
    new URL(url),
    token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : undefined,
  );
  const client = new Client({ name: "agent-rita-companion", version: "1.0.0" });
  await client.connect(transport, { timeout: TAKO_CONNECT_TIMEOUT_MS });
  return client;
}

function getClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = connect().catch((err: unknown) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

export function resetTakoClientForTests(): void {
  clientPromise = null;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (
      typeof item === "object" &&
      item !== null &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string"
    ) {
      parts.push((item as { text: string }).text);
    }
  }
  return parts.join("\n");
}

/**
 * A timed-out or rejected call may already have been executed and billed
 * upstream, so only a dead transport is worth retrying — anything else is
 * surfaced to the model instead of being silently re-issued.
 */
function isConnectionError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes("timed out") || msg.includes("timeout")) return false;
  return (
    msg.includes("session") ||
    msg.includes("connection") ||
    msg.includes("socket") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("network") ||
    msg.includes("fetch failed") ||
    msg.includes("closed")
  );
}

/** Drop the shared client, closing it if this caller still owns the handle. */
async function dropClient(owned: Promise<Client> | null): Promise<void> {
  if (owned !== null && clientPromise !== owned) return;
  clientPromise = null;
  try {
    await (await owned)?.close();
  } catch {
    // The transport is already broken; nothing further to release.
  }
}

/**
 * Call one upstream Tako tool. Reconnects once on a connection-level failure,
 * then rethrows.
 */
export async function callTakoTool(
  name: string,
  args: Record<string, unknown>,
): Promise<TakoCallResult> {
  // Tracks the client this call actually used. Reading `clientPromise` before
  // the attempt would miss a connection opened *by* that attempt, so the very
  // first call of the process would orphan its broken transport instead of
  // closing it.
  let used: Promise<Client> | null = null;
  const attempt = async (): Promise<TakoCallResult> => {
    used = getClient();
    const client = await used;
    const result = await client.callTool({ name, arguments: args }, undefined, {
      timeout: TAKO_CALL_TIMEOUT_MS,
    });
    return {
      text: textOf(result.content),
      structured: result.structuredContent,
      isError: result.isError === true,
    };
  };
  try {
    return await attempt();
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Tako ${name} connection failed, reconnecting once: ${msg}`);
    await dropClient(used);
    return attempt();
  }
}
