export function getModelVariantPresentation(variant: string, input?: { subagentConcurrency?: number }) {
  if (variant !== "ultra") return { label: variant }
  const concurrency = input?.subagentConcurrency
  return {
    label: "Ultra",
    description: "Maximum reasoning with automatic task delegation",
    warning:
      concurrency !== undefined && concurrency >= 8
        ? `Ultra can significantly increase usage and cost with up to ${concurrency} concurrent agents.`
        : "Ultra can significantly increase usage and cost. Proactive agents can increase usage further.",
  }
}
