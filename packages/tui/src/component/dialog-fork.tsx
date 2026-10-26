import { createResource } from "solid-js"
import { Schema } from "effect"
import { ForkControl } from "@opencode/schema/fork-control"
import { useClient } from "../context/client"
import { useLocation } from "../context/location"
import { useRoute } from "../context/route"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

export function DialogFork(props: {
  kind: "goal" | "metaagent" | "agents" | "teams" | "workflows"
  sessionID: string
}) {
  const client = useClient()
  const location = useLocation()
  const route = useRoute()
  const dialog = useDialog()
  const toast = useToast()
  const call = (method: string, input: Record<string, unknown> = {}) =>
    client.api.rpc.call({
      rpcID: ForkControl.Definition.id,
      method,
      input: { sessionID: props.sessionID, ...input },
      location: location.ref,
    })
  const run = (method: string, input?: Record<string, unknown>) =>
    void call(method, input)
      .then(() => dialog.clear())
      .catch((error) => toast.show({ message: errorMessage(error), variant: "error" }))
  const [state] = createResource(async () => Schema.decodeUnknownSync(ForkControl.State)((await call("state")).output))
  const startGoal = () =>
    dialog.replace(() => (
      <DialogPrompt title="Goal objective" onConfirm={(objective) => run("createGoal", { objective })} />
    ))
  const setReviewer = () =>
    dialog.replace(() => (
      <DialogPrompt
        title="Reasoning review lens"
        value={state()?.reviewer?.basePrompt ?? ""}
        onConfirm={(basePrompt) => run("setReviewer", { enabled: true, basePrompt })}
      />
    ))
  const options = () => {
    if (props.kind === "teams")
      return (state()?.teams ?? []).flatMap((team) => [
        {
          value: team.name,
          title: team.name,
          description: team.members.map((member) => member.name).join(", "),
          onSelect: () => {},
        },
        ...team.tasks.map((task) => ({
          value: task.id,
          title: "[" + task.status + "] " + task.title,
          description: task.assignee ?? "",
          onSelect: () => {},
        })),
      ])
    if (props.kind === "workflows")
      return (state()?.workflows ?? []).map((flow) => ({
        value: flow.id,
        title: flow.title,
        description: flow.status + " · " + flow.completed + "/" + flow.cells,
        onSelect: () => {},
      }))
    if (props.kind === "agents")
      return [
        ...(state()?.agents ?? []).map((agent) => ({
          value: agent.sessionID,
          title: agent.path,
          description: agent.status,
          onSelect: () => {
            dialog.clear()
            route.navigate({ type: "session", sessionID: agent.sessionID })
          },
        })),
        { value: "stop", title: "Stop all subagents", onSelect: () => run("stopAgents") },
      ]
    if (props.kind === "metaagent")
      return [
        {
          value: "configure",
          title: state()?.reviewer?.enabled ? "Change review lens" : "Enable reasoning review",
          onSelect: setReviewer,
        },
        { value: "disable", title: "Disable reasoning review", onSelect: () => run("setReviewer", { enabled: false }) },
        { value: "clear", title: "Clear reviewer settings", onSelect: () => run("clearReviewer") },
      ]
    const goal = state()?.goal
    return [
      { value: "create", title: "Start a goal", onSelect: startGoal },
      ...(goal
        ? [
            {
              value: "complete",
              title: "Mark goal completed",
              description: goal.objective,
              onSelect: () => run("updateGoal", { status: "completed" }),
            },
            { value: "stop", title: "Abandon goal", onSelect: () => run("updateGoal", { status: "abandoned" }) },
          ]
        : []),
    ]
  }
  const title = () =>
    props.kind === "goal"
      ? "Goal" +
        (state()?.goal
          ? " · " + state()?.goal?.status + " · " + state()?.goal?.tokensUsed.toLocaleString() + " tokens"
          : "")
      : props.kind === "teams"
        ? "Teams and shared tasks"
        : props.kind === "workflows"
          ? "Workflows"
          : props.kind === "agents"
            ? "Agents"
            : "Reasoning reviewer"
  return <DialogSelect<string> title={title()} options={options()} flat />
}
