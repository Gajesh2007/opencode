import { Effect } from "effect"
import { Server } from "../../server/server"
import { effectCmd } from "../effect-cmd"
import {
  withNetworkOptions,
  resolveNetworkOptions,
  withRemoteOptions,
  prepareRemoteAccess,
  startRemoteAccess,
} from "../network"
import { withYoloForever } from "../yolo-forever"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) =>
    withRemoteOptions(withNetworkOptions(withYoloForever(yargs))).option("dangerously-skip-permissions", {
      type: "boolean",
      describe: "auto-approve permissions that are not explicitly denied (dangerous!)",
      default: false,
    }),
  describe: "starts a headless opencode server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    if (args["dangerously-skip-permissions"]) process.env.OPENCODE_DANGEROUSLY_SKIP_PERMISSIONS = "true"
    const print = (line: string) => console.log(line)
    if (args.remote) {
      if (!(yield* Effect.promise(() => prepareRemoteAccess({ yes: args.yes, command: "serve", print })))) return
    }
    if (!process.env.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)
    if (args.remote) startRemoteAccess(print)

    yield* Effect.never
  }),
})
