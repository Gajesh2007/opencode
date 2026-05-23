import { afterEach, describe, expect, test } from "bun:test"
import { createSignal, For } from "solid-js"
import { testRender } from "@opentui/solid"

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = undefined
})

type ToolFixture = { icon: string; label: string; error?: string }

const INLINE_TOOL_ICON_WIDTH = 2

const tools: readonly ToolFixture[] = [
  {
    icon: "✱",
    label:
      'Grep "OPENCODE.*DB|database|sqlite|drizzle|dev.*db|data.*dir|xdg|APPDATA" in packages/opencode/src (151 matches)',
  },
  {
    icon: "✱",
    label: 'Glob "**/*db*" in packages/opencode (6 matches)',
  },
  {
    icon: "→",
    label: "Read packages/opencode/src/storage/db.ts [offset=1, limit=130]",
  },
  {
    icon: "→",
    label: "Read packages/opencode/src/index.ts [offset=1, limit=100]",
    error: "No LSP server available for this file type.",
  },
  {
    icon: "✱",
    label:
      'Grep "export const OPENCODE_DB|OPENCODE_DB|OPENCODE_DEV|Global\\.Path\\.data|data =" in packages/opencode/src (115 matches)',
  },
] as const

function InlineToolRow(props: { item: ToolFixture; errorExpanded?: boolean }) {
  const [margin, setMargin] = createSignal(0)

  return (
    <box
      marginTop={margin()}
      paddingLeft={3}
      renderBefore={function () {
        const parent = this.parent
        if (!parent) return
        setMargin(parent.getChildren()[parent.getChildren().indexOf(this) - 1]?.id.startsWith("text-") ? 1 : 0)
      }}
    >
      <box flexDirection="row">
        <text width={INLINE_TOOL_ICON_WIDTH}>{props.item.icon}</text>
        <text flexGrow={1}>{props.item.label}</text>
      </box>
      {props.item.error && props.errorExpanded && (
        <box paddingLeft={INLINE_TOOL_ICON_WIDTH}>
          <text>{props.item.error}</text>
        </box>
      )}
    </box>
  )
}

function Fixture(props: { errorExpanded?: boolean }) {
  return (
    <box flexDirection="column" width={72}>
      <box flexDirection="column">
        <For each={tools}>{(item) => <InlineToolRow item={item} errorExpanded={props.errorExpanded} />}</For>
      </box>
    </box>
  )
}

describe("TUI inline tool wrapping", () => {
  test("snapshots consecutive grep, glob, and read rows at a narrow width", async () => {
    testSetup = await testRender(() => <Fixture />, { width: 72, height: 12 })
    await testSetup.renderOnce()
    await testSetup.renderOnce()

    expect(
      testSetup
        .captureCharFrame()
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
        .trimEnd(),
    ).toMatchSnapshot()
  })

  test("snapshots expanded tool errors under the tool text", async () => {
    testSetup = await testRender(() => <Fixture errorExpanded />, { width: 72, height: 12 })
    await testSetup.renderOnce()
    await testSetup.renderOnce()

    expect(
      testSetup
        .captureCharFrame()
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
        .trimEnd(),
    ).toMatchSnapshot()
  })
})
