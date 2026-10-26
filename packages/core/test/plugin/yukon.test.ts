import { expect } from "bun:test"
import { Effect } from "effect"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { YukonPlugin } from "@opencode/core/plugin/yukon"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
it.live("exports the native shell session ID for Yukon attribution", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const hooks = yield* PluginHooks.Service
    yield* YukonPlugin.Plugin.effect(yield* PluginHost.make(plugins))
    const input = {
      command: "true",
      cwd: "/tmp",
      shell: "/bin/sh",
      timeout: 0,
      sessionID: "ses_native",
      env: { KEEP: "yes" },
    }
    expect((yield* hooks.trigger("shell", "create.before", input)).env).toEqual({
      KEEP: "yes",
      YUKON_OPENCODE_SESSION_ID: "ses_native",
    })
    expect(
      (yield* hooks.trigger("shell", "create.before", {
        command: "true",
        cwd: "/tmp",
        shell: "/bin/sh",
        timeout: 0,
        env: {},
      })).env,
    ).toEqual({})
  }),
)
