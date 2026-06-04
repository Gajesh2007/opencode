let child: ReturnType<typeof Bun.spawn> | null = null

export function startCaffeination() {
  const isOptedOut =
    process.argv.includes("--no-caffeinate") ||
    ["1", "true", "yes"].includes(String(process.env.OPENCODE_REMOTE_NO_CAFFEINATE).toLowerCase())

  if (isOptedOut) {
    console.log("[Host] Caffeination disabled (machine may sleep normally)")
    return
  }

  if (process.platform !== "darwin") {
    console.log("[Host] Caffeination skipped (macOS only)")
    return
  }

  if (child) {
    return
  }

  try {
    // macOS `caffeinate -s` keeps the system awake only while on AC power.
    // -i (idle) would keep it awake on battery power too, violating the AC-power-only requirement.
    // `-w <pid>` makes caffeinate exit automatically when the host process exits, even on a
    // hard crash or SIGKILL where stopCaffeination()/exit handlers never run. Without this,
    // the child is reparented to init and leaks, keeping the Mac awake indefinitely.
    child = Bun.spawn(["caffeinate", "-s", "-w", String(process.pid)], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    console.log("[Host] Caffeination on (machine stays awake while on AC power)")
  } catch (error) {
    console.warn(`[Host] Caffeination unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function stopCaffeination() {
  if (child) {
    child.kill()
    child = null
    console.log("[Host] Caffeination stopped")
  }
}
