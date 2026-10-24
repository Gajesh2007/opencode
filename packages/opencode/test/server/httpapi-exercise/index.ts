/**
 * End-to-end exerciser for the Effect HttpApi routes.
 *
 * The goal is not to be a normal unit test file. This is a route-coverage harness:
 * every public route should have a small scenario that proves the route decodes
 * requests, uses the right instance context, mutates storage when expected, and
 * returns the expected response shape.
 *
 * The script intentionally isolates `OPENCODE_DB` before importing modules that touch
 * storage. Scenarios may create/delete sessions and reset the database after each run,
 * so this must never point at a developer's real session database.
 *
 * DSL shape:
 * - `http.protected.get/post/...` starts a scenario for one OpenAPI route key.
 * - `.seeded(...)` creates typed per-scenario state using Effect helpers on `ctx`.
 * - `.at(...)` builds the request from that typed state.
 * - `.json(...)` / `.jsonEffect(...)` assert response shape and optional side effects.
 * - `.mutating()` tells the runner to reset isolated state after destructive routes.
 */
import { Effect, Fiber } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import { TestLLMServer } from "../../lib/llm-server"
import path from "path"
import { array, boolean, check, isRecord, message, object, stable } from "./assertions"
import { controlledPtyInput, http, route } from "./dsl"
import {
  cleanupExercisePaths,
  exerciseConfigDirectory,
  exerciseDataDirectory,
  exerciseDatabasePath,
  exerciseGlobalRoot,
} from "./environment"
import { color, printHeader, printResults } from "./report"
import { coverageResult, parseOptions, routeKey, routeKeys, selectedScenarios } from "./routing"
import { runScenario } from "./runner"
import { runtime } from "./runtime"
import { type ScenarioContext, type Scenario, type SessionInfo } from "./types"

void (await import("@opencode-ai/core/util/log")).init({ print: false })

// Auth probes run against a password-protected app, where an unused code redeems for a session token.
// Codes are single use and short-lived, so each run issues its own.
const pairing = (await import("../../../src/server/pairing")).ServerPairing.issue()

function cursor(input: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(input)).toString("base64url")
}

// Auth probes carry no project directory, so the server falls back to its own working directory (the
// developer's checkout). Probes for routes that write there must fail validation once authorized.
const invalidConfigProbe = { path: "/config", body: { username: 1 } }
const invalidWorktreeProbe = { path: "/experimental/worktree", body: { name: 1 } }

// `!` commands run on plain sh: login shells source user profiles, which is slow and machine-specific.
const shellProject = { git: true, config: { shell: "/bin/sh" } }

function userShell(ctx: ScenarioContext, sessionID: string, command: string) {
  return ctx.request("POST", {
    path: route("/session/{sessionID}/shell", { sessionID }),
    headers: ctx.headers(),
    body: { agent: "build", model: { providerID: "test", modelID: "test-model" }, command },
  })
}

// The bash part's metadata in a `!` command's response.
function shellMetadata(body: unknown) {
  object(body)
  const part = Array.isArray(body.parts) ? body.parts.find((item) => isRecord(item) && item.type === "tool") : undefined
  check(isRecord(part) && isRecord(part.state) && isRecord(part.state.metadata), "shell should return a tool part")
  return part.state.metadata
}

// Runs a `!` command to completion through the API, so its shell lives in the app under test.
function finishedShell(ctx: ScenarioContext, command: string) {
  return Effect.gen(function* () {
    const session = yield* ctx.session({ title: "Shell session" })
    const result = yield* userShell(ctx, session.id, command)
    check(result.status === 200, `shell command should finish: ${result.text}`)
    const shellID = shellMetadata(result.body).shellID
    check(typeof shellID === "string", "shell part should carry its shell id")
    return { session, shellID }
  })
}

// Starts a long-running `!` command without waiting for its response. Resolves once the command runs
// and blocks its session, so it can be killed or moved to the background.
function runningShell(ctx: ScenarioContext) {
  return Effect.gen(function* () {
    const session = yield* ctx.session({ title: "Running shell session" })
    const call = yield* userShell(ctx, session.id, "sleep 30").pipe(Effect.forkDetach)
    const shellID = yield* poll(
      ctx
        .request("GET", {
          path: route("/session/{sessionID}/message", { sessionID: session.id }),
          headers: ctx.headers(),
        })
        .pipe(Effect.map((result) => runningShellID(result.body))),
      "shell command never started",
    )
    return { session, call, shellID }
  })
}

function runningShellID(messages: unknown) {
  if (!Array.isArray(messages)) return
  const id = messages
    .flatMap((item) => (isRecord(item) && Array.isArray(item.parts) ? item.parts : []))
    .map((part) =>
      isRecord(part) && isRecord(part.state) && part.state.status === "running" && isRecord(part.state.metadata)
        ? part.state.metadata.shellID
        : undefined,
    )
    .find((value) => typeof value === "string")
  return typeof id === "string" ? id : undefined
}

function poll<A>(effect: Effect.Effect<A | undefined>, failure: string) {
  return Effect.gen(function* () {
    while (true) {
      const value = yield* effect
      if (value !== undefined) return value
      yield* Effect.sleep("20 millis")
    }
  }).pipe(Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.die(new Error(failure)) }))
}

const testModel = { providerID: "test", modelID: "test-model" }

function promptAsync(ctx: ScenarioContext, sessionID: string, text: string) {
  return ctx.request("POST", {
    path: route("/session/{sessionID}/prompt_async", { sessionID }),
    headers: ctx.headers(),
    body: { agent: "build", model: testModel, parts: [{ type: "text", text }] },
  })
}

// The text of the session's newest assistant reply, once it has finished without error.
function finishedReply(ctx: ScenarioContext, sessionID: SessionInfo["id"]) {
  return ctx.messages(sessionID).pipe(
    Effect.map((messages) => {
      const reply = messages.findLast((item) => item.info.role === "assistant")
      if (reply?.info.role !== "assistant" || reply.info.time.completed === undefined || reply.info.error)
        return undefined
      return reply.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
    }),
  )
}

// Starts a turn that delegates to a subagent whose model call never finishes, without waiting for the turn's
// response. Resolves once the subagent runs. Once the subagent stops, the turn finishes with "parent done".
function runningSubagent(ctx: ScenarioContext) {
  return Effect.gen(function* () {
    const session = yield* ctx.session({ title: "Subagent session" })
    yield* ctx.llmTool("task", {
      description: "inspect bug",
      prompt: "look into the cache key path",
      subagent_type: "general",
    })
    yield* ctx.llmHang()
    yield* ctx.llmText("parent done")
    const call = yield* ctx
      .request("POST", {
        path: route("/session/{sessionID}/message", { sessionID: session.id }),
        headers: ctx.headers(),
        body: { agent: "build", model: testModel, parts: [{ type: "text", text: "delegate the task" }] },
      })
      .pipe(Effect.forkDetach)
    // The turn's task call, then the subagent's own model call.
    yield* ctx.llmWait(2)
    const children = yield* ctx.request("GET", {
      path: route("/session/{sessionID}/children", { sessionID: session.id }),
      headers: ctx.headers(),
    })
    const childID = Array.isArray(children.body) && isRecord(children.body[0]) ? children.body[0].id : undefined
    check(typeof childID === "string", `subagent session should exist: ${children.text}`)
    return { session, call, childID }
  })
}

