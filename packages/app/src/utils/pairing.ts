import { Option, Schema } from "effect"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { normalizeServerUrl } from "@/context/server"
import { createSdkForServer } from "@/utils/server"
import { checkServerHealth, timeoutSignal } from "@/utils/server-health"

export type PairingLink = { urls: ReadonlyArray<string>; code: string }

/** A server address and the session token its pairing code was exchanged for, ready to store as a connection. */
export type Pairing = { url: string; username: string; password: string }

export type Redeemed = { type: "paired"; pairing: Pairing } | { type: "expired" } | { type: "unreachable" }

export type Redemption = { pairing: Pairing } | { error: string }

/** Redeems a pasted or scanned pairing link; resolves undefined when the value is not a pairing link at all. */
export type RedeemPairing = (value: string) => Promise<Redemption | undefined>

// Session tokens are passwords for the server's default Basic auth account.
const PAIRING_USERNAME = "opencode"
const UNAUTHORIZED = 401
const CODE = /^[A-Za-z0-9_-]+$/

const decodePayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ code: Schema.String, urls: Schema.Array(Schema.String) })),
)

export function serverAddress(value: string) {
  if (value.includes("://") && !/^https?:\/\//.test(value.trim())) return
  const normalized = normalizeServerUrl(value)
  const url = normalized ? parseUrl(normalized) : undefined
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return
  if (url.username || url.password || url.search || url.hash) return
  return normalized
}

// `opencode pair` prints links carrying a single-use code that the server exchanges for a session token.
// Its QR code carries the same code with every reachable server address as {"code","urls"} JSON.
export function pairingLink(value: string): PairingLink | undefined {
  const trimmed = value.trim()

  if (trimmed.startsWith("{")) {
    const payload = Option.getOrUndefined(decodePayload(trimmed))
    if (!payload || !CODE.test(payload.code)) return
    const urls = payload.urls.map(serverAddress)
    if (urls.length === 0 || urls.some((url) => url === undefined)) return
    return { urls: [...new Set(urls.filter((url) => url !== undefined))], code: payload.code }
  }

  const url = parseUrl(trimmed)
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return
  const code = /^\/auth\/connect\/([^/]+)$/.exec(url.pathname)?.[1]
  const address = serverAddress(url.origin)
  if (!code || !CODE.test(code) || !address) return
  return { urls: [address], code }
}

// Browsers block plain HTTP requests from HTTPS pages, except to loopback addresses, which Secure Contexts treats as
// potentially trustworthy.
export function isMixedContent(page: string, address: string) {
  if (parseUrl(page)?.protocol !== "https:") return false
  const normalized = serverAddress(address)
  const url = normalized ? parseUrl(normalized) : undefined
  if (url?.protocol !== "http:") return false
  const host = url.hostname.replace(/\.$/, "")
  return !(host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(?:\.\d+){3}$/.test(host))
}

// Every address may reach the same server, but the code is single-use, so at most one attempt succeeds.
export function redeemPairingLink(link: PairingLink, fetch: typeof globalThis.fetch): Promise<Redeemed> {
  const attempts = link.urls.map((url) => {
    const timeout = timeoutSignal(5_000)
    return createSdkForServer({ server: { url }, fetch, signal: timeout.signal })
      .server.connect({ code: link.code })
      .finally(() => timeout.clear?.())
      .then((result) =>
        // Rejecting with the status tells a server that refused the code apart from one that never answered.
        result.data?.token
          ? { url, username: PAIRING_USERNAME, password: result.data.token }
          : Promise.reject(result.response?.status),
      )
  })

  // Whether the first address answered at all: a 401 there means another address spent the code first.
  const first = attempts[0]?.then(
    () => true,
    (status) => status === UNAUTHORIZED,
  )

  return Promise.any(attempts)
    .then((pairing) => preferFirst(link.urls, pairing, first, fetch))
    .then(
      (pairing): Redeemed => ({ type: "paired", pairing }),
      // Only a server's answer proves the code is spent; addresses that could not be reached leave it valid.
      (error): Redeemed =>
        error instanceof AggregateError && error.errors.includes(UNAUTHORIZED)
          ? { type: "expired" }
          : { type: "unreachable" },
    )
}

// The code is spent once redeemed, so a retry after a failed connection check reuses the token it returned.
export function createPairingRedeemer(fetch: typeof globalThis.fetch) {
  const redeemed = new Map<string, Pairing>()

  return async (link: PairingLink): Promise<Redeemed> => {
    const known = redeemed.get(link.code)
    if (known) {
      // An address the user edited since wins: the token works on every address of the server.
      const url = link.urls.includes(known.url) ? known.url : (link.urls[0] ?? known.url)
      return { type: "paired", pairing: { ...known, url } }
    }
    const result = await redeemPairingLink(link, fetch)
    if (result.type === "paired") redeemed.set(link.code, result.pairing)
    return result
  }
}

// Pasted and scanned links share one redeem path so every surface explains a failure the same way.
export function useRedeemPairing(): RedeemPairing {
  const language = useLanguage()
  const platform = usePlatform()
  const redeem = createPairingRedeemer(platform.fetch ?? globalThis.fetch)

  return async (value) => {
    const link = pairingLink(value)
    if (!link) return
    const result = await redeem(link)
    if (result.type === "paired") return { pairing: result.pairing }
    if (result.type === "expired") return { error: language.t("server.connect.link.expired") }
    // A QR code can carry several addresses; an HTTPS page can reach none of them only when every one is plain HTTP.
    if (platform.platform === "web" && link.urls.every((url) => isMixedContent(location.href, url)))
      return { error: language.t("server.connect.mixedContent") }
    return { error: language.t("server.connect.link.unreachable", { url: link.urls.join(", ") }) }
  }
}

// The token works on every address of the server, so keep the first one when it answers, even if another address
// answered sooner: `opencode pair` lists an advertised address first, and a local network address stops working away
// from that network. An address that has not answered within a second is not waited for.
async function preferFirst(
  urls: ReadonlyArray<string>,
  pairing: Pairing,
  answered: Promise<boolean> | undefined,
  fetch: typeof globalThis.fetch,
) {
  const first = urls[0]
  if (!first || first === pairing.url || !answered) return pairing
  const reachable = await Promise.race([
    answered,
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
  ])
  if (!reachable) return pairing
  const http = { ...pairing, url: first }
  const health = await checkServerHealth(http, fetch, { timeoutMs: 5_000, retryCount: 0 })
  return health.healthy ? http : pairing
}

// URL.parse and URL.canParse are missing from older browsers this app still supports.
function parseUrl(value: string) {
  try {
    return new URL(value)
  } catch {
    return
  }
}
