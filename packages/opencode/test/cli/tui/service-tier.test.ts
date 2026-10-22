import { expect, test } from "bun:test"
import { serviceTier } from "@/cli/cmd/tui/util/service-tier"

test("older messages have no service tier label", () => {
  expect(serviceTier({})).toEqual({ text: undefined, downgraded: false })
})

test("only a provider-confirmed tier is labeled served", () => {
  expect(serviceTier({ service_tier_requested: "ultrafast" })).toEqual({
    text: "ultrafast requested, served unknown",
    downgraded: false,
  })
  expect(serviceTier({ service_tier: "default" })).toEqual({ text: "default (served)", downgraded: false })
  expect(serviceTier({ service_tier_requested: "ultrafast", service_tier: "ultrafast" })).toEqual({
    text: "ultrafast (served)",
    downgraded: false,
  })
})

test("premium to default is flagged but auto routing is not a downgrade", () => {
  expect(serviceTier({ service_tier_requested: "ultrafast", service_tier: "default" })).toEqual({
    text: "ultrafast -> default (downgraded)",
    downgraded: true,
  })
  expect(serviceTier({ service_tier_requested: "auto", service_tier: "default" })).toEqual({
    text: "auto -> default (served)",
    downgraded: false,
  })
})
