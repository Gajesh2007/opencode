import { heapStats } from "bun:jsc"
import { Global } from "@opencode-ai/core/global"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { mount, wait } from "./sync-fixture"

// Run from packages/opencode, in a fresh process:
// bun run --conditions=browser test/cli/cmd/tui/transcript-memory.bench.ts [retain|control] [sessions] [messages] [bytes]
const control = process.argv[2] === "control"
const sessions = Number(process.argv[3] ?? 30)
const messages = Number(process.argv[4] ?? 120)
const bytes = Number(process.argv[5] ?? 8192)
const directory = await mkdtemp(join(tmpdir(), "opencode-transcript-memory-"))
Global.Path.state = directory
await Bun.write(join(directory, "kv.json"), "{}")
const fixture = await mount()

function sample(stage: string) {
  Bun.gc(true)
  Bun.gc(true)
  const stats = heapStats()
  console.log(
    JSON.stringify({
      stage,
      control,
      sessions,
      messages,
      bytes,
      peakRSS: process.resourceUsage().maxRSS,
      rss: process.memoryUsage.rss(),
      heap: stats.heapSize,
      external: stats.extraMemorySize,
      legacySessions: Object.keys(fixture.sync.data.message).length,
      legacyMessages: Object.values(fixture.sync.data.message).reduce((sum, items) => sum + items.length, 0),
      legacyParts: Object.keys(fixture.sync.data.part).length,
      v2Sessions: Object.keys(fixture.syncV2.data.messages).length,
      v2Messages: Object.values(fixture.syncV2.data.messages).reduce((sum, items) => sum + items.length, 0),
    }),
  )
}

function publish(payload: GlobalEvent["payload"]) {
  fixture.emit({ directory: "/tmp/opencode", project: control ? "proj_control" : "proj_test", payload })
}

try {
  sample("mounted")
  for (let session = 0; session < sessions; session++) {
    const sessionID = `ses_${String(session).padStart(5, "0")}`
    for (let message = 0; message < messages; message++) {
      const messageID = `${sessionID}_msg_${String(message).padStart(5, "0")}`
      // JSON roundtrip gives each payload its own flat string, not shared rope backing.
      publish(
        JSON.parse(
          JSON.stringify({
            id: `${messageID}_info`,
            type: "message.updated",
            properties: {
              info: {
                id: messageID,
                sessionID,
                role: "user",
                time: { created: message },
                agent: "build",
                model: { providerID: "test", modelID: "test" },
              },
            },
          }),
        ),
      )
      publish(
        JSON.parse(
          JSON.stringify({
            id: `${messageID}_part`,
            type: "message.part.updated",
            properties: {
              sessionID,
              time: message,
              part: {
                id: `${messageID}_text`,
                messageID,
                sessionID,
                type: "text",
                text: `${messageID}:legacy:`.padEnd(bytes, "x"),
              },
            },
          }),
        ),
      )
      publish(
        JSON.parse(
          JSON.stringify({
            id: `${messageID}_v2`,
            type: "session.next.synthetic",
            properties: { sessionID, timestamp: message, text: `${messageID}:v2:`.padEnd(bytes, "y") },
          }),
        ),
      )
    }
    // Fence the SDK's batched queue without relying on a fixed sleep.
    fixture.emit({
      directory: "/tmp/opencode",
      project: "proj_test",
      payload: {
        id: `${sessionID}_fence`,
        type: "vcs.branch.updated",
        properties: { branch: sessionID },
      },
    })
    await wait(() => fixture.sync.data.vcs?.branch === sessionID)
    if (session === Math.floor(sessions / 2) - 1) sample("half")
  }
  sample("loaded")
} finally {
  fixture.app.renderer.destroy()
  await rm(directory, { recursive: true, force: true })
}
