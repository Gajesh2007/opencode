export type ReqFrame = {
  t: "req"
  id: string
  method: string
  path: string
  headers: Record<string, string>
  body: string | null
}

export type ResHeadFrame = {
  t: "res-head"
  id: string
  status: number
  headers: Record<string, string>
}

export type ResChunkFrame = {
  t: "res-chunk"
  id: string
  data: string // base64 encoded chunks
}

export type ResEndFrame = {
  t: "res-end"
  id: string
}

export type ErrFrame = {
  t: "err"
  id: string
  message: string
}

export type AbortFrame = {
  t: "abort"
  id: string
}

export type PeerFrame = {
  t: "peer"
  role: "host" | "client"
  state: "online" | "offline"
}

export type PingFrame = {
  t: "ping"
}

export type PongFrame = {
  t: "pong"
}

export type Frame =
  | ReqFrame
  | ResHeadFrame
  | ResChunkFrame
  | ResEndFrame
  | ErrFrame
  | AbortFrame
  | PeerFrame
  | PingFrame
  | PongFrame

export function stringToBase64(str: string): string {
  return Buffer.from(str, "utf-8").toString("base64")
}

export function base64ToString(b64: string): string {
  return Buffer.from(b64, "base64").toString("utf-8")
}

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64")
}

export function base64ToBytes(b64: string): Uint8Array {
  return Buffer.from(b64, "base64")
}

export function parseFrame(message: string): Frame {
  return JSON.parse(message) as Frame
}

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame)
}
