import { expect, test } from "bun:test"
import { AgentMCP } from "@opencode/core/agent-mcp"
import { Mcp } from "@opencode/core/mcp/index"
import { Permission } from "@opencode/core/permission"

const tools = [
  { server: Mcp.ServerName.make("docs"), name: "search" },
  { server: Mcp.ServerName.make("private-admin"), name: "execute" },
]

test("an omitted server list retains every MCP tool", () => {
  expect(AgentMCP.permissions({}, tools)).toEqual([])
})

test("agent MCP scoping overrides broader session allow rules", () => {
  const rules = Permission.merge(
    [{ action: "*", resource: "*", effect: "allow" }],
    AgentMCP.permissions({ mcpServers: ["docs"] }, tools),
  )
  expect(Permission.evaluate("docs_search", "*", rules).effect).toBe("allow")
  expect(Permission.evaluate("private-admin_execute", "*", rules).effect).toBe("deny")
  expect(Permission.evaluate("read", "file.ts", rules).effect).toBe("allow")
})

test("an empty server list excludes all registered MCP tools", () => {
  const rules = AgentMCP.permissions({ mcpServers: [] }, tools)
  expect(rules).toHaveLength(2)
  for (const action of ["docs_search", "private-admin_execute"])
    expect(Permission.evaluate(action, "*", rules).effect).toBe("deny")
})
