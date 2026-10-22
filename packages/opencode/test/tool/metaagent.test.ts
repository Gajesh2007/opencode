import { expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { MetaAgent } from "../../src/session/metaagent"
import { MessageID, SessionID } from "../../src/session/schema"
import { MetaAgentTool } from "../../src/tool/metaagent"
import { Tool } from "../../src/tool/tool"
import * as Truncate from "../../src/tool/truncate"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    RuntimeFlags.layer(),
    Layer.mock(MetaAgent.Service, {}),
    Layer.mock(Agent.Service, {}),
    Layer.mock(Truncate.Service, {}),
  ),
)

for (const action of ["get", "set", "clear"] as const) {
  it.effect(`disabled metaagent rejects direct ${action} without calling the service`, () =>
    Effect.gen(function* () {
      const def = yield* Tool.init(yield* MetaAgentTool)
      const exit = yield* def
        .execute(
          { action },
          {
            sessionID: SessionID.make("ses_metaagent"),
            messageID: MessageID.make("msg_metaagent"),
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("OPENCODE_EXPERIMENTAL_METAAGENT=true")
      }
    }),
  )
}
