export * as AgentMCP from "./agent-mcp.js"

import type { Agent } from "./agent.js"
import type { Mcp } from "./mcp/index.js"
import type { Permission } from "./permission.js"
import { McpTool } from "./tool/mcp.js"

/** A configured empty list means no MCP tools; omission preserves the full catalog. */
export function permissions(
  agent: Pick<Agent.Info, "mcpServers">,
  tools: ReadonlyArray<Pick<Mcp.Tool, "server" | "name">>,
): Permission.Ruleset {
  if (agent.mcpServers === undefined) return []
  const allowed = new Set(agent.mcpServers)
  return tools
    .filter((tool) => !allowed.has(tool.server))
    .map((tool) => ({
      action: McpTool.name(tool.server, tool.name),
      resource: "*",
      effect: "deny",
    }))
}
