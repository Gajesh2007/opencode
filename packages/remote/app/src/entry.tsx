// @refresh reload
import "@opencode-ai/app/index.css"
import { AppBaseProviders, AppInterface, PlatformProvider } from "@opencode-ai/app"
import { HashRouter } from "@solidjs/router"
import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import { ConnectGate } from "./connect"
import { platform, tunnelServer, tunnelServerKey } from "./platform"
import { installTunnelWebSocketGuard } from "./websocket-stub"

// Stop the PTY terminal's raw WebSocket (the only path that bypasses
// platform.fetch) from attempting a real connection to the dummy tunnel host.
installTunnelWebSocketGuard()

function Root() {
  const [connected, setConnected] = createSignal(false)

  return (
    <Show when={connected()} fallback={<ConnectGate onConnected={() => setConnected(true)} />}>
      <PlatformProvider value={platform}>
        <AppBaseProviders>
          {/* HashRouter avoids any server-side SPA rewrite; the single seeded
              "http://tunnel" server skips the multi-server add flow and routes
              every request through the relay tunnel via platform.fetch. */}
          <AppInterface
            defaultServer={tunnelServerKey}
            servers={[tunnelServer]}
            router={HashRouter}
            disableHealthCheck
          />
        </AppBaseProviders>
      </PlatformProvider>
    </Show>
  )
}

const root = document.getElementById("root")
if (root instanceof HTMLElement) render(() => <Root />, root)
