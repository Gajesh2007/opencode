import type { Argv } from "yargs"
import { Flag } from "@opencode-ai/core/flag/flag"

let warned = false

export function withYoloForever<T>(yargs: Argv<T>) {
  return yargs
    .option("yolo-forever", {
      type: "boolean",
      describe: "bypass all app permissions, including denies, for this process and children (dangerous!)",
    })
    .middleware((args) => {
      // Set this before Effect services, TUI workers, or servers are initialized.
      if (args["yolo-forever"] !== undefined) process.env.OPENCODE_YOLO_FOREVER = String(args["yolo-forever"])
      if (!Flag.OPENCODE_YOLO_FOREVER || warned) return
      warned = true
      console.error(
        args._[0] === "attach" || args.attach
          ? "Warning: YOLO FOREVER is local only. The attached server must start with --yolo-forever to bypass its permissions, including explicit denies."
          : "Warning: YOLO FOREVER bypasses all app permission checks, including explicit denies, for this process and its children. No permission config is changed.",
      )
    })
}
