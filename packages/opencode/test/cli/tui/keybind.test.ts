import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { TuiKeybind } from "@/cli/cmd/tui/config/keybind"

describe("tui keybinds", () => {
  test("binds background and shell kill commands by default", () => {
    const keybinds = TuiKeybind.parse({})
    expect(keybinds.session_background).toBe("ctrl+b")
    expect(keybinds.shell_kill).toBe("ctrl+d")
    expect(TuiKeybind.CommandMap.session_background).toBe("session.background")
    expect(TuiKeybind.CommandMap.shell_kill).toBe("shell.kill")
  })

  test("keeps accepting the renamed subagent_background keybind", () => {
    expect(TuiKeybind.unknownKeys({ subagent_background: "ctrl+g" })).toEqual([])
    expect(Schema.decodeUnknownSync(TuiKeybind.KeybindOverrides)({ subagent_background: "none" })).toEqual({
      subagent_background: "none",
    })

    const renamed = TuiKeybind.parse({ subagent_background: "ctrl+g" })
    expect(renamed.session_background).toBe("ctrl+g")
    expect(renamed).not.toHaveProperty("subagent_background")
    expect(TuiKeybind.parse({ subagent_background: "ctrl+g", session_background: "ctrl+o" }).session_background).toBe(
      "ctrl+o",
    )
  })
})