const scenarios: Scenario[] = [
  http.protected
    .get("/global/health", "global.health")
    .global()
    .json(200, (body) => {
      object(body)
      check(body.healthy === true, "server should report healthy")
    }),
  http.protected
    .get("/global/info", "global.info")
    .global()
    .json(
      200,
      (body) => {
        object(body)
        check(typeof body.version === "string" && typeof body.pid === "number", "info should identify the server")
        array(body.urls)
        check(isRecord(body.paths) && typeof body.paths.tmp === "string", "info should report the temp path")
      },
      "status",
    ),
  http.protected
    .post("/api/pair", "server.pair")
    .global()
    .json(
      400,
      (body) => {
        object(body)
        check(
          typeof body.message === "string" && body.message.includes("server password"),
          `pairing without a server password should be rejected: ${JSON.stringify(body)}`,
        )
      },
      "status",
    ),
  http.public
    .get("/auth/connect/{code}", "server.connect")
    .global()
    .probe({ path: route("/auth/connect/{code}", { code: pairing.code }) })
    .at(() => ({ path: route("/auth/connect/{code}", { code: "httpapi-expired" }) }))
    .json(
      401,
      (body) => {
        object(body)
        check(
          typeof body.message === "string" && body.message.includes("expired"),
          "an unknown pairing code should be rejected",
        )
      },
      "status",
    ),
  http.protected
    .get("/api/remote", "server.remote")
    .global()
    .json(
      200,
      (body) => {
        object(body)
        check(body.enabled === false && body.state === "off", `remote access should be off: ${JSON.stringify(body)}`)
      },
      "status",
    ),
  // Turning remote access on would expose this machine through a real tunnel, so nothing here may succeed at
  // it: auth probes only turn it off, and the app under test has no password (nor a network listener).
  http.protected
    .post("/api/remote", "server.remoteUpdate")
    .global()
    .probe({ path: "/api/remote", body: { enabled: false } })
    .at(() => ({ path: "/api/remote", body: { enabled: false } }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          object(body)
          check(
            body.enabled === false && body.state === "off",
            `remote access should turn off: ${JSON.stringify(body)}`,
          )
          const enable = yield* ctx.request("POST", { path: "/api/remote", body: { enabled: true } })
          check(enable.status === 400, `enabling without a server password should be rejected: ${enable.text}`)
          object(enable.body)
          check(
            typeof enable.body.message === "string" && enable.body.message.includes("server password"),
            `enabling without a server password should explain why: ${enable.text}`,
          )
        }),
      "status",
    ),
  http.protected
    .get("/global/event", "global.event")
    .global()
    .stream()
    .status(
      200,
      (_ctx, result) =>
        Effect.sync(() => {
          check(result.contentType.includes("text/event-stream"), "global event should be an SSE stream")
          check(result.text.includes("server.connected"), "global event should emit initial connection event")
        }),
      "status",
    ),
  http.protected.get("/global/config", "global.config.get").global().json(),
  http.protected
    .patch("/global/config", "global.config.update")
    .global()
    .seeded(() =>
      Effect.promise(() =>
        Bun.write(
          path.join(exerciseConfigDirectory, "opencode.jsonc"),
          JSON.stringify({ username: "httpapi-global" }, null, 2),
        ),
      ),
    )
    .at(() => ({ path: "/global/config", body: { username: "httpapi-global" } }))
    .jsonEffect(
      200,
      (body) =>
        Effect.gen(function* () {
          object(body)
          check(body.username === "httpapi-global", "global config update should return patched config")
          const text = yield* Effect.promise(() =>
            Bun.file(path.join(exerciseConfigDirectory, "opencode.jsonc")).text(),
          )
          check(text.includes('"username": "httpapi-global"'), "global config update should write isolated config file")
        }),
      "status",
    ),
  http.protected
    .post("/global/dispose", "global.dispose")
    .global()
    .mutating()
    .json(
      200,
      (body) => {
        check(body === true, "global dispose should return true")
      },
      "status",
    ),
  http.protected.get("/path", "path.get").json(200, (body, ctx) => {
    object(body)
    check(body.directory === ctx.directory, "directory should resolve from x-opencode-directory")
    check(body.worktree === ctx.directory, "worktree should resolve from x-opencode-directory")
  }),
  http.protected.get("/vcs", "vcs.get").json(),
  http.protected.get("/vcs/status", "vcs.status").json(200, array),
  http.protected
    .get("/vcs/diff", "vcs.diff")
    .at((ctx) => ({ path: "/vcs/diff?mode=git", headers: ctx.headers() }))
    .json(200, array),
  http.protected.get("/vcs/diff/raw", "vcs.diff.raw").status(
    200,
    (_ctx, result) =>
      Effect.sync(() => {
        check(typeof result.text === "string", "raw VCS diff should return text")
      }),
    "status",
  ),
  http.protected
    .post("/vcs/apply", "vcs.apply")
    .inProject({ git: false })
    .at((ctx) => ({ path: "/vcs/apply", headers: ctx.headers(), body: { patch: "" } }))
    .status(400, undefined, "status"),
  http.protected.get("/command", "command.list").json(200, array, "status"),
  http.protected.get("/agent", "app.agents").json(200, array, "status"),
  // Overrides live in the app-wide Agent service, so each scenario clears what it sets.
  http.protected
    .post("/agent/subagent-model", "agent.setSubagentModel")
    .at((ctx) => ({
      path: "/agent/subagent-model",
      headers: ctx.headers(),
      body: { agent: "httpapi-set", providerID: "test", modelID: "test-model" },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        check(body === true, "setting a subagent model should return true")
        const listed = yield* ctx.request("GET", { path: "/agent/subagent-models", headers: ctx.headers() })
        const entry = isRecord(listed.body) ? listed.body["httpapi-set"] : undefined
        check(
          isRecord(entry) && entry.providerID === "test" && entry.modelID === "test-model",
          `override should be listed: ${listed.text}`,
        )
        yield* ctx.request("POST", {
          path: "/agent/subagent-model",
          headers: ctx.headers(),
          body: { agent: "httpapi-set" },
        })
      }),
    ),
  http.protected
    .get("/agent/subagent-models", "agent.listSubagentModels")
    .seeded((ctx) =>
      ctx.request("POST", {
        path: "/agent/subagent-model",
        headers: ctx.headers(),
        body: { agent: "httpapi-list", providerID: "test", modelID: "test-model", variant: "high" },
      }),
    )
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          object(body)
          const entry = body["httpapi-list"]
          check(
            isRecord(entry) &&
              entry.providerID === "test" &&
              entry.modelID === "test-model" &&
              entry.variant === "high",
            `seeded override should be listed: ${JSON.stringify(body)}`,
          )
          yield* ctx.request("POST", {
            path: "/agent/subagent-model",
            headers: ctx.headers(),
            body: { agent: "httpapi-list" },
          })
        }),
      "status",
    ),
  http.protected.get("/skill", "app.skills").json(200, array, "status"),
  http.protected.get("/lsp", "lsp.status").json(200, array),
  http.protected.get("/formatter", "formatter.status").json(200, array),
  http.protected.get("/config", "config.get").json(200, undefined, "status"),
  http.protected
    .patch("/config", "config.update")
    .mutating()
    .probe(invalidConfigProbe)
    .at((ctx) => ({ path: "/config", headers: ctx.headers(), body: { username: "httpapi-local" } }))
    .json(
      200,
      (body) => {
        object(body)
        check(body.username === "httpapi-local", "local config update should return patched config")
      },
      "status",
    ),
  http.protected
    .patch("/config", "config.update.invalid")
    .probe(invalidConfigProbe)
    .at((ctx) => ({ path: "/config", headers: ctx.headers(), body: { username: 1 } }))
    .status(400),
  http.protected.get("/config/providers", "config.providers").json(),
  http.protected.get("/project", "project.list").json(200, array, "status"),
  http.protected.get("/project/current", "project.current").json(
    200,
    (body, ctx) => {
      object(body)
      check(body.worktree === ctx.directory, "current project should resolve from scenario directory")
    },
    "status",
  ),
  http.protected
    .patch("/project/{projectID}", "project.update")
    .mutating()
    .seeded((ctx) => ctx.project())
    .at((ctx) => ({
      path: route("/project/{projectID}", { projectID: ctx.state.id }),
      headers: ctx.headers(),
      body: { name: "HTTP API Project", commands: { start: "bun --version" } },
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(body.name === "HTTP API Project", "project update should return patched name")
        check(
          isRecord(body.commands) && body.commands.start === "bun --version",
          "project update should return patched command",
        )
      },
      "status",
    ),
  http.protected
    .patch("/project/{projectID}", "project.update.missing")
    .mutating()
    .at((ctx) => ({
      path: route("/project/{projectID}", { projectID: "project_httpapi_missing" }),
      headers: ctx.headers(),
      body: { name: "Missing Project" },
    }))
    .json(404, object, "status"),
  http.protected
    .post("/project/git/init", "project.initGit")
    .mutating()
    .inProject({ git: false })
    .json(
      200,
      (body, ctx) => {
        object(body)
        check(body.worktree === ctx.directory, "git init should return current project")
        check(body.vcs === "git", "git init should mark the project as git-backed")
      },
      "status",
    ),
  http.protected.get("/provider", "provider.list").json(),
  http.protected.get("/provider/auth", "provider.auth").json(),
  http.protected
    .post("/provider/{providerID}/oauth/authorize", "provider.oauth.authorize")
    .at((ctx) => ({
      path: route("/provider/{providerID}/oauth/authorize", { providerID: "httpapi" }),
      headers: ctx.headers(),
      body: { method: "bad" },
    }))
    .status(400),
  http.protected
    .post("/provider/{providerID}/oauth/callback", "provider.oauth.callback")
    .at((ctx) => ({
      path: route("/provider/{providerID}/oauth/callback", { providerID: "httpapi" }),
      headers: ctx.headers(),
      body: { method: "bad" },
    }))
    .status(400),
  http.protected.get("/permission", "permission.list").json(200, array),
  http.protected
    .post("/permission/{requestID}/reply", "permission.reply.invalid")
    .at((ctx) => ({
      path: route("/permission/{requestID}/reply", { requestID: "per_httpapi" }),
      headers: ctx.headers(),
      body: { reply: "bad" },
    }))
    .status(400),
  http.protected
    .post("/permission/{requestID}/reply", "permission.reply")
    .at((ctx) => ({
      path: route("/permission/{requestID}/reply", { requestID: "per_httpapi" }),
      headers: ctx.headers(),
      body: { reply: "once" },
    }))
    .json(404, object, "status"),
  http.protected.get("/question", "question.list").json(200, array),
  http.protected
    .post("/question/{requestID}/reply", "question.reply.invalid")
    .at((ctx) => ({
      path: route("/question/{requestID}/reply", { requestID: "que_httpapi_reply" }),
      headers: ctx.headers(),
      body: { answers: "Yes" },
    }))
    .status(400),
  http.protected
    .post("/question/{requestID}/reply", "question.reply")
    .at((ctx) => ({
      path: route("/question/{requestID}/reply", { requestID: "que_httpapi_reply" }),
      headers: ctx.headers(),
      body: { answers: [["Yes"]] },
    }))
    .json(404, object, "status"),
  http.protected
    .post("/question/{requestID}/reject", "question.reject")
    .at((ctx) => ({
      path: route("/question/{requestID}/reject", { requestID: "que_httpapi_reject" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .get("/file", "file.list")
    .seeded((ctx) => ctx.file("hello.txt", "hello\n"))
    .at((ctx) => ({ path: `/file?${new URLSearchParams({ path: "." })}`, headers: ctx.headers() }))
    .json(200, array),
  http.protected
    .get("/file/content", "file.read")
    .seeded((ctx) => ctx.file("hello.txt", "hello\n"))
    .at((ctx) => ({ path: `/file/content?${new URLSearchParams({ path: "hello.txt" })}`, headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      check(body.content === "hello", `content should match seeded file: ${JSON.stringify(body)}`)
    }),
  http.protected
    .get("/file/content", "file.read.missing")
    .at((ctx) => ({ path: `/file/content?${new URLSearchParams({ path: "missing.txt" })}`, headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      check(body.type === "text" && body.content === "", "missing file content should return an empty text result")
    }),
  http.protected.get("/file/status", "file.status").json(200, array),
  http.protected
    .get("/find", "find.text")
    .seeded((ctx) => ctx.file("hello.txt", "hello\n"))
    .at((ctx) => ({ path: `/find?${new URLSearchParams({ pattern: "hello" })}`, headers: ctx.headers() }))
    .json(200, array),
  http.protected
    .get("/find/file", "find.files")
    .seeded((ctx) => ctx.file("hello.txt", "hello\n"))
    .at((ctx) => ({
      path: `/find/file?${new URLSearchParams({ query: "hello", dirs: "false" })}`,
      headers: ctx.headers(),
    }))
    .json(200, array),
  http.protected
    .get("/find/symbol", "find.symbols")
    .seeded((ctx) => ctx.file("hello.ts", "export const hello = 1\n"))
    .at((ctx) => ({ path: `/find/symbol?${new URLSearchParams({ query: "hello" })}`, headers: ctx.headers() }))
    .json(200, array),
  http.protected
    .get("/event", "event.stream")
    .stream()
    .status(
      200,
      (_ctx, result) =>
        Effect.sync(() => {
          check(result.contentType.includes("text/event-stream"), "event should be an SSE stream")
          check(result.text.includes("server.connected"), "event should emit initial connection event")
        }),
      "status",
    ),
  http.protected.get("/mcp", "mcp.status").json(),
  http.protected
    .post("/mcp", "mcp.add")
    .mutating()
    .at((ctx) => ({
      path: "/mcp",
      headers: ctx.headers(),
      body: { name: "httpapi-disabled", config: { type: "local", command: ["bun", "--version"], enabled: false } },
    }))
    .json(
      200,
      (body) => {
        object(body)
        object(body["httpapi-disabled"])
        check(body["httpapi-disabled"].status === "disabled", "disabled MCP server should be added without spawning")
      },
      "status",
    ),
  http.protected
    .post("/mcp", "mcp.add.invalid")
    .at((ctx) => ({
      path: "/mcp",
      headers: ctx.headers(),
      body: { name: "httpapi-invalid", config: { type: "invalid" } },
    }))
    .status(400),
  http.protected
    .post("/mcp/{name}/auth", "mcp.auth.start")
    .at((ctx) => ({ path: route("/mcp/{name}/auth", { name: "httpapi-missing" }), headers: ctx.headers() }))
    .json(404, object, "status"),
  http.protected
    .delete("/mcp/{name}/auth", "mcp.auth.remove")
    .mutating()
    .at((ctx) => ({ path: route("/mcp/{name}/auth", { name: "httpapi-missing" }), headers: ctx.headers() }))
    .json(404, object, "status"),
  http.protected
    .post("/mcp/{name}/auth/authenticate", "mcp.auth.authenticate")
    .at((ctx) => ({
      path: route("/mcp/{name}/auth/authenticate", { name: "httpapi-missing" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .post("/mcp/{name}/auth/callback", "mcp.auth.callback")
    .at((ctx) => ({
      path: route("/mcp/{name}/auth/callback", { name: "httpapi-missing" }),
      headers: ctx.headers(),
      body: { code: "code" },
    }))
    .json(404, object, "status"),
  http.protected
    .post("/mcp/{name}/connect", "mcp.connect")
    .mutating()
    .at((ctx) => ({ path: route("/mcp/{name}/connect", { name: "httpapi-missing" }), headers: ctx.headers() }))
    .json(404, object, "status"),
  http.protected
    .post("/mcp/{name}/disconnect", "mcp.disconnect")
    .mutating()
    .at((ctx) => ({ path: route("/mcp/{name}/disconnect", { name: "httpapi-missing" }), headers: ctx.headers() }))
    .json(404, object, "status"),
  http.protected.get("/pty/shells", "pty.shells").json(200, array),
  http.protected.get("/pty", "pty.list").json(200, array),
  http.protected
    .post("/pty", "pty.create")
    .mutating()
    .at((ctx) => ({ path: "/pty", headers: ctx.headers(), body: controlledPtyInput("HTTP API PTY") }))
    .json(
      200,
      (body, ctx) => {
        object(body)
        check(body.title === "HTTP API PTY", "PTY create should return requested title")
        check(body.command === "/bin/sh", "PTY create should use controlled shell command")
        check(body.cwd === ctx.directory, "PTY create should default cwd to scenario directory")
      },
      "status",
    ),
  http.protected
    .post("/pty", "pty.create.invalid")
    .at((ctx) => ({ path: "/pty", headers: ctx.headers(), body: { command: 1 } }))
    .status(400),
  http.protected
    .post("/pty/{ptyID}/connect-token", "pty.connectToken.invalid")
    .at((ctx) => ({
      path: route("/pty/{ptyID}/connect-token", { ptyID: "pty_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .status(403, undefined, "status"),
  http.protected
    .get("/pty/{ptyID}", "pty.get")
    .at((ctx) => ({ path: route("/pty/{ptyID}", { ptyID: "pty_httpapi_missing" }), headers: ctx.headers() }))
    .status(404),
  http.protected
    .put("/pty/{ptyID}", "pty.update")
    .mutating()
    .at((ctx) => ({
      path: route("/pty/{ptyID}", { ptyID: "pty_httpapi_missing" }),
      headers: ctx.headers(),
      body: { size: { rows: 0, cols: 0 } },
    }))
    .status(400),
  http.protected
    .delete("/pty/{ptyID}", "pty.remove")
    .mutating()
    .at((ctx) => ({ path: route("/pty/{ptyID}", { ptyID: "pty_httpapi_missing" }), headers: ctx.headers() }))
    .json(404, object, "status"),
  http.protected
    .get("/pty/{ptyID}/connect", "pty.connect")
    .at((ctx) => ({ path: route("/pty/{ptyID}/connect", { ptyID: "pty_httpapi_missing" }), headers: ctx.headers() }))
    .status(404, undefined, "none"),
  http.protected
    .get("/shell", "shell.list")
    .inProject(shellProject)
    .seeded((ctx) => finishedShell(ctx, "printf shell-list"))
    .at((ctx) => ({
      path: `/shell?${new URLSearchParams({ sessionID: ctx.state.session.id })}`,
      headers: ctx.headers(),
    }))
    .json(
      200,
      (body, ctx) => {
        array(body)
        check(
          body.length === 1 && isRecord(body[0]) && body[0].id === ctx.state.shellID && body[0].status === "exited",
          `session filter should list only the session's shell: ${JSON.stringify(body)}`,
        )
      },
      "status",
    ),
  http.protected
    .get("/shell/{shellID}", "shell.get")
    .inProject(shellProject)
    .seeded((ctx) => finishedShell(ctx, "printf shell-get"))
    .at((ctx) => ({ path: route("/shell/{shellID}", { shellID: ctx.state.shellID }), headers: ctx.headers() }))
    .json(
      200,
      (body, ctx) => {
        object(body)
        check(body.id === ctx.state.shellID && body.sessionID === ctx.state.session.id, "should return the shell")
        check(body.source === "user" && body.command === "printf shell-get", "should describe the user command")
        check(body.status === "exited" && body.exit === 0, `should report the exit: ${JSON.stringify(body)}`)
      },
      "status",
    ),
  http.protected
    .get("/shell/{shellID}", "shell.get.missing")
    .at((ctx) => ({ path: route("/shell/{shellID}", { shellID: "sh_httpapi_missing" }), headers: ctx.headers() }))
    .json(404, (body) => {
      object(body)
      check(body.shellID === "sh_httpapi_missing", "missing shell error should name the shell")
    }),
  http.protected
    .get("/shell/{shellID}/output", "shell.output")
    .inProject(shellProject)
    .seeded((ctx) => finishedShell(ctx, "printf shell-output"))
    .at((ctx) => ({
      path: `${route("/shell/{shellID}/output", { shellID: ctx.state.shellID })}?${new URLSearchParams({ cursor: "6", limit: "64" })}`,
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      check(
        stable(body) === stable({ output: "output", cursor: 12, size: 12 }),
        `output should page from the cursor: ${JSON.stringify(body)}`,
      )
    }),
  http.protected
    .get("/shell/{shellID}/output", "shell.output.missing")
    .at((ctx) => ({
      path: route("/shell/{shellID}/output", { shellID: "sh_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .post("/shell/{shellID}/kill", "shell.kill")
    .inProject(shellProject)
    .mutating()
    .seeded((ctx) => runningShell(ctx))
    .at((ctx) => ({ path: route("/shell/{shellID}/kill", { shellID: ctx.state.shellID }), headers: ctx.headers() }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          object(body)
          check(
            body.id === ctx.state.shellID && body.status === "killed",
            `kill should settle: ${JSON.stringify(body)}`,
          )
          // The `!` call that was blocked on the command returns once it is killed.
          const call = yield* Fiber.join(ctx.state.call)
          check(call.status === 200, `killed shell command should still respond: ${call.text}`)
          check(shellMetadata(call.body).shellID === ctx.state.shellID, "response should describe the killed shell")
        }),
      "status",
    ),
  http.protected
    .post("/shell/{shellID}/kill", "shell.kill.missing")
    .mutating()
    .at((ctx) => ({ path: route("/shell/{shellID}/kill", { shellID: "sh_httpapi_missing" }), headers: ctx.headers() }))
    .json(404, object, "status"),
  http.protected.get("/experimental/console", "experimental.console.get").json(),
  http.protected.get("/experimental/console/orgs", "experimental.console.listOrgs").json(),
  http.protected
    .post("/experimental/console/switch", "experimental.console.switchOrg")
    .at((ctx) => ({
      path: "/experimental/console/switch",
      headers: ctx.headers(),
      body: { accountID: "httpapi-account", orgID: "httpapi-org" },
    }))
    .status(400, undefined, "none"),
  http.protected.get("/experimental/workspace/adapter", "experimental.workspace.adapter.list").json(200, array),
  http.protected.get("/experimental/workspace", "experimental.workspace.list").json(200, array),
  http.protected.get("/experimental/workspace/status", "experimental.workspace.status").json(200, array),
  http.protected
    .post("/experimental/workspace", "experimental.workspace.create")
    .at((ctx) => ({ path: "/experimental/workspace", headers: ctx.headers(), body: {} }))
    .status(400),
  http.protected
    .post("/experimental/workspace/sync-list", "experimental.workspace.syncList")
    .status(204, undefined, "status"),
  http.protected
    .delete("/experimental/workspace/{id}", "experimental.workspace.remove")
    .mutating()
    .at((ctx) => ({
      path: route("/experimental/workspace/{id}", { id: "wrk_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .status(200),
  http.protected
    .post("/experimental/workspace/warp", "experimental.workspace.warp")
    .at((ctx) => ({
      path: "/experimental/workspace/warp",
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .get("/experimental/tool", "tool.list")
    .at((ctx) => ({
      path: `/experimental/tool?${new URLSearchParams({ provider: "opencode", model: "test" })}`,
      headers: ctx.headers(),
    }))
    .json(200, array, "status"),
  http.protected.get("/experimental/tool/ids", "tool.ids").json(200, array),
  http.protected.get("/experimental/worktree", "worktree.list").json(200, array),
  http.protected
    .post("/experimental/worktree", "worktree.create")
    .mutating()
    .probe(invalidWorktreeProbe)
    .at((ctx) => ({ path: "/experimental/worktree", headers: ctx.headers(), body: { name: "api-dsl" } }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          object(body)
          check(typeof body.directory === "string", "created worktree should include directory")
          yield* ctx.worktreeRemove(body.directory)
        }),
      "status",
    ),
  http.protected
    .post("/experimental/worktree", "worktree.create.invalid")
    .probe(invalidWorktreeProbe)
    .at((ctx) => ({ path: "/experimental/worktree", headers: ctx.headers(), body: { name: 1 } }))
    .status(400),
  http.protected
    .delete("/experimental/worktree", "worktree.remove")
    .mutating()
    .seeded((ctx) => ctx.worktree({ name: "api-remove" }))
    .at((ctx) => ({ path: "/experimental/worktree", headers: ctx.headers(), body: { directory: ctx.state.directory } }))
    .json(200, (body) => {
      check(body === true, "worktree remove should return true")
    }),
  http.protected
    .post("/experimental/worktree/reset", "worktree.reset")
    .mutating()
    .seeded((ctx) => ctx.worktree({ name: "api-reset" }))
    .at((ctx) => ({
      path: "/experimental/worktree/reset",
      headers: ctx.headers(),
      body: { directory: ctx.state.directory },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        check(body === true, "worktree reset should return true")
        yield* ctx.worktreeRemove(ctx.state.directory)
      }),
    ),
  http.protected
    .get("/experimental/session", "experimental.session.list")
    .at((ctx) => ({ path: "/experimental/session?roots=false&archived=false", headers: ctx.headers() }))
    .json(200, array),
  http.protected.get("/experimental/resource", "experimental.resource.list").json(),
  http.protected
    .post("/sync/history", "sync.history.list")
    .at((ctx) => ({ path: "/sync/history", headers: ctx.headers(), body: {} }))
    .json(200, array),
  http.protected
    .post("/sync/replay", "sync.replay")
    .at((ctx) => ({ path: "/sync/replay", headers: ctx.headers(), body: { directory: ctx.directory, events: [] } }))
    .status(400),
  http.protected
    .post("/sync/steal", "sync.steal.invalid")
    .at((ctx) => ({ path: "/sync/steal", headers: ctx.headers(), body: {} }))
    .status(400, undefined, "status"),
  http.protected
    .post("/sync/start", "sync.start")
    .mutating()
    .preserveDatabase()
    .json(200, (body) => {
      check(body === true, "sync start should return true when no workspace sessions exist")
    }),
  http.protected
    .post("/instance/dispose", "instance.dispose")
    .mutating()
    .json(200, (body) => {
      check(body === true, "instance dispose should return true")
    }),
  http.protected
    .post("/log", "app.log")
    .global()
    .at(() => ({ path: "/log", body: { service: "httpapi-exercise", level: "info", message: "route coverage" } }))
    .json(200, (body) => {
      check(body === true, "log route should return true")
    }),
  http.protected
    .put("/auth/{providerID}", "auth.set")
    .global()
    .at(() => ({ path: route("/auth/{providerID}", { providerID: "test" }), body: { type: "api", key: "test-key" } }))
    .jsonEffect(200, (body) =>
      Effect.gen(function* () {
        check(body === true, "auth set should return true")
        const auth = yield* Effect.promise(() => Bun.file(path.join(exerciseDataDirectory, "auth.json")).json())
        object(auth)
        check(isRecord(auth.test) && auth.test.key === "test-key", "auth set should write isolated auth file")
      }),
    ),
  http.protected
    .delete("/auth/{providerID}", "auth.remove")
    .global()
    .seeded(() =>
      Effect.promise(() =>
        Bun.write(
          path.join(exerciseDataDirectory, "auth.json"),
          JSON.stringify({ test: { type: "api", key: "remove-me" } }),
        ),
      ),
    )
    .at(() => ({ path: route("/auth/{providerID}", { providerID: "test" }) }))
    .jsonEffect(200, (body) =>
      Effect.gen(function* () {
        check(body === true, "auth remove should return true")
        const auth = yield* Effect.promise(() => Bun.file(path.join(exerciseDataDirectory, "auth.json")).json())
        object(auth)
        check(auth.test === undefined, "auth remove should delete provider from isolated auth file")
      }),
    ),
  http.protected.get("/api/model", "v2.model.list").json(200, array),
  http.protected.get("/api/provider", "v2.provider.list").json(200, array),
  http.protected
    .get("/api/provider/{providerID}", "v2.provider.get")
    .at((ctx) => ({ path: route("/api/provider/{providerID}", { providerID: "missing" }), headers: ctx.headers() }))
    .json(404, object, "status"),
  http.protected
    .get("/api/session", "v2.session.list")
    .at((ctx) => ({ path: "/api/session?roots=true", headers: ctx.headers() }))
    .json(
      200,
      (body) => {
        object(body)
        array(body.items)
        object(body.cursor)
      },
      "none",
    ),
  http.protected
    .get("/api/session", "v2.session.list.filters")
    .at((ctx) => ({
      path: `/api/session?${new URLSearchParams({
        limit: "2",
        order: "asc",
        path: ".",
        roots: "false",
        start: "0",
        search: "missing",
        directory: ctx.directory ?? "",
      })}`,
      headers: ctx.headers(),
    }))
    .json(
      200,
      (body) => {
        object(body)
        array(body.items)
        object(body.cursor)
      },
      "none",
    ),
  http.protected
    .get("/api/session", "v2.session.list.cursor")
    .at((ctx) => ({
      path: `/api/session?${new URLSearchParams({
        limit: "2",
        directory: ctx.directory ?? "",
        cursor: cursor({
          id: "ses_httpapi_missing",
          time: 0,
          order: "desc",
          direction: "next",
          directory: ctx.directory,
        }),
      })}`,
      headers: ctx.headers(),
    }))
    .json(
      200,
      (body) => {
        object(body)
        array(body.items)
        object(body.cursor)
      },
      "none",
    ),
  http.protected
    .get("/api/session", "v2.session.list.cursor.invalid")
    .at((ctx) => ({
      path: `/api/session?${new URLSearchParams({
        cursor: cursor({ id: "ses_httpapi_missing", time: 0, order: "desc", direction: "next" }),
        search: "not-allowed-with-cursor",
      })}`,
      headers: ctx.headers(),
    }))
    .status(400, undefined, "none"),
  http.protected
    .get("/api/session/{sessionID}/context", "v2.session.context")
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/context", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .get("/api/session/{sessionID}/message", "v2.session.messages")
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/message", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .get("/api/session/{sessionID}/message", "v2.session.messages.params")
    .at((ctx) => ({
      path: `${route("/api/session/{sessionID}/message", { sessionID: "ses_httpapi_missing" })}?${new URLSearchParams({
        limit: "2",
        order: "asc",
      })}`,
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .get("/api/session/{sessionID}/message", "v2.session.messages.cursor")
    .at((ctx) => ({
      path: `${route("/api/session/{sessionID}/message", { sessionID: "ses_httpapi_missing" })}?${new URLSearchParams({
        limit: "2",
        directory: ctx.directory ?? "",
        cursor: cursor({ id: "msg_httpapi_missing", time: 0, order: "desc", direction: "next" }),
      })}`,
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .get("/api/session/{sessionID}/message", "v2.session.messages.cursor.invalid")
    .at((ctx) => ({
      path: `${route("/api/session/{sessionID}/message", { sessionID: "ses_httpapi_missing" })}?${new URLSearchParams({
        cursor: cursor({ id: "msg_httpapi_missing", time: 0, order: "desc", direction: "next" }),
        order: "asc",
      })}`,
      headers: ctx.headers(),
    }))
    .status(400, undefined, "none"),
  http.protected
    .post("/api/session/{sessionID}/prompt", "v2.session.prompt.invalid")
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/prompt", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
      body: {},
    }))
    .status(400, undefined, "none"),
  http.protected
    .post("/api/session/{sessionID}/compact", "v2.session.compact")
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/compact", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .status(404, undefined, "status"),
  http.protected
    .post("/api/session/{sessionID}/wait", "v2.session.wait")
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/wait", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .status(404, undefined, "status"),
  http.protected
    .get("/session", "session.list")
    .seeded((ctx) => ctx.session({ title: "List me" }))
    .at((ctx) => ({ path: "/session?roots=true", headers: ctx.headers() }))
    .json(200, (body, ctx) => {
      array(body)
      check(
        body.some((item) => isRecord(item) && item.id === ctx.state.id && item.title === "List me"),
        "seeded session should be listed",
      )
    }),
  http.protected
    .get("/session/search", "session.search")
    .seeded((ctx) => ctx.session({ title: "Search me" }))
    .at((ctx) => ({ path: "/session/search?query=Search", headers: ctx.headers() }))
    .json(200, (body, ctx) => {
      object(body)
      array(body.items)
      check(
        body.items.some((item) => isRecord(item) && isRecord(item.session) && item.session.id === ctx.state.id),
        "persisted folder session should match search",
      )
    }),
  http.protected
    .get("/session/status", "session.status")
    .seeded((ctx) => ctx.session({ title: "Status session" }))
    .json(200, object),
  http.protected
    .post("/session", "session.create")
    .mutating()
    .at((ctx) => ({ path: "/session", headers: ctx.headers(), body: { title: "Created session" } }))
    .json(
      200,
      (body, ctx) => {
        object(body)
        check(body.title === "Created session", "created session should use requested title")
        check(body.directory === ctx.directory, "created session should use scenario directory")
      },
      "status",
    ),
  http.protected
    .get("/session/{sessionID}", "session.get")
    .seeded((ctx) => ctx.session({ title: "Get me" }))
    .at((ctx) => ({ path: route("/session/{sessionID}", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(200, (body, ctx) => {
      object(body)
      check(body.id === ctx.state.id, "should return requested session")
      check(body.title === "Get me", "should preserve seeded title")
    }),
  http.protected
    .get("/session/{sessionID}", "session.get.missing")
    .at((ctx) => ({
      path: route("/session/{sessionID}", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .status(404),
  http.protected
    .patch("/session/{sessionID}", "session.update")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Before rename" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { title: "After rename" },
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(body.title === "After rename", "updated session should use new title")
      },
      "status",
    ),
  http.protected
    .patch("/session/{sessionID}", "session.update.invalid")
    .mutating()
    .at((ctx) => ({
      path: route("/session/{sessionID}", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
      body: { title: 1 },
    }))
    .status(400),
  http.protected
    .delete("/session/{sessionID}", "session.delete")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Delete me" }))
    .at((ctx) => ({ path: route("/session/{sessionID}", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        check(body === true, "delete should return true")
        check((yield* ctx.sessionGet(ctx.state.id)) === undefined, "deleted session should not remain in storage")
      }),
    ),
  http.protected
    .get("/session/{sessionID}/children", "session.children")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const parent = yield* ctx.session({ title: "Parent" })
        const child = yield* ctx.session({ title: "Child", parentID: parent.id })
        return { parent, child }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/children", { sessionID: ctx.state.parent.id }),
      headers: ctx.headers(),
    }))
    .json(200, (body, ctx) => {
      array(body)
      check(
        body.some((item) => isRecord(item) && item.id === ctx.state.child.id && item.parentID === ctx.state.parent.id),
        "children should include seeded child",
      )
    }),
  http.protected
    .get("/session/{sessionID}/todo", "session.todo")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Todo session" })
        const todos = [{ content: "cover session todo", status: "pending", priority: "high" }]
        yield* ctx.todos(session.id, todos)
        return { session, todos }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/todo", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
    }))
    .json(200, (body, ctx) => {
      check(stable(body) === stable(ctx.state.todos), "todos should match seeded state")
    }),
  http.protected
    .get("/session/{sessionID}/goal", "session.goal")
    .seeded((ctx) => ctx.session({ title: "Goal session" }))
    .at((ctx) => ({ path: route("/session/{sessionID}/goal", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(200, (body) => {
      check(body === null, "a session without a goal should return null")
    }),
  http.protected
    .get("/session/{sessionID}/usage", "session.usage")
    .seeded((ctx) => ctx.session({ title: "Usage session" }))
    .at((ctx) => ({ path: route("/session/{sessionID}/usage", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      check(body.attempts === 0 && body.tokens === 0 && body.cost === 0, "a new session should have no usage")
    }),
  http.protected
    .post("/session/{sessionID}/warm", "session.warm")
    .seeded((ctx) => ctx.session({ title: "Warm session" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/warm", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      // An unknown model fails before any network IO; warming is best effort and still succeeds.
      body: { providerID: "httpapi-missing", modelID: "missing" },
    }))
    .json(200, (body) => {
      check(
        stable(body) === stable({ connection: "failed", context: "skipped" }),
        `warming an unknown model should report failure: ${JSON.stringify(body)}`,
      )
    }),
  http.protected
    .post("/session/{sessionID}/warm", "session.warm.invalid")
    .seeded((ctx) => ctx.session({ title: "Warm session" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/warm", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { providerID: "test", modelID: "test-model", draft: "not allowed" },
    }))
    .status(400),
  http.protected
    .get("/session/{sessionID}/diff", "session.diff")
    .seeded((ctx) => ctx.session({ title: "Diff session" }))
    .at((ctx) => ({ path: route("/session/{sessionID}/diff", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(200, array),
  http.protected
    .get("/session/{sessionID}/message", "session.messages")
    .seeded((ctx) => ctx.session({ title: "Messages session" }))
    .at((ctx) => ({ path: route("/session/{sessionID}/message", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(200, (body) => {
      array(body)
      check(body.length === 0, "new session should have no messages")
    }),
  http.protected
    .get("/session/{sessionID}/message/{messageID}", "session.message")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Message get session" })
        const message = yield* ctx.message(session.id, { text: "read me" })
        return { session, message }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/message/{messageID}", {
        sessionID: ctx.state.session.id,
        messageID: ctx.state.message.info.id,
      }),
      headers: ctx.headers(),
    }))
    .json(200, (body, ctx) => {
      object(body)
      check(isRecord(body.info) && body.info.id === ctx.state.message.info.id, "should return requested message")
      check(
        Array.isArray(body.parts) && body.parts.some((part) => isRecord(part) && part.id === ctx.state.message.part.id),
        "message should include seeded part",
      )
    }),
  http.protected
    .patch("/session/{sessionID}/message/{messageID}/part/{partID}", "part.update")
    .mutating()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Part update session" })
        const message = yield* ctx.message(session.id, { text: "before" })
        return { session, message }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/message/{messageID}/part/{partID}", {
        sessionID: ctx.state.session.id,
        messageID: ctx.state.message.info.id,
        partID: ctx.state.message.part.id,
      }),
      headers: ctx.headers(),
      body: { ...ctx.state.message.part, text: "after" },
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(body.type === "text" && body.text === "after", "updated part should be returned")
      },
      "status",
    ),
  http.protected
    .delete("/session/{sessionID}/message/{messageID}/part/{partID}", "part.delete")
    .mutating()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Part delete session" })
        const message = yield* ctx.message(session.id, { text: "delete part" })
        return { session, message }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/message/{messageID}/part/{partID}", {
        sessionID: ctx.state.session.id,
        messageID: ctx.state.message.info.id,
        partID: ctx.state.message.part.id,
      }),
      headers: ctx.headers(),
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        check(body === true, "delete part should return true")
        const messages = yield* ctx.messages(ctx.state.session.id)
        check(messages[0]?.parts.length === 0, "deleted part should not remain on message")
      }),
    ),
  http.protected
    .delete("/session/{sessionID}/message/{messageID}", "session.deleteMessage")
    .mutating()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Message delete session" })
        const message = yield* ctx.message(session.id, { text: "delete message" })
        return { session, message }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/message/{messageID}", {
        sessionID: ctx.state.session.id,
        messageID: ctx.state.message.info.id,
      }),
      headers: ctx.headers(),
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        check(body === true, "delete message should return true")
        check((yield* ctx.messages(ctx.state.session.id)).length === 0, "deleted message should not remain")
      }),
    ),
  http.protected
    .post("/session/{sessionID}/fork", "session.fork")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Fork source" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/fork", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: {},
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(typeof body.id === "string", "fork should return a session")
      },
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/abort", "session.abort")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Abort session" }))
    .at((ctx) => ({ path: route("/session/{sessionID}/abort", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(200, (body) => {
      check(body === true, "abort should return true")
    }),
  http.protected
    .post("/session/{sessionID}/abort", "session.abort.missing")
    .at((ctx) => ({
      path: route("/session/{sessionID}/abort", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .post("/session/{sessionID}/interrupt", "session.interrupt")
    .inProject(shellProject)
    .mutating()
    .seeded((ctx) => runningShell(ctx))
    .at((ctx) => ({
      path: route("/session/{sessionID}/interrupt", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
      body: { resume: true },
    }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          check(
            stable(body) === stable({ interrupted: true, resumed: false }),
            `interrupt should stop the command, with nothing queued to resume: ${JSON.stringify(body)}`,
          )
          // Like abort, interrupting stops the foreground `!` command.
          const call = yield* Fiber.join(ctx.state.call)
          check(call.status === 200, `interrupted shell command should respond: ${call.text}`)
          yield* poll(
            ctx
              .request("GET", {
                path: route("/shell/{shellID}", { shellID: ctx.state.shellID }),
                headers: ctx.headers(),
              })
              .pipe(
                Effect.map((shell) => (isRecord(shell.body) && shell.body.status !== "running" ? true : undefined)),
              ),
            "interrupted command kept running",
          )
        }),
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/interrupt", "session.interrupt.queued")
    .withLlm()
    .mutating()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Queued interrupt session" })
        yield* ctx.llmHang()
        yield* ctx.llmText("handled the queued prompt")
        yield* promptAsync(ctx, session.id, "first prompt")
        yield* ctx.llmWait(1)
        yield* promptAsync(ctx, session.id, "queued prompt")
        yield* poll(
          ctx
            .messages(session.id)
            .pipe(
              Effect.map((messages) =>
                messages.some((item) =>
                  item.parts.some((part) => part.type === "text" && part.text === "queued prompt"),
                )
                  ? true
                  : undefined,
              ),
            ),
          "queued prompt was never saved",
        )
        return session
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/interrupt", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { resume: true },
    }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          check(
            stable(body) === stable({ interrupted: true, resumed: true }),
            `interrupt should resume the queued prompt: ${JSON.stringify(body)}`,
          )
          const reply = yield* poll(finishedReply(ctx, ctx.state.id), "queued prompt never got a reply")
          check(reply === "handled the queued prompt", `queued prompt should start a new turn: ${reply}`)
        }),
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/interrupt", "session.interrupt.idle")
    .seeded((ctx) => ctx.session({ title: "Idle interrupt session" }))
    // No body: resuming is optional.
    .at((ctx) => ({
      path: route("/session/{sessionID}/interrupt", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      check(stable(body) === stable({ interrupted: false, resumed: false }), "an idle session has nothing to interrupt")
    }),
  http.protected
    .post("/session/{sessionID}/interrupt", "session.interrupt.invalid")
    .seeded((ctx) => ctx.session({ title: "Invalid interrupt session" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/interrupt", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { resume: "yes" },
    }))
    .status(400),
  http.protected
    .post("/session/{sessionID}/interrupt", "session.interrupt.missing")
    .at((ctx) => ({
      path: route("/session/{sessionID}/interrupt", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .post("/session/{sessionID}/subagents/stop", "session.stopSubagents")
    .withLlm()
    .mutating()
    .seeded((ctx) => runningSubagent(ctx))
    .at((ctx) => ({
      path: route("/session/{sessionID}/subagents/stop", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
    }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          check(
            stable(body) === stable({ stopped: [ctx.state.childID] }),
            `stop should report the running subagent: ${JSON.stringify(body)}`,
          )
          // The session's own turn keeps going: it gets the stopped subagent's result and finishes.
          const call = yield* Fiber.join(ctx.state.call)
          check(call.status === 200, `the turn should finish: ${call.text}`)
          check(
            isRecord(call.body) &&
              Array.isArray(call.body.parts) &&
              call.body.parts.some((part) => isRecord(part) && part.text === "parent done"),
            `the turn should continue after its subagent stopped: ${call.text}`,
          )
        }),
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/subagents/stop", "session.stopSubagents.idle")
    .seeded((ctx) => ctx.session({ title: "No subagents session" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/subagents/stop", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      check(stable(body) === stable({ stopped: [] }), "nothing should stop without running subagents")
    }),
  http.protected
    .post("/session/{sessionID}/subagents/stop", "session.stopSubagents.missing")
    .at((ctx) => ({
      path: route("/session/{sessionID}/subagents/stop", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .post("/session/{sessionID}/background", "session.background")
    .inProject(shellProject)
    .mutating()
    .seeded((ctx) => runningShell(ctx))
    .at((ctx) => ({
      path: route("/session/{sessionID}/background", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
    }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          check(
            stable(body) === stable([{ id: ctx.state.shellID, type: "shell", title: "sleep 30" }]),
            `background should move the blocking shell command: ${JSON.stringify(body)}`,
          )
          // The `!` call returns as soon as its command moves to the background; the command keeps running.
          const call = yield* Fiber.join(ctx.state.call)
          check(call.status === 200, `backgrounded shell command should respond: ${call.text}`)
          const metadata = shellMetadata(call.body)
          check(metadata.background === true && metadata.shellID === ctx.state.shellID, "part should be backgrounded")
          const path = route("/shell/{shellID}", { shellID: ctx.state.shellID })
          const shell = yield* ctx.request("GET", { path, headers: ctx.headers() })
          check(
            isRecord(shell.body) && shell.body.status === "running" && shell.body.background === true,
            `backgrounded shell should keep running: ${shell.text}`,
          )
          yield* ctx.request("POST", { path: `${path}/kill`, headers: ctx.headers() })
        }),
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/background", "session.background.idle")
    .seeded((ctx) => ctx.session({ title: "Idle background session" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/background", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      check(stable(body) === stable([]), "nothing should move when nothing blocks the session")
    }),
  http.protected
    .post("/session/{sessionID}/background", "session.background.missing")
    .at((ctx) => ({
      path: route("/session/{sessionID}/background", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .post("/session/{sessionID}/init", "session.init")
    .preserveDatabase()
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Init session" })
        const message = yield* ctx.message(session.id, { text: "initialize" })
        yield* ctx.llmText("initialized")
        yield* ctx.llmText("initialized")
        return { session, message }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/init", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
      body: { providerID: "test", modelID: "test-model", messageID: ctx.state.message.info.id },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        check(body === true, "init should return true")
        yield* ctx.llmWait(1)
      }),
    ),
  http.protected
    .post("/session/{sessionID}/message", "session.prompt")
    .preserveDatabase()
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "LLM prompt session" })
        yield* ctx.llmText("fake assistant")
        yield* ctx.llmText("fake assistant")
        return session
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/message", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: {
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text: "hello llm" }],
      },
    }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          object(body)
          check(isRecord(body.info) && body.info.role === "assistant", "prompt should return assistant message")
          check(
            Array.isArray(body.parts) && body.parts.some((part) => isRecord(part) && part.text === "fake assistant"),
            "assistant message should use fake LLM text",
          )
          yield* ctx.llmWait(1)
        }),
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/prompt_async", "session.prompt_async")
    .preserveDatabase()
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Async prompt session" })
        yield* ctx.llmText("fake async assistant")
        yield* ctx.llmText("fake async assistant")
        return session
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/prompt_async", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: {
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text: "hello async" }],
      },
    }))
    .status(204, (ctx) =>
      Effect.gen(function* () {
        yield* ctx.llmWait(1)
      }),
    ),
  http.protected
    .post("/session/{sessionID}/command", "session.command")
    .preserveDatabase()
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Command session" })
        yield* ctx.llmText("command done")
        yield* ctx.llmText("command done")
        return session
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/command", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { command: "init", arguments: "", model: "test/test-model" },
    }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          object(body)
          check(isRecord(body.info) && body.info.role === "assistant", "command should return assistant message")
          yield* ctx.llmWait(1)
        }),
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/shell", "session.shell")
    .preserveDatabase()
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Shell session" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/shell", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { agent: "build", model: { providerID: "test", modelID: "test-model" }, command: "printf shell-ok" },
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(isRecord(body.info) && body.info.role === "assistant", "shell should return assistant message")
        check(
          Array.isArray(body.parts) && body.parts.some((part) => isRecord(part) && part.type === "tool"),
          "shell should return a tool part",
        )
      },
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/summarize", "session.summarize")
    .preserveDatabase()
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Summarize session" })
        yield* ctx.message(session.id, { text: "summarize this work" })
        const summary = [
          "## Goal",
          "- Exercise session summarize.",
          "",
          "## Constraints & Preferences",
          "- Use fake LLM.",
          "",
          "## Progress",
          "### Done",
          "- Summary generated.",
          "",
          "### In Progress",
          "- (none)",
          "",
          "### Blocked",
          "- (none)",
          "",
          "## Key Decisions",
          "- Keep route local.",
          "",
          "## Next Steps",
          "- (none)",
          "",
          "## Critical Context",
          "- Test fixture.",
          "",
          "## Relevant Files",
          "- test/server/httpapi-exercise/index.ts: scenario",
        ].join("\n")
        yield* ctx.llmText(summary)
        yield* ctx.llmText(summary)
        return session
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/summarize", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { providerID: "test", modelID: "test-model", auto: false },
    }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          check(body === true, "summarize should return true")
          const messages = yield* ctx.messages(ctx.state.id)
          check(
            messages.some((message) => message.info.role === "assistant" && message.info.summary === true),
            "summarize should create a summary assistant message",
          )
          yield* ctx.llmWait(1)
        }),
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/revert", "session.revert")
    .mutating()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Revert session" })
        const message = yield* ctx.message(session.id, { text: "revert me" })
        return { session, message }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/revert", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
      body: { messageID: ctx.state.message.info.id },
    }))
    .json(
      200,
      (body, ctx) => {
        object(body)
        check(body.id === ctx.state.session.id, "revert should return the session")
        check(
          isRecord(body.revert) && body.revert.messageID === ctx.state.message.info.id,
          "revert should record reverted message",
        )
      },
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/unrevert", "session.unrevert")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Unrevert session" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/unrevert", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(
      200,
      (body, ctx) => {
        object(body)
        check(body.id === ctx.state.id, "unrevert should return the session")
      },
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/permissions/{permissionID}", "permission.respond")
    .seeded((ctx) => ctx.session({ title: "Deprecated permission session" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/permissions/{permissionID}", {
        sessionID: ctx.state.id,
        permissionID: "per_httpapi_deprecated",
      }),
      headers: ctx.headers(),
      body: { response: "once" },
    }))
    .json(404, object, "status"),
  http.protected
    .post("/session/{sessionID}/share", "session.share")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Share session" }))
    .at((ctx) => ({ path: route("/session/{sessionID}/share", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(
      200,
      (body, ctx) => {
        object(body)
        check(body.id === ctx.state.id, "share should return the session")
      },
      "status",
    ),
  http.protected
    .delete("/session/{sessionID}/share", "session.unshare")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Unshare session" }))
    .at((ctx) => ({ path: route("/session/{sessionID}/share", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(
      200,
      (body, ctx) => {
        object(body)
        check(body.id === ctx.state.id, "unshare should return the session")
      },
      "status",
    ),
  http.protected
    .post("/tui/append-prompt", "tui.appendPrompt")
    .at((ctx) => ({ path: "/tui/append-prompt", headers: ctx.headers(), body: { text: "hello" } }))
    .json(200, boolean, "status"),
  http.protected
    .post("/tui/select-session", "tui.selectSession.invalid")
    .at((ctx) => ({ path: "/tui/select-session", headers: ctx.headers(), body: { sessionID: "invalid" } }))
    .status(400),
  http.protected.post("/tui/open-help", "tui.openHelp").json(200, boolean, "status"),
  http.protected.post("/tui/open-sessions", "tui.openSessions").json(200, boolean, "status"),
  http.protected.post("/tui/open-themes", "tui.openThemes").json(200, boolean, "status"),
  http.protected.post("/tui/open-models", "tui.openModels").json(200, boolean, "status"),
  http.protected.post("/tui/submit-prompt", "tui.submitPrompt").json(200, boolean, "status"),
  http.protected.post("/tui/clear-prompt", "tui.clearPrompt").json(200, boolean, "status"),
  http.protected
    .post("/tui/execute-command", "tui.executeCommand")
    .at((ctx) => ({ path: "/tui/execute-command", headers: ctx.headers(), body: { command: "agent_cycle" } }))
    .json(200, boolean, "status"),
  http.protected
    .post("/tui/show-toast", "tui.showToast")
    .at((ctx) => ({
      path: "/tui/show-toast",
      headers: ctx.headers(),
      body: { title: "Exercise", message: "covered", variant: "info", duration: 1000 },
    }))
    .json(200, boolean, "status"),
  http.protected
    .post("/tui/publish", "tui.publish")
    .at((ctx) => ({
      path: "/tui/publish",
      headers: ctx.headers(),
      body: { type: "tui.prompt.append", properties: { text: "published" } },
    }))
    .json(200, boolean, "status"),
  http.protected
    .post("/tui/select-session", "tui.selectSession")
    .seeded((ctx) => ctx.session({ title: "TUI select" }))
    .at((ctx) => ({ path: "/tui/select-session", headers: ctx.headers(), body: { sessionID: ctx.state.id } }))
    .json(200, boolean, "status"),
  http.protected
    .post("/tui/control/response", "tui.control.response")
    .at((ctx) => ({ path: "/tui/control/response", headers: ctx.headers(), body: { ok: true } }))
    .json(200, boolean, "status"),
  http.protected
    .get("/tui/control/next", "tui.control.next")
    .mutating()
    .seeded((ctx) => ctx.tuiRequest({ path: "/tui/exercise", body: { text: "queued" } }))
    .json(
      200,
      (body) => {
        object(body)
        check(body.path === "/tui/exercise", "control next should return queued path")
        object(body.body)
        check(body.body.text === "queued", "control next should return queued body")
      },
      "status",
    ),
  http.protected
    .post("/global/upgrade", "global.upgrade")
    .global()
    .probe({ path: "/global/upgrade", body: { target: 1 } })
    .at(() => ({ path: "/global/upgrade", body: { target: 1 } }))
    .status(400),
]

const llmScenarios = new Set([
  "session.init",
  "session.prompt",
  "session.prompt_async",
  "session.command",
  "session.summarize",
])

const main = Effect.gen(function* () {
  yield* Effect.addFinalizer(() => cleanupExercisePaths)
  const options = parseOptions(Bun.argv.slice(2))
  const modules = yield* Effect.promise(() => runtime())
  const effectRoutes = routeKeys(OpenApi.fromApi(modules.PublicApi))
  const selected = selectedScenarios(options, scenarios)
  const missing = effectRoutes.filter((route) => !scenarios.some((scenario) => route === routeKey(scenario)))
  const extra = scenarios.filter((scenario) => !effectRoutes.includes(routeKey(scenario)))

  for (const scenario of scenarios) {
    if (scenario.kind === "active" && llmScenarios.has(scenario.name) && !scenario.project?.llm) {
      return yield* Effect.fail(new Error(`${scenario.name} must use TestLLMServer via .withLlm()`))
    }
  }

  printHeader(options, effectRoutes, selected, missing, extra, {
    database: exerciseDatabasePath,
    global: exerciseGlobalRoot,
  })

  const results =
    options.mode === "coverage"
      ? selected.map(coverageResult)
      : yield* Effect.forEach(
          selected,
          (scenario) =>
            Effect.gen(function* () {
              if (options.progress) console.log(`${color.dim}RUN ${routeKey(scenario)} ${scenario.name}${color.reset}`)
              return yield* runScenario(options)(scenario)
            }),
          { concurrency: 1 },
        )
  printResults(results, missing, extra)

  if (results.some((result) => result.status === "fail"))
    return yield* Effect.fail(new Error("one or more scenarios failed"))
  if (options.failOnSkip && results.some((result) => result.status === "skip"))
    return yield* Effect.fail(new Error("one or more scenarios are skipped"))
  if (options.failOnMissing && missing.length > 0)
    return yield* Effect.fail(new Error("one or more routes have no scenario"))
  return undefined
})

Effect.runPromise(main.pipe(Effect.provide(TestLLMServer.layer), Effect.scoped)).then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`${color.red}${message(error)}${color.reset}`)
    process.exit(1)
  },
)
