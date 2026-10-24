import { Installation } from "@/installation"
import { Server } from "@/server/server"
import * as Log from "@opencode-ai/core/util/log"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Rpc } from "@/util/rpc"
import { upgrade } from "@/cli/upgrade"
import { Config } from "@/config/config"
import { GlobalBus } from "@/bus/global"
import { ServerAuth } from "@/server/auth"
import { writeHeapSnapshot } from "node:v8"
import { Heap } from "@/cli/heap"
import { AppRuntime } from "@/effect/app-runtime"
import { ensureProcessMetadata } from "@opencode-ai/core/util/opencode-process"
import { Effect } from "effect"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { Flag } from "@opencode-ai/core/flag/flag"
import { errorMessage } from "@/util/error"
import { createWorkerFetchHandlers } from "./worker-fetch"
import type { Pair } from "./util/pair"

ensureProcessMetadata("worker")

await Log.init({
  print: process.argv.includes("--print-logs"),
  dev: Installation.isLocal(),
  level: (() => {
    if (Installation.isLocal()) return "DEBUG"
    return "INFO"
  })(),
})

Heap.start()

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
})

// Subscribe to global events and forward them via RPC
GlobalBus.on("event", (event) => {
  Rpc.emit("global.event", event)
})

let server: Awaited<ReturnType<typeof Server.listen>> | undefined
let listening: ReturnType<typeof Server.listen> | undefined
const requests = createWorkerFetchHandlers((request) => {
  const auth = ServerAuth.header()
  if (auth && !request.headers.has("authorization")) request.headers.set("Authorization", auth)
  return Server.Default().app.fetch(request)
})

export const rpc = {
  fetch: requests.fetch,
  cancelFetch: requests.cancelFetch,
  snapshot() {
    const result = writeHeapSnapshot("server.heapsnapshot")
    return result
  },
  async server(input: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    if (server) await server.stop(true)
    server = await Server.listen(input)
    return { url: server.url.toString() }
  },
  /** A network listener for pairing devices, started on first use and kept until shutdown. */
  async pairListen(): Promise<Pair.Listener> {
    const password = Flag.OPENCODE_SERVER_PASSWORD
    if (!password) return { error: "Pairing requires a server password; set OPENCODE_SERVER_PASSWORD and restart" }
    // The listener shares this worker's live services, so paired devices drive the TUI's own sessions.
    listening ??= server
      ? Promise.resolve(server)
      : Server.listen({ hostname: "127.0.0.1", port: 0, ephemeral: true, sharedRuntime: true })
    // RPC has no rejection envelope, so a failure must come back as a value.
    return listening.then(
      (listener) => {
        server = listener
        return { url: listener.url.origin, username: Flag.OPENCODE_SERVER_USERNAME || "opencode", password }
      },
      (error: unknown) => {
        listening = undefined
        Log.Default.error("pairing listener failed", { error: errorMessage(error) })
        return { error: `Could not start a network listener: ${errorMessage(error)}` }
      },
    )
  },
  async checkUpgrade(input: { directory: string }) {
    await InstanceRuntime.load({ directory: input.directory })
    await upgrade().catch(() => {})
  },
  async reload() {
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        const cfg = yield* Config.Service
        yield* cfg.invalidate()
        yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
      }),
    )
  },
  async shutdown() {
    Log.Default.info("worker shutting down")
    requests.shutdown()

    await InstanceRuntime.disposeAllInstances()
    if (server) await server.stop(true)
  },
}

Rpc.listen(rpc)
