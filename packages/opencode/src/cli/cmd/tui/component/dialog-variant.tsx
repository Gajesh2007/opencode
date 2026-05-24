import { createMemo } from "solid-js"
import { useLocal } from "@tui/context/local"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { DialogServiceTier } from "./dialog-service-tier"
import { DialogUpstream } from "./dialog-upstream"

export function DialogVariant() {
  const local = useLocal()
  const dialog = useDialog()

  function next() {
    const tiers = local.model.serviceTier.list()
    const tierCur = local.model.serviceTier.selected()
    const tierNeedsPick = !(tierCur === "default" || (tierCur && tiers.includes(tierCur)))
    if (tiers.length > 0 && tierNeedsPick) {
      dialog.replace(() => <DialogServiceTier />)
      return
    }
    const ups = local.model.upstream.list()
    const upCur = local.model.upstream.selected()
    const upNeedsPick = !(upCur === "default" || (upCur && ups.includes(upCur)))
    if (ups.length > 0 && upNeedsPick) {
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
        onSelect: () => {
          local.model.variant.set(undefined)
          next()
        },
      },
      ...local.model.variant.list().map((variant) => ({
        value: variant,
        title: variant,
        onSelect: () => {
          local.model.variant.set(variant)
          next()
        },
      })),
    ]
  })

  return (
    <DialogSelect<string>
      options={options()}
      title={"Select variant"}
      current={local.model.variant.selected()}
      flat={true}
    />
  )
}
