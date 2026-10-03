import { parse } from "partial-json"
import { isRecord } from "@/util/record"

// Preview incomplete arguments only; execution always uses the final parsed input.
export function parseToolInput(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  try {
    const input: unknown = parse(raw)
    return isRecord(input) ? input : {}
  } catch {
    return {}
  }
}

export function parseFileToolInput(raw: string) {
  // File previews render before the tool schema validates argument types.
  return Object.fromEntries(
    Object.entries(parseToolInput(raw)).filter(([key, value]) =>
      key === "replaceAll"
        ? typeof value === "boolean"
        : ["filePath", "content", "oldString", "newString", "patchText"].includes(key) && typeof value === "string",
    ),
  )
}
