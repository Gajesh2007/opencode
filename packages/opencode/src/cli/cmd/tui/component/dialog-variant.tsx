import { createMemo } from "solid-js"
import { useLocal } from "@tui/context/local"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { DialogServiceTier } from "./dialog-service-tier"

export function DialogVariant() {
  const local = useLocal()
  const dialog = useDialog()

  function next() {
    const tiers = local.model.serviceTier.list()
    const cur = local.model.serviceTier.selected()
    const needsPick = !(cur === "default" || (cur && tiers.includes(cur)))
    if (tiers.length > 0 && needsPick) {
      dialog.replace(() => <DialogServiceTier />)
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
