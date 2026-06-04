# Remote Machine Tunneling feature (`@opencode-ai/remote`)

This package enables driving `opencode` headless servers securely from a remote device (like a phone's web browser) without requiring a VPN or complex NAT traversal/firewall configurations.

## Architecture

The system uses an outbound-only connection model (inspired by OpenAI's rendezvous relays):

```
       [ PHONE (Client) ]                [ LAPTOP (Host) ]
               |                                 |
      Connects outbound (WS)             Connects outbound (WS)
               |                                 |
               +-------------[ RELAY ]-----------+
                            (Public)
                               |
                        Bridges Frames
                               |
                        [ Host Connector ] ---> [ Local Opencode Server ]
                                                  (HTTP/127.0.0.1:4096)
```

1. **Relay Server**: A minimal, fast, public WebSocket bridge. It pairs a client and host in a specific `room` using a shared `token` secret. It is "dumb" and only forwards frames.
2. **Host Connector**: Runs locally next to `opencode serve`. It initiates an outbound connection to the Relay. On incoming HTTP requests, it forwards them to the local `opencode` instance and streams back the responses.
3. **Client**: A web app (browser, mobile) that connects to the same room/token on the Relay to communicate with the host.

---

## Wire Protocol

All frames are sent over the WebSocket connections as JSON text.

### Connection
- **Host**: Connects to `wss://<relay>/host?room=<ROOM>&token=<TOKEN>`
- **Client**: Connects to `wss://<relay>/client?room=<ROOM>&token=<TOKEN>`

### Frame Shapes
1. **client → host** (`req`):
   ```json
   { "t": "req", "id": "req-1", "method": "GET", "path": "/config", "headers": {}, "body": null }
   ```
2. **host → client** (`res-head`):
   ```json
   { "t": "res-head", "id": "req-1", "status": 200, "headers": { "content-type": "application/json" } }
   ```
3. **host → client** (`res-chunk`):
   ```json
   { "t": "res-chunk", "id": "req-1", "data": "eyJrZXkiOiAidmFsdWUifQ==" }
   ```
   *Note: `data` is the base64-encoded representation of the raw response body chunk.*
4. **host → client** (`res-end`):
   ```json
   { "t": "res-end", "id": "req-1" }
   ```
5. **either → either** (`err`):
   ```json
   { "t": "err", "id": "req-1", "message": "Failed to connect to local opencode server" }
   ```
6. **client → host** (`abort`):
   ```json
   { "t": "abort", "id": "req-1" }
   ```
7. **relay → each side** (`peer`):
   ```json
   { "t": "peer", "role": "host", "state": "online" }
   ```

---

## How to Run Locally

First, ensure you are in the workspace root or inside `packages/remote`.

### 1. Start the Relay Server
Starts a local WebSocket relay on port `8787` (default):
```bash
bun run --cwd packages/remote relay
```

### 2. Start the Host Connector
Starts the host connector pointing to the local `opencode` instance and the relay server:
```bash
bun run --cwd packages/remote host
```

### 3. Run E2E Integration / Smoke Tests
Launches an automated end-to-end integration test. It spins up a temporary `opencode serve`, runs the relay and the host connector, connects a protocol client, and verifies request-response routing, SSE chunk streaming, abort signaling, and authentication:
```bash
bun run --cwd packages/remote test:e2e
```

---

## Environment Variables / Configuration

### Relay Server
- `RELAY_PORT` (default: `8787`): The port the relay server listens on.

### Host Connector
- `RELAY_URL` (default: `ws://localhost:8787`): URL of the relay WebSocket server.
- `ROOM` (default: `test-room`): Room name to identify the session.
- `TOKEN` (default: `test-token`): Shared secret token for the room.
- `OPENCODE_URL` (default: `http://127.0.0.1:4096`): URL of the local opencode instance.
- `OPENCODE_PASSWORD` (optional): If configured, used to perform basic authentication against the local `opencode` server.
- `OPENCODE_REMOTE_NO_CAFFEINATE` (optional): Set to `1`, `true`, or `yes` to disable macOS sleep prevention (caffeination).

---

## Caffeination / Keeping the Host Awake

To ensure that your remote tunnel remains reachable, the Host Connector automatically prevents your macOS machine from sleeping when plugged into AC power.

* **Behavior**: On macOS, it spawns a background `caffeinate -s` process for the duration of the host connection. This prevents system sleep *only* while running on AC power. When the host machine is on battery, macOS rules allow it to sleep normally to conserve battery.
* **Closed Lid Caveat**: Keeping the host awake via `caffeinate` is subject to standard macOS clamshell mode rules. If you close your MacBook's lid, the machine will still sleep unless it is plugged into external power **and** connected to an external display.
* **Platform Support**: This feature is macOS-only. On other platforms, the Host Connector operates as normal without attempting to prevent system sleep.
* **Opting Out**: You can disable caffeination entirely using either of the following:
  * Environment variable: `OPENCODE_REMOTE_NO_CAFFEINATE=1` (also accepts `true` or `yes`)
  * CLI flag: `--no-caffeinate`

---

## Quickstart (End-to-End Setup)

Follow this step-by-step guide to connect a remote device (e.g., your phone over cellular) to your local machine using the Remote Tunneling feature.

### 1. Start the opencode Server Locally
Start the headless server in your target project directory. Secure it with a strong password of your choice:
```bash
OPENCODE_SERVER_PASSWORD="your-strong-password" bun run --conditions=browser ./packages/opencode/src/index.ts serve --port 4096
```

### 2. Set Up the Relay Server
The Relay server must be accessible by both your laptop (Host) and your remote device/phone (Client).

* **For Local Testing:**
  Run the relay locally on your machine on port 8787:
  ```bash
  bun run --cwd packages/remote relay
  ```
  This listens on `ws://localhost:8787`.

* **For Public Deployment (so cellular phones can connect):**
  The relay must be hosted publicly with **`wss://`** (WebSocket Secure) enabled in production.
  
  **Option A: Virtual Private Server (VPS) + Caddy (Reverse Proxy)**
  1. Install Bun and run the relay on your VPS (e.g. listening on port `8787`):
     ```bash
     RELAY_PORT=8787 bun run packages/remote/src/relay.ts
     ```
  2. Configure Caddy to handle automatic HTTPS/WSS certificates and proxy to the relay (add this to your `/etc/caddy/Caddyfile`):
     ```caddy
     relay.yourdomain.com {
         reverse_proxy localhost:8787
     }
     ```
     This secures your connection so that clients can connect to `wss://relay.yourdomain.com`.

  **Option B: Fly.io Deployment**
  Fly.io automatically handles SSL/TLS termination for standard TCP/HTTP deployments. Create a `fly.toml` for the relay pointing to port `8787` and deploy with `fly deploy`. Clients can then access it at `wss://<your-app>.fly.dev`.

### 3. Run the Host Connector
With a public relay running, connect your local host connector to register your laptop to the chosen room. Ensure you provide the public relay URL, a strong token, your chosen room, and the `OPENCODE_PASSWORD` corresponding to your local server password:
```bash
RELAY_URL="wss://relay.yourdomain.com" \
ROOM="my-secure-room-name" \
TOKEN="my-high-entropy-secret-token" \
OPENCODE_PASSWORD="your-strong-password" \
bun run --cwd packages/remote host
```

### 4. Connect with the Web Client
The web client can be run locally for development or deployed as a static site anywhere (e.g., Netlify, Vercel, or hosted directly on your relay/VPS).

* **Run Dev Web Client:**
  ```bash
  bun run --cwd packages/remote/web dev
  ```
  Open `http://localhost:5173` on your browser.
* **Build Static Web Client:**
  ```bash
  bun run --cwd packages/remote/web build
  ```
  This creates a highly-optimized static bundle in `packages/remote/web/dist/` that can be served anywhere.

**Step-by-Step Connection:**
1. Open the web client on your device.
2. Enter the Relay URL (e.g., `wss://relay.yourdomain.com`), your chosen **Room**, your secret **Token**, and optionally your target **Working Directory** on the host.
3. Click **Connect**. Your host presence status will show as online, and you are ready to query opencode!

---

## Deployment & Production Hosting

### Security Guidelines
* **Use WSS (WebSocket Secure):** Always use `wss://` instead of `ws://` in production to secure transit frames from eavesdropping.
* **High-Entropy Secrets:** Use a high-entropy secret token (e.g., generated via `openssl rand -hex 32`) to prevent unauthorized users from brute-forcing your room.
* **Blind Bridge:** The Relay operates as a "dumb" blind bridge. It does not parse or inspect any frames or request/response bodies, protecting data integrity.
* **Local Authentication:** Even if someone discovers your room and token, opencode's built-in Basic authentication still applies. They cannot issue instructions unless they also know your `OPENCODE_PASSWORD`.

---

## Keeping the host awake (caffeination)

To ensure the remote tunnel remains reachable when your Mac is left unattended, the host connector automatically runs macOS `caffeinate -s` to keep the machine awake.

### Behavior
- **AC Power Only:** Uses the `-s` flag which prevents system sleep **only** when the machine is connected to AC power. When on battery, macOS is allowed to sleep normally to conserve energy.
- **Platform-specific:** This behavior is only active on macOS and is a safe no-op on other operating systems.
- **Opting Out:** You can disable caffeination entirely by passing the `--no-caffeinate` command line flag or setting the environment variable `OPENCODE_REMOTE_NO_CAFFEINATE=1` (or `"yes"`/`"true"`).
- **Lid Sleep Caveat (Clamshell Mode):** Note that closing your MacBook's lid will still allow the system to sleep per standard macOS rules, unless the laptop is connected to an external display and a power source. Caffeinate does not bypass lid-close sleep.
