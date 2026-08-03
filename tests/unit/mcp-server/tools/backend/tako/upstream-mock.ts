/**
 * Shared SDK-level mock for ALL tako tests. bun's mock.module leaks across
 * test files in one process, so every tako test file uses this ONE seam
 * (mocking the MCP SDK client) instead of mocking each other's source
 * modules. Re-registering the identical factory is idempotent, so test-file
 * order never matters. Import this BEFORE importing any tako source module.
 */
import { mock } from "bun:test";

export interface UpstreamCall {
  name: string;
  args: Record<string, unknown>;
}

interface UpstreamResponse {
  content: { type: string; text: string }[];
  structuredContent: unknown;
  isError: boolean;
}

function defaultResponse(): UpstreamResponse {
  return {
    content: [{ type: "text", text: "upstream text" }],
    structuredContent: undefined,
    isError: false,
  };
}

export const upstream = {
  response: defaultResponse(),
  /** shift()ed per call — push N errors to make the next N calls throw. */
  errors: [] as Error[],
  calls: [] as UpstreamCall[],
  /** Third arg of client.callTool — carries the per-call timeout. */
  callOptions: [] as ({ timeout?: number } | undefined)[],
  connects: 0,
  /** Second arg of client.connect — carries the handshake timeout. */
  connectOptions: [] as ({ timeout?: number } | undefined)[],
  /** Bumped by client.close(), so tests can assert a dropped client is released. */
  closes: 0,
  transportUrls: [] as string[],
  /** Auth header the transport was constructed with, for leak assertions. */
  transportHeaders: [] as Record<string, string>[],
  reset(): void {
    this.response = defaultResponse();
    this.errors = [];
    this.calls = [];
    this.callOptions = [];
    this.connects = 0;
    this.connectOptions = [];
    this.closes = 0;
    this.transportUrls = [];
    this.transportHeaders = [];
  },
};

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect(_transport: unknown, options?: { timeout?: number }): Promise<void> {
      upstream.connects += 1;
      upstream.connectOptions.push(options);
    }
    async close(): Promise<void> {
      upstream.closes += 1;
    }
    async callTool(
      params: { name: string; arguments: Record<string, unknown> },
      _resultSchema?: unknown,
      options?: { timeout?: number },
    ): Promise<UpstreamResponse> {
      upstream.calls.push({ name: params.name, args: params.arguments });
      upstream.callOptions.push(options);
      const err = upstream.errors.shift();
      if (err) throw err;
      return upstream.response;
    }
  },
}));

mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL, opts?: { requestInit?: { headers?: Record<string, string> } }) {
      upstream.transportUrls.push(url.toString());
      upstream.transportHeaders.push(opts?.requestInit?.headers ?? {});
    }
  },
}));
