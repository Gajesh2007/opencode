import { createMemo } from "solid-js"
import { ModelSelection } from "@opencode/core/model-selection"
import { useLocal } from "../context/local"
import { useData } from "../context/data"
import { useLocation } from "../context/location"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useDialog } from "../ui/dialog"

export function DialogModelRouting(props: { kind: "serviceTier" | "upstream" | "reasoningMode" }) {
  const local = useLocal()
  const data = useData()
  const location = useLocation()
  const dialog = useDialog()
  const selection = () => (props.kind === "upstream" ? local.model.upstream : local.model.serviceTier)
  const options = createMemo(() => {
    const selected = local.model.selection()
    const model = data.location.model
      .list(location.ref)
      ?.find((item) => item.id === selected?.modelID && item.providerID === selected.providerID)
    return ["default", ...(model ? Object.keys(ModelSelection.tiers(model)) : [])].map((value) => ({
      value,
      title: value === "default" ? "Default" : value,
      onSelect: () => {
        selection().set(value)
        dialog.clear()
      },
    }))
  })
  if (props.kind === "reasoningMode")
    return (
      <DialogSelect<"standard" | "pro">
        title="Select reasoning mode"
        options={(["standard", "pro"] as const).map((value) => ({
          value,
          title: value === "pro" ? "Pro" : "Standard",
          onSelect: () => {
            local.model.reasoningMode.set(value)
            dialog.clear()
          },
        }))}
        current={local.model.reasoningMode.current()}
        flat
      />
    )
  if (props.kind === "upstream")
    return (
      <DialogPrompt
        title="Pin upstream provider"
        subtitle="Gateway or OpenRouter provider slug; use default to clear the pin."
        value={selection().current() ?? "default"}
        onConfirm={(value) => {
          selection().set(value.trim() || "default")
          dialog.clear()
        }}
      />
    )
  return (
    <DialogSelect<string>
      title="Select service tier"
      options={options()}
      current={selection().current() ?? "default"}
      flat
    />
  )
}
