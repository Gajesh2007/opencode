import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import appPlugin from "@opencode-ai/app/vite"

// Serve favicons, fonts and the theme-preload script straight out of the
// existing packages/app/public directory so the embedded UI looks identical.
const appPublic = fileURLToPath(new URL("../../app/public", import.meta.url))

export default defineConfig({
  // appPlugin sets the `@` alias to packages/app/src and wires up tailwind,
  // solid and the inlined theme-preload script — the same setup the desktop
  // renderer uses to embed the app as a library.
  plugins: [appPlugin] as any,
  publicDir: appPublic,
  server: {
    host: "0.0.0.0",
    port: 5174,
  },
  build: {
    target: "esnext",
    sourcemap: false,
  },
})
