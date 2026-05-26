import { createMemo, createSignal } from "solid-js"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import { map, pipe, flatMap, entries, filter, sortBy } from "remeda"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import * as fuzzysort from "fuzzysort"
import { useConnected } from "./use-connected"

const TIER_DESCRIPTIONS: Record<string, string> = {
  fast: "Up to 2.5x output TPS. ~6x standard price. Beta.",
  priority: "Higher availability + faster processing. Premium price.",
  flex: "Cheaper processing, higher latency.",
  throughput: "Route to highest tokens/sec provider.",
  latency: "Route to lowest time-to-first-token provider.",
  cheapest: "Route to lowest-cost provider.",
}

export function DialogSubagentModel() {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()

  const subagents = createMemo(() =>
    sync.data.agent.filter((x) => x.mode !== "primary" && !x.hidden),
  )

  const options = createMemo(() =>
    subagents().map((agent) => {
      const override = local.subagentModel.get(agent.name)
      const parts: string[] = []
      if (override) {
        parts.push(`${override.providerID}/${override.modelID}`)
        if (override.variant) parts.push(override.variant)
        if (override.serviceTier) parts.push(override.serviceTier)
      }
      const overrideLabel = parts.length ? parts.join(" / ") : undefined
      return {
        value: agent.name,
        title: agent.name,
        description: overrideLabel ?? (agent.description ? agent.description.slice(0, 60) : undefined),
        footer: overrideLabel ? "overridden" : undefined,
        onSelect() {
          dialog.replace(() => <DialogSubagentModelPicker agentName={agent.name} />)
        },
      }
    }),
  )

  return (
    <DialogSelect
      title="Configure subagent model"
      options={options()}
      actions={[
        {
          command: "subagent.model.clear",
          title: "Clear override",
          onTrigger(option) {
            void local.subagentModel.clear(option.value)
          },
        },
      ]}
    />
  )
}

function DialogSubagentModelPicker(props: { agentName: string }) {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const [query, setQuery] = createSignal("")
  const connected = useConnected()

  const currentOverride = createMemo(() => local.subagentModel.get(props.agentName))

  const options = createMemo(() => {
    const needle = query().trim()

    const providerOptions = pipe(
      sync.data.provider,
      sortBy(
        (provider) => provider.id !== "opencode",
        (provider) => provider.name,
      ),
      flatMap((provider) =>
        pipe(
          provider.models,
          entries(),
          filter(([_, info]) => info.status !== "deprecated"),
          map(([model, info]) => ({
            value: { providerID: provider.id, modelID: model },
            title: info.name ?? model,
            category: connected() ? provider.name : undefined,
            disabled: provider.id === "opencode" && model.includes("-nano"),
            footer:
              info.cost?.input === 0 && provider.id === "opencode" ? "Free" : undefined,
            onSelect() {
              const variants = info.variants ? Object.keys(info.variants) : []
              const tiers = info.serviceTiers ? Object.keys(info.serviceTiers) : []
              if (variants.length > 0) {
                dialog.replace(() => (
                  <DialogSubagentVariant
                    agentName={props.agentName}
                    providerID={provider.id}
                    modelID={model}
                    variants={variants}
                    tiers={tiers}
                  />
                ))
                return
              }
              if (tiers.length > 0) {
                dialog.replace(() => (
                  <DialogSubagentTier
                    agentName={props.agentName}
                    providerID={provider.id}
                    modelID={model}
                    tiers={tiers}
                  />
                ))
                return
              }
              void local.subagentModel.set(props.agentName, {
                providerID: provider.id,
                modelID: model,
              })
              dialog.clear()
            },
          })),
          sortBy(
            (x) => x.footer !== "Free",
            (x) => x.title,
          ),
        ),
      ),
    )

    if (needle) {
      return fuzzysort
        .go(needle, providerOptions, { keys: ["title", "category"] })
        .map((x) => x.obj)
    }

    return providerOptions
  })

  return (
    <DialogSelect<ReturnType<typeof options>[number]["value"]>
      options={options()}
      onFilter={setQuery}
      flat={true}
      skipFilter={true}
      title={`Select model for @${props.agentName}`}
      current={currentOverride()}
    />
  )
}

function DialogSubagentVariant(props: {
  agentName: string
  providerID: string
  modelID: string
  variants: string[]
  tiers: string[]
}) {
  const local = useLocal()
  const dialog = useDialog()

  function finish(variant?: string) {
    if (props.tiers.length > 0) {
      dialog.replace(() => (
        <DialogSubagentTier
          agentName={props.agentName}
          providerID={props.providerID}
          modelID={props.modelID}
          tiers={props.tiers}
          variant={variant}
        />
      ))
      return
    }
    void local.subagentModel.set(props.agentName, {
      providerID: props.providerID,
      modelID: props.modelID,
      variant,
    })
    dialog.clear()
  }

  const options = createMemo(() => [
    {
      value: "default",
      title: "Default",
      onSelect: () => finish(undefined),
    },
    ...props.variants.map((v) => ({
      value: v,
      title: v,
      onSelect: () => finish(v),
    })),
  ])

  return (
    <DialogSelect<string>
      options={options()}
      title={`Select variant for @${props.agentName}`}
      flat={true}
    />
  )
}

function DialogSubagentTier(props: {
  agentName: string
  providerID: string
  modelID: string
  tiers: string[]
  variant?: string
}) {
  const local = useLocal()
  const dialog = useDialog()

  const options = createMemo(() => [
    {
      value: "default",
      title: "Default",
      description: "Standard tier.",
      onSelect: () => {
        void local.subagentModel.set(props.agentName, {
          providerID: props.providerID,
          modelID: props.modelID,
          variant: props.variant,
        })
        dialog.clear()
      },
    },
    ...props.tiers.map((tier) => ({
      value: tier,
      title: tier,
      description: TIER_DESCRIPTIONS[tier],
      onSelect: () => {
        void local.subagentModel.set(props.agentName, {
          providerID: props.providerID,
          modelID: props.modelID,
          variant: props.variant,
          serviceTier: tier,
        })
        dialog.clear()
      },
    })),
  ])

  return (
    <DialogSelect<string>
      options={options()}
      title={`Select service tier for @${props.agentName}`}
      flat={true}
    />
  )
}
