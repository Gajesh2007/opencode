import { Button } from "@opencode-ai/ui/button"
import { makeEventListener } from "@solid-primitives/event-listener"
import QrScanner from "qr-scanner"
import { onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { pairingLink, type RedeemPairing } from "@/utils/pairing"

// Redeems with the form's own redeem, so the form keeps the token and a failed connection check retries without the
// spent code; the form gets back a link it can show, and submits it.
export function PairingScanner(props: { redeem: RedeemPairing; onScan: (link: string) => void; onCancel: () => void }) {
  const language = useLanguage()
  const [state, setState] = createStore({ error: "", ready: false, redeeming: false })
  const video = document.createElement("video")
  video.setAttribute("aria-label", language.t("server.connect.camera"))
  video.setAttribute("playsinline", "")
  video.muted = true
  video.className = "size-full object-cover"

  onMount(() => {
    // A code that failed usually stays in view, so skip it for a few seconds instead of redeeming it on every frame.
    // It is tried again afterwards: a code the server could not be reached for still works once the network is back.
    const rejected = new Map<string, number>()
    const scan = { disposed: false }

    // QrScanner hides detached videos, so initialize only after this preview is mounted.
    const scanner = new QrScanner(
      video,
      (result) => {
        if (state.redeeming || Date.now() < (rejected.get(result.data) ?? 0)) return
        setState({ redeeming: true, error: "" })
        void props.redeem(result.data).then((redeemed) => {
          if (scan.disposed) return
          setState("redeeming", false)

          if (redeemed && "pairing" in redeemed) {
            scanner.stop()
            // A QR code carries {"code","urls"} JSON; the form shows the link for the address that paired instead.
            const code = pairingLink(result.data)?.code
            props.onScan(code ? new URL(`/auth/connect/${code}`, redeemed.pairing.url).href : result.data)
            return
          }

          rejected.set(result.data, Date.now() + 3000)
          setState("error", redeemed?.error ?? language.t("server.connect.scan.invalid"))
        })
      },
      {
        preferredCamera: "environment",
        maxScansPerSecond: 10,
        returnDetailedScanResult: true,
        // QrScanner only logs a decoder that fails (for example, a worker the page's CSP does not allow), so the
        // preview would look like it is still scanning.
        onDecodeError: (error) => {
          // The native BarcodeDetector engine reports an empty frame as "Scanner error: No QR code found".
          if (String(error).includes(QrScanner.NO_QR_CODE_FOUND) || state.redeeming) return
          setState("error", language.t("server.connect.scan.failed"))
        },
      },
    )

    // Browsers without BarcodeDetector decode in a blob: worker, which a CSP like the opencode server's forbids.
    // QrScanner only notices after a 10 second timeout, so explain it, and release the camera, once it is blocked.
    makeEventListener(document, "securitypolicyviolation", (event) => {
      if (event.effectiveDirective !== "worker-src") return
      scanner.stop()
      setState("error", language.t("server.connect.scan.failed"))
    })

    // Terminal QR codes can be light-on-dark depending on the terminal theme.
    scanner.setInversionMode("both")
    onCleanup(() => {
      scan.disposed = true
      scanner.destroy()
    })
    void scanner.start().then(
      () => setState("ready", true),
      () => setState("error", language.t("server.connect.camera.error")),
    )
  })

  return (
    <section class="bg-surface-base rounded-md p-5 flex flex-col gap-3" aria-label={language.t("server.connect.scan")}>
      <p class="text-14-regular text-text-weak">{language.t("server.connect.scan.description")}</p>
      <div class="relative w-full max-w-64 aspect-square self-center overflow-hidden rounded-md bg-background-stronger">
        {video}
        <Show when={(!state.ready && !state.error) || state.redeeming}>
          <span
            role="status"
            class="absolute inset-0 grid place-items-center text-14-regular text-text-strong"
            classList={{ "bg-background-base/70": state.redeeming }}
          >
            {language.t(state.redeeming ? "dialog.server.add.checking" : "server.connect.camera.starting")}
          </span>
        </Show>
      </div>
      <Show when={state.error}>
        <p class="text-12-medium text-text-on-critical-base" role="alert">
          {state.error}
        </p>
      </Show>
      <Button variant="secondary" size="large" class="px-3 py-1.5 self-start" onClick={props.onCancel}>
        {language.t("common.cancel")}
      </Button>
    </section>
  )
}
