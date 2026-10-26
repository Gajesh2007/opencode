import { expect, test } from "bun:test"
import { directory, json } from "./fixture/tui-client"
import { createAppFixture } from "./fixture/app"

test.each([100, 44])("renders fork controls at width %i", async (width) => {
  const sessionID = "ses_fork_controls"
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const session = {
    id: sessionID,
    projectID: "project",
    title: "Fork controls",
    agent: "build",
    model: { providerID: "demo", id: "gpt-6.1-sol" },
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const calls: string[] = []
  await using setup = await createAppFixture({
    width,
    height: 30,
    args: { sessionID },
    config: {
      animations: false,
      keybinds: {
        "fork.goal": "f5",
        "model.service-tier": "f6",
        "model.upstream": "f7",
        "fork.agents": "f8",
        "model.reasoning-mode": "f9",
        "subagent.model": "f10",
      },
    },
    fetch: async (url) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/agent")
        return json({
          location,
          data: [
            { id: "build", mode: "primary", hidden: false, permissions: [] },
            { id: "review", name: "review", mode: "subagent", hidden: false, permissions: [] },
          ],
        })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
      if (url.pathname === "/api/model")
        return json({
          location,
          data: [
            {
              id: "gpt-6.1-sol",
              modelID: "gpt-6.1-sol",
              providerID: "demo",
              package: "@opencode/ai/providers/openai",
              name: "GPT-6.1 Sol",
              variants: [{ id: "max" }],
              cost: [],
              time: { released: 0 },
            },
          ],
        })
      if (url.pathname === "/api/session/" + sessionID) return json({ data: session })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      if (url.pathname === "/api/rpc/opencode.fork/subagentModels") return json({ output: {} })
      if (url.pathname === "/api/rpc/opencode.fork/state") {
        calls.push("state")
        return json({
          output: {
            goal: {
              sessionID,
              objective: "Port the fork",
              status: "active",
              tokensUsed: 200,
              costUsed: 0,
              unknownAttempts: 0,
              createdAt: 1,
            },
            agents: [{ sessionID, path: "/root", status: "idle" }],
          },
        })
      }
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Build · GPT-6.1"))
  setup.mockInput.pressKey("F5")
  await setup.waitForFrame((frame) => frame.includes("Start a goal") && frame.includes("active"))
  expect(calls).toEqual(["state"])
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("Start a goal"))
  setup.mockInput.pressKey("F6")
  await setup.waitForFrame((frame) => frame.includes("Select service tier") && frame.includes("ultrafast"))
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("Select service tier"))
  setup.mockInput.pressKey("F7")
  await setup.waitForFrame((frame) => frame.includes("Pin upstream provider"))
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("Pin upstream provider"))
  setup.mockInput.pressKey("F9")
  await setup.waitForFrame((frame) => frame.includes("Select reasoning mode") && frame.includes("Pro"))
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("Select reasoning mode"))
  setup.mockInput.pressKey("F10")
  await setup.waitForFrame((frame) => frame.includes("Configure subagent model") && frame.includes("review"))
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("Configure subagent model"))
  setup.mockInput.pressKey("F8")
  await setup.waitForFrame((frame) => frame.includes("/root") && frame.includes("Stop all subagents"))
})
