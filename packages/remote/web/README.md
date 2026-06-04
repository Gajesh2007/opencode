# opencode mobile remote client

This package is a mobile-first, zero-dependency, extremely lightweight web client for driving and interacting with your `opencode` machine over a secure WebSocket relay tunnel.

It is built with plain TypeScript + Vite, featuring safe-area padding for mobile browsers, responsive dual-pane grid layout on desktops, real-time message stream delta rendering, and real-time host connection state monitoring.

---

## Getting Started

### 1. Install Dependencies

Install Vite and TypeScript development dependencies:

```bash
bun install
```

### 2. Run the Local Dev Server

Start Vite's fast dev server:

```bash
bun run dev
```

This will spin up the server on [http://localhost:5173](http://localhost:5173). You can open it in your desktop browser, or scan the QR code/access the local network IP on your phone to use it as a remote client.

### 3. Build for Production

Compile TypeScript and build optimized static assets:

```bash
bun run build
```

The output assets will be generated in `dist/`.

---

## How It Connects

1. **Connect Screen**: Enter your Relay Server WebSocket URL, Room Name, and secret Token (or paste a semicolon-separated connection string: `relay=ws://localhost:8787;room=test-room;token=test-token`).
2. **WebSocket Bridge**: The client opens and keeps open a persistent connection to the public relay.
3. **Tunneling**: Whenever you list sessions or send prompts, they are routed through the custom `tunnelFetch` transport. It translates standard HTTP fetch requests into protocol JSON frames sent over the WebSocket.
4. **SSE Event Stream**: The client initiates a continuous `/event` streaming request over the tunnel to receive server-sent events. As the AI assistant generates replies on the laptop, `message.part.delta` events are streamed back to your phone, rendering the reply character-by-character in real time.
