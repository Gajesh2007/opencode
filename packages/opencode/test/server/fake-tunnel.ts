import fs from "node:fs"
import os from "node:os"
import { PairingState } from "../../src/server/pairing-state"
import { RemoteAccess } from "../../src/server/remote"
import { withTimeout } from "../../src/util/timeout"

export type Run = Parameters<RemoteAccess.Tunnel["run"]>[0]

/**
 * Stands in for `@opencode-ai/tunnel`, which must never load in tests: it would expose this machine to the
 * internet. Install it with `RemoteAccess.setTunnel(fake.tunnel)`. Like the real tunnel, a run stays attached
 * until remote access aborts it; tests drive its events by hand through `run.onEvent`.
 */
export function fakeTunnel(input: { provisioned?: boolean } = {}) {
  const started: Run[] = []
  const slots: PromiseWithResolvers<Run>[] = []
  const slot = (index: number) => (slots[index] ??= Promise.withResolvers<Run>())
  const tunnel: RemoteAccess.Tunnel = {
    hostname: async (route) => (input.provisioned === false ? undefined : `${route}.tunnel.test`),
    run: (run) => {
      slot(started.length).resolve(run)
      started.push(run)
      return new Promise((resolve) => run.signal.addEventListener("abort", () => resolve(), { once: true }))
    },
  }
  return {
    tunnel,
    started,
    /** The `index`th run remote access starts, counting from 0. */
    run: (index = 0) => withTimeout(slot(index).promise, 2_000, `tunnel run ${index} never started`),
  }
}

/**
 * Deletes the pairing file, where remote access saves its route. Bun runs every test file in one process, so
 * suites remove what they created; the test preload keeps the file in a temporary directory.
 */
export function removePairingFile() {
  if (!PairingState.file().startsWith(os.tmpdir())) throw new Error(`refusing to delete ${PairingState.file()}`)
  fs.rmSync(PairingState.file(), { force: true })
}

/** Resolves with the first remote access status, current or upcoming, that matches. */
export function remoteStatus(match: (status: RemoteAccess.Status) => boolean) {
  if (match(RemoteAccess.status())) return Promise.resolve(RemoteAccess.status())
  const next = Promise.withResolvers<RemoteAccess.Status>()
  const unsubscribe = RemoteAccess.subscribe((status) => {
    if (match(status)) next.resolve(status)
  })
  return withTimeout(next.promise, 2_000, "remote access never reached the expected status").finally(unsubscribe)
}
