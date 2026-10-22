import { chmod, copyFile, mkdir, open } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const directory = path.join(os.homedir(), ".local/share/opencode/phone")
const settingsPath = path.join(directory, "access.json")
const label = "ai.opencode.phone"

type Settings = {
  binary: string
  database: string
  password: string
  environment: Record<string, string>
}

if (process.argv.includes("--run")) {
  const settings: Settings = await Bun.file(settingsPath).json()
  const server = Bun.spawn([settings.binary, "serve", "--hostname", "127.0.0.1", "--port", "4096"], {
    cwd: os.homedir(),
    env: {
      ...process.env,
      ...settings.environment,
      OPENCODE_DB: settings.database,
      OPENCODE_SERVER_USERNAME: "opencode",
      OPENCODE_SERVER_PASSWORD: settings.password,
      OPENCODE_EXPERIMENTAL_WORKFLOW: "false",
      OPENCODE_EXPERIMENTAL_METAAGENT: "false",
    },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  })
  process.on("SIGTERM", () => server.kill("SIGTERM"))
  process.on("SIGINT", () => server.kill("SIGINT"))
  process.exit(await server.exited)
}

if (process.platform !== "darwin") throw new Error("This installer is for the local macOS phone server")
const binary = process.argv[2]
const database = process.argv[3]
if (!binary || !database || !path.isAbsolute(binary) || !path.isAbsolute(database)) {
  throw new Error("Usage: bun install-phone-access.ts /absolute/opencode /absolute/existing-chat.db")
}
if (!(await Bun.file(binary).exists()) || !(await Bun.file(database).exists())) {
  throw new Error("The built binary and existing chat database must both exist")
}
const uid = process.getuid?.()
if (uid === undefined) throw new Error("A macOS user session is required")
const domain = `gui/${uid}`
const existing = Bun.spawnSync(["launchctl", "print", `${domain}/${label}`], { stdout: "ignore", stderr: "ignore" })
if (existing.exitCode === 0) throw new Error("Phone service already exists; it was not replaced or restarted")

await mkdir(directory, { recursive: true, mode: 0o700 })
await chmod(directory, 0o700)
const installedBinary = path.join(directory, "opencode")
await copyFile(binary, installedBinary)
await chmod(installedBinary, 0o700)
const runner = path.join(directory, "run.ts")
await copyFile(import.meta.path, runner)
await chmod(runner, 0o600)

const environment = Object.fromEntries(
  [
    "PATH",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_CONFIG_DIR",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
  ].flatMap((key) => {
    const value = process.env[key]
    return value === undefined ? [] : [[key, value]]
  }),
)
const settings: Settings = {
  binary: installedBinary,
  database,
  password: Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url"),
  environment,
}
const credentials = await open(settingsPath, "wx", 0o600)
await credentials.writeFile(JSON.stringify(settings, null, 2))
await credentials.close()
for (const file of ["stdout.log", "stderr.log"]) {
  const handle = await open(path.join(directory, file), "a", 0o600)
  await handle.close()
}

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!)
const plist = path.join(os.homedir(), "Library/LaunchAgents", `${label}.plist`)
const file = await open(plist, "wx", 0o600)
await file.writeFile(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${escape(process.execPath)}</string><string>${escape(runner)}</string><string>--run</string></array>
<key>WorkingDirectory</key><string>${escape(os.homedir())}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${escape(path.join(directory, "stdout.log"))}</string>
<key>StandardErrorPath</key><string>${escape(path.join(directory, "stderr.log"))}</string>
</dict></plist>
`)
await file.close()
const install = Bun.spawnSync(["launchctl", "bootstrap", domain, plist], { stdout: "pipe", stderr: "pipe" })
if (install.exitCode !== 0) throw new Error(`launchctl bootstrap failed: ${install.stderr.toString()}`)
console.log(`Phone server installed on 127.0.0.1:4096; login username: opencode`)
console.log(`Private credentials: ${settingsPath}`)
