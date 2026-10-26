export * as YukonPlugin from "./yukon.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"

export const Plugin = define({
  id: "opencode.yukon",
  effect: Effect.fn("YukonPlugin")(function* (ctx) {
    yield* ctx.shell.hook("create.before", (event) =>
      Effect.sync(() => {
        if (event.sessionID !== undefined) event.env.YUKON_OPENCODE_SESSION_ID = event.sessionID
      }),
    )
  }),
})
