import { tool, type ToolSet, type StopCondition } from "ai";
import type { AgentTool } from "../protocol/types";
import { sanitizeMcpToolName, buildToolInputSchema } from "./schema";
import {
  WORKSPACE_BRIDGE_COMMAND_NAMES,
  BRIDGE_MOUNT_EXTRA_NAMES,
} from "../protocol/bridge-commands";
import { SQL_TOOL_NAME_SET } from "../agent/tools/sql";
import { NATIVE_TOOL_NAME_SET } from "../agent/tools/native";
import { CLIENT_SQL_TOOL_NAME } from "../agent/tools/client-sql";

export interface McpToolEntry {
  serverId: string;
  toolName: string;
  sanitizedName: string;
  description: string;
}

export interface McpToolsResult {
  toolSet: ToolSet;
  entries: McpToolEntry[];
  stopCondition: StopCondition<ToolSet>;
  isMcpToolName: (name: string) => boolean;
}

/**
 * Drop user-supplied MCP wrappers whose name collides with a tool the
 * agent owns natively:
 *   - Workspace bridge commands (Path A native SSE; Path B wrappers exist
 *     only for Claude Desktop and must not double-register).
 *   - SQL family (in-process on the agent; closure on pendingTables).
 *
 * Match is suffix-based to tolerate workspace's server-slug prefixes
 * (e.g. "agentritamcp_manage_dashboard" → "manage_dashboard").
 */
function endsWithCanonical(toolName: string, canonical: ReadonlySet<string>): boolean {
  for (const cmd of canonical) {
    if (toolName === cmd || toolName.endsWith(`_${cmd}`)) return true;
  }
  return false;
}

const CLIENT_SQL_NAME_SET: ReadonlySet<string> = new Set([CLIENT_SQL_TOOL_NAME]);

function isAgentOwnedTool(toolName: string): boolean {
  return (
    endsWithCanonical(toolName, WORKSPACE_BRIDGE_COMMAND_NAMES) ||
    endsWithCanonical(toolName, BRIDGE_MOUNT_EXTRA_NAMES) ||
    endsWithCanonical(toolName, SQL_TOOL_NAME_SET) ||
    endsWithCanonical(toolName, NATIVE_TOOL_NAME_SET) ||
    endsWithCanonical(toolName, CLIENT_SQL_NAME_SET)
  );
}

export function makeMcpTools(agentTools: AgentTool[]): McpToolsResult {
  const toolSet: ToolSet = {};
  const entries: McpToolEntry[] = [];
  const usedNames = new Set<string>();

  for (const agentTool of agentTools) {
    if (isAgentOwnedTool(agentTool.name)) continue;
    let sanitized = sanitizeMcpToolName(agentTool.name);
    if (usedNames.has(sanitized)) {
      let suffix = 2;
      while (usedNames.has(`${sanitized}_${suffix}`)) suffix++;
      sanitized = `${sanitized}_${suffix}`;
    }
    usedNames.add(sanitized);

    const inputSchema = buildToolInputSchema(agentTool.input_schema);
    const description = agentTool.description ?? agentTool.name;

    toolSet[sanitized] = tool({
      description,
      inputSchema,
    });

    entries.push({
      serverId: agentTool.server_id,
      toolName: agentTool.name,
      sanitizedName: sanitized,
      description,
    });
  }

  const mcpToolNames = new Set(entries.map((e) => e.sanitizedName));

  const stopCondition: StopCondition<ToolSet> = ({ steps }) => {
    const lastStep = steps.at(-1);
    if (!lastStep) return false;
    return lastStep.toolCalls.some((tc) => mcpToolNames.has(tc.toolName));
  };

  return {
    toolSet,
    entries,
    stopCondition,
    isMcpToolName: (name: string) => mcpToolNames.has(name),
  };
}
