import { EOL } from "os"
import { cancel, confirm, log } from "@clack/prompts"
import { PairingState } from "@/server/pairing-state"

// Shared with the TUI's /pair dialog, so every client explains remote access the same way.
export const remoteWarningLines = [
  "This will expose your OpenCode server to the internet.",
  "Traffic is end-to-end encrypted, and access requires your server password.",
]

export const remoteConfirmMessage = "Expose your server to the internet?"

/** The command turning remote access on; the warning tells the user how to run it locally instead. */
export type RemoteCommand = "pair" | "serve" | "web"

export function remoteWarning(command: RemoteCommand = "pair") {
  return [
    ...remoteWarningLines,
    `To ${local(command)} instead, run \`opencode ${command}\` without the --remote flag.`,
  ].join(EOL)
}

export interface RemoteConsentPrompt {
  readonly interactive: () => boolean
  /** Resolves to a symbol when the user cancels, like clack's prompts. */
  readonly confirm: () => Promise<boolean | symbol>
}

const terminalPrompt: RemoteConsentPrompt = {
  interactive: () => process.stdin.isTTY && process.stdout.isTTY,
  confirm: () => confirm({ message: remoteConfirmMessage, initialValue: true }),
}

// Remote access is only explained and accepted the first time it is turned on; once accepted, later runs go
// straight through. Returns whether remote access may be enabled; on refusal it sets the exit code.
export async function remoteConsent(
  input: { readonly yes: boolean; readonly command?: RemoteCommand },
  prompt: RemoteConsentPrompt = terminalPrompt,
) {
  if (PairingState.read().remoteAccepted === true) return true
  const command = input.command ?? "pair"
  if (!input.yes && !prompt.interactive()) {
    process.stderr.write([remoteWarning(command), "Run interactively or pass --yes to continue."].join(EOL) + EOL)
    process.exitCode = 1
    return false
  }
  log.warn(remoteWarning(command))
  if (!input.yes) {
    const accepted = await prompt.confirm()
    if (typeof accepted === "symbol") {
      cancel(declined(command))
      process.exitCode = 130
      return false
    }
    if (!accepted) {
      log.info(declined(command))
      return false
    }
  }
  PairingState.acceptRemote()
  return true
}

function local(command: RemoteCommand) {
  return command === "pair" ? "pair locally" : "serve locally"
}

function declined(command: RemoteCommand) {
  return `Remote access was not enabled. To ${local(command)}, run \`opencode ${command}\`.`
}
