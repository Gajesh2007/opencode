/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createStore } from "solid-js/store"
import { ToolCode } from "../../../src/cli/cmd/tui/component/tool-code"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { ThemeProvider } from "../../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../../src/cli/cmd/tui/context/tui-config"
import { parseFileToolInput } from "../../../src/cli/cmd/tui/util/tool-input"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { Global } from "@opencode-ai/core/global"
import { tmpdir } from "../../fixture/fixture"

test("renders and updates code from unfinished patch arguments", async () => {
  const previous = Global.Path.state
  await using tmp = await tmpdir()
  Global.Path.state = tmp.path
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const [state, setState] = createStore({ raw: '{"patchText":"*** Begin Patch\\n*** Add File: main.ts\\n+const' })
  const app = await testRender(
    () => (
      <TuiConfigProvider config={createTuiResolvedConfig()}>
        <KVProvider>
          <ThemeProvider mode="dark">
            <ToolCode content={String(parseFileToolInput(state.raw).patchText ?? "")} filetype="diff" streaming />
          </ThemeProvider>
        </KVProvider>
      </TuiConfigProvider>
    ),
    { width: 80, height: 16 },
  )
  try {
    await waitForFrame(app, "*** Add File: main.ts")
    expect(app.captureCharFrame()).toContain("*** Add File: main.ts")
    expect(app.captureCharFrame()).toContain("+const")

    setState("raw", (raw) => raw + " value = 1;\\n+console.log(value)")
    await waitForFrame(app, "+console.log(value)")
    expect(app.captureCharFrame()).toContain("+const value = 1;")
    expect(app.captureCharFrame()).toContain("+console.log(value)")
    expect(app.captureCharFrame()).not.toContain('"patchText"')
  } finally {
    app.renderer.destroy()
    Global.Path.state = previous
  }
})

async function waitForFrame(app: Awaited<ReturnType<typeof testRender>>, text: string) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    await app.renderOnce()
    if (app.captureCharFrame().includes(text)) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for code: ${text}`)
}
