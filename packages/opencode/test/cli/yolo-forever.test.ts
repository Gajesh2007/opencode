import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import yargs from "yargs"
import { sanitizedProcessEnv } from "@opencode-ai/core/util/opencode-process"
import { withYoloForever } from "../../src/cli/yolo-forever"
import { AcpCommand } from "../../src/cli/cmd/acp"
import { RunCommand } from "../../src/cli/cmd/run"
import { ServeCommand } from "../../src/cli/cmd/serve"
import { WebCommand } from "../../src/cli/cmd/web"
import { AttachCommand } from "../../src/cli/cmd/tui/attach"
import { TuiThreadCommand } from "../../src/cli/cmd/tui/thread"

const original = process.env.OPENCODE_YOLO_FOREVER

beforeEach(() => {
  delete process.env.OPENCODE_YOLO_FOREVER
})

afterEach(() => {
  if (original === undefined) {
    delete process.env.OPENCODE_YOLO_FOREVER
    return
  }
  process.env.OPENCODE_YOLO_FOREVER = original
})

describe("--yolo-forever", () => {
  for (const command of [AcpCommand, RunCommand, ServeCommand, WebCommand, AttachCommand, TuiThreadCommand]) {
    test(`${command.command} parses the boolean and enables it before command execution`, async () => {
      if (typeof command.builder !== "function") throw new Error("Expected a command builder")
      const parser = await command.builder(yargs(["--yolo-forever"]))
      if (!parser) throw new Error("Expected a parser")
      const args = await parser.exitProcess(false).parseAsync()
      expect(args["yolo-forever"]).toBe(true)
      expect(process.env.OPENCODE_YOLO_FOREVER).toBe("true")
    })
  }

  test("does not enable the mode when absent", async () => {
    await withYoloForever(yargs([])).parseAsync()
    expect(process.env.OPENCODE_YOLO_FOREVER).toBeUndefined()
  })

  test.each(["--yolo-forever=false", "--no-yolo-forever"])("%s overrides the inherited mode", async (flag) => {
    process.env.OPENCODE_YOLO_FOREVER = "true"
    await withYoloForever(yargs([flag])).parseAsync()
    expect(process.env.OPENCODE_YOLO_FOREVER).toBe("false")
  })

  test("preserves the inherited mode when absent", async () => {
    process.env.OPENCODE_YOLO_FOREVER = "true"
    await withYoloForever(yargs([])).parseAsync()
    expect(process.env.OPENCODE_YOLO_FOREVER).toBe("true")
  })

  test.each(["--yolo", "--dangerously-skip-permissions"])("%s remains a weaker mode", async (flag) => {
    if (typeof RunCommand.builder !== "function") throw new Error("Expected a command builder")
    const parser = await RunCommand.builder(yargs([flag]))
    if (!parser) throw new Error("Expected a parser")
    await parser.exitProcess(false).parseAsync()
    expect(process.env.OPENCODE_YOLO_FOREVER).toBeUndefined()
  })

  test("propagates to the sanitized worker environment and child processes", async () => {
    await withYoloForever(yargs(["--yolo-forever"])).parseAsync()
    const env = sanitizedProcessEnv({ OPENCODE_PROCESS_ROLE: "worker" })
    expect(env.OPENCODE_YOLO_FOREVER).toBe("true")
    const child = Bun.spawn([process.execPath, "-e", "process.stdout.write(process.env.OPENCODE_YOLO_FOREVER ?? '')"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await new Response(child.stdout).text()).toBe("true")
    expect(await child.exited).toBe(0)
  })
})
