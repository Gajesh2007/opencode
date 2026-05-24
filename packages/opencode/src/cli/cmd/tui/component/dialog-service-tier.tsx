import { createMemo } from "solid-js"
import { useLocal } from "@tui/context/local"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { DialogUpstream } from "./dialog-upstream"

const TIER_DESCRIPTIONS: Record<string, string> = {
  fast: "Anthropic fast mode — up to 2.5x output TPS on Opus 4.6/4.7. ~6x standard price. Beta.",
  priority: "Higher availability + faster processing. Premium price.",
  flex: "Cheaper processing, higher latency, occasional capacity errors.",
  throughput: "Route to the provider with the highest tokens/sec (median).",
  latency: "Route to the provider with the lowest time-to-first-token (median).",
  cheapest: "Route to the lowest-cost provider.",
}

export function DialogServiceTier() {
  const local = useLocal()
  const dialog = useDialog()

  function next() {
    const ups = local.model.upstream.list()
    const cur = local.model.upstream.selected()
    const needsPick = !(cur === "default" || (cur && ups.includes(cur)))
    if (ups.length > 0 && needsPick) {
      dialog.replace(() => <DialogUpstream />)
      return
    }
    dialog.clear()
  }

  const options = createMemo(() => {
    return [
      {
        value: "default",
        title: "Default",
        description: "Standard tier. No routing or priority overrides.",
        onSelect: () => {
          local.model.serviceTier.set(undefined)
          next()
        },
      },
      ...local.model.serviceTier.list().map((tier) => ({
        value: tier,
        title: tier,
        description: TIER_DESCRIPTIONS[tier],
        onSelect: () => {
          local.model.serviceTier.set(tier)
          next()
        },
      })),
    ]
  })

  return (
    <DialogSelect<string>
      options={options()}
      title={"Select service tier"}
      current={local.model.serviceTier.selected()}
      flat={true}
    />
  )
}
