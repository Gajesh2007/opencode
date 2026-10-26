import { createMemo, createResource } from "solid-js"
import { Schema } from "effect"
import type { JsonValue } from "@opencode/client/promise"
import { Provider } from "@opencode/schema/provider"
import { Model } from "@opencode/schema/model"
import { ForkControl } from "@opencode/schema/fork-control"
import { ModelSelection } from "@opencode/core/model-selection"
import { useData } from "../context/data"
import { useLocation } from "../context/location"
import { useClient } from "../context/client"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

export function DialogSubagentModel(props: { agent?: string; model?: Model.Ref; stage?: "variant" | "tier" }) {
  const data = useData()
  const location = useLocation()
  const client = useClient()
  const dialog = useDialog()
  const toast = useToast()
  const call = (method: string, input: Record<string, JsonValue>) =>
    client.api.rpc.call({
      rpcID: ForkControl.Definition.id,
      method,
      input,
      location: location.ref,
    })
  const [overrides] = createResource(async () =>
    Schema.decodeUnknownSync(Schema.Record(Schema.String, Model.Ref))((await call("subagentModels", {})).output),
  )
  const save = (model?: Model.Ref) => {
    if (!props.agent) return
    const selection = model
      ? Object.fromEntries(
          Object.entries(model).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        )
      : undefined
    void call("setSubagentModel", { agent: props.agent, ...(selection ? { model: selection } : {}) })
      .then(() => dialog.clear())
      .catch((error) => toast.show({ message: errorMessage(error), variant: "error" }))
  }
  const models = () => data.location.model.list(location.ref) ?? []
  const selected = () =>
    models().find((model) => model.id === props.model?.id && model.providerID === props.model.providerID)
  const next = (model: Model.Ref, stage: "variant" | "tier") =>
    dialog.replace(() => <DialogSubagentModel agent={props.agent} model={model} stage={stage} />)
  const options = createMemo(() => {
    if (!props.agent)
      return (data.location.agent.list(location.ref) ?? [])
        .filter((agent) => agent.mode !== "primary" && !agent.hidden)
        .map((agent) => ({
          value: agent.id,
          title: agent.name ?? agent.id,
          description: overrides()?.[agent.id]
            ? [
                overrides()?.[agent.id]?.providerID,
                overrides()?.[agent.id]?.id,
                overrides()?.[agent.id]?.variant,
                overrides()?.[agent.id]?.serviceTier,
              ]
                .filter(Boolean)
                .join(" / ")
            : agent.description,
          onSelect: () => dialog.replace(() => <DialogSubagentModel agent={agent.id} />),
        }))
    if (!props.model)
      return [
        { value: "default", title: "Use configured default", onSelect: () => save() },
        ...models().map((model) => ({
          value: model.providerID + "/" + model.id,
          title: model.name,
          description: model.providerID,
          onSelect: () =>
            next({ providerID: Provider.ID.make(model.providerID), id: Model.ID.make(model.id) }, "variant"),
        })),
      ]
    const model = props.model
    if (props.stage === "variant")
      return ["default", ...(selected()?.variants.map((variant) => variant.id) ?? [])].map((variant) => ({
        value: variant,
        title: variant,
        onSelect: () =>
          next({ ...model, ...(variant === "default" ? {} : { variant: Model.VariantID.make(variant) }) }, "tier"),
      }))
    return ["default", ...Object.keys(ModelSelection.tiers(selected() ?? { modelID: "" }))].map((tier) => ({
      value: tier,
      title: tier,
      onSelect: () => save({ ...model, serviceTier: tier }),
    }))
  })
  return (
    <DialogSelect
      title={
        !props.agent
          ? "Configure subagent model"
          : !props.model
            ? `Model for ${props.agent}`
            : props.stage === "variant"
              ? `Variant for ${props.agent}`
              : `Service tier for ${props.agent}`
      }
      options={options()}
      flat
    />
  )
}
