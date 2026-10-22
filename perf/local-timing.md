# Local Timing Records

OpenCode stores metadata-only execution timings in `session_timing` in its local
SQLite database. This is the same database used for sessions, including any
configured database path or release-channel suffix. It is not browser storage
and nothing is uploaded. No UI or additional reporting service is required.

Collection is enabled by default. Set `OPENCODE_DISABLE_TIMING=true` before
starting OpenCode to disable it. Existing records are not deleted by the flag.

## Records

Rows contain an execution ID, session ID, root session ID, step/message ID,
recording time, phase, and versioned metadata. Request, tool call, permission
wait, and shell-command IDs connect related records within an execution. A new
execution gets a new UUID even when a message ID is reused. Forking a transcript
does not copy execution history.

The metadata includes the build version, available selected/returned model and tier
identifiers, reasoning variant, runtime, purpose, outcome, exit code, and monotonic elapsed
times. It does not contain prompts, command text, command arguments, working
directories, tool results, file contents, credentials, or raw provider errors.
Usage and cost accounting remain in `session_usage`; timings are not a billing
ledger.

| Phase                                                | Meaning                                                                                                                                                                                   |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execution_start`                                    | Start marker for one assistant step, auxiliary call, or direct shell execution.                                                                                                           |
| `preparation`                                        | Observed preparation since that execution started, not the entire user turn.                                                                                                              |
| `request_start` / `request`                          | Start and duration of one logical application request attempt, including any work inside it.                                                                                              |
| `request_prepared`                                   | The application has prepared provider options; not evidence of a network send.                                                                                                            |
| `first_text` / `first_reasoning`                     | First nonempty normalized text/reasoning delta observed by the application, separately latched per request.                                                                               |
| `first_useful`                                       | Existing assistant-step signal: first nonblank text or complete tool call.                                                                                                                |
| `tool_input_start` / `tool_ready`                    | Observed streamed input start and complete call arguments. Input duration is absent when the start was not observed.                                                                      |
| `tool_start` / `tool`                                | Tool-wrapper start and duration, including hooks, permissions, execution and result handling.                                                                                             |
| `approval_start` / `approval`                        | Actual pending permission wait. Automatically allowed/denied checks do not invent a user wait.                                                                                            |
| `command_start` / `command_first_output` / `command` | Local process attempt, first observed output, and outcome after output drain/process cleanup. Transcript persistence remains in the wrapper/overall duration. Command text is not copied. |
| `overall`                                            | Execution completion or interruption.                                                                                                                                                     |

Start markers have no invented duration. Starts without matching completion
records are incomplete observations, not zero-duration successes. Timing uses
`performance.now()` within one process; the database recording timestamp is for
search and retention, not for subtracting unrelated clocks.

The current model observations are explicitly **logical/application-observed**.
They do not claim DNS/TLS timing, first network byte, frontend paint time, or a
separate row for every retry hidden inside a provider SDK. A `dispatch` phase is
reserved for an actual instrumented dispatch boundary; request preparation is
not relabeled as dispatch. First-text latency must be interpreted using its
stored anchor and scope, not advertised as wire-level TTFT.

Ordinary assistant steps, shared-service auxiliary LLM calls, tool invocations,
and direct user shell commands are covered. Work outside those paths, such as
standalone agent generation or separate cache prewarming, is not made to appear
covered by synthesizing records.

## Retention And Failure

- Rows older than 30 days are removed on the first write batch and periodically
  during activity. The table is also capped at 100,000 retained rows.
- The writer buffers at most 128 records and normally flushes after 50 ms.
  Execution completion flushes immediately; normal process exit also flushes.
- A hard crash can lose an unfinished pending batch. Storage errors are
  best-effort and must not fail commands or model work.
- A contended timing write is dropped instead of using the application's normal
  multi-second SQLite busy wait. The connection's original timeout is restored.
- Closing or changing the active database discards stale buffered records rather
  than reopening an old database or writing them into a new one.
- Root-session deletion removes its timing history. Child deletion does not
  discard the retained root task's execution records.
- Retention caps rows, not allocated SQLite/WAL bytes or other session data.

## Querying

Use a local SQLite client against the applicable OpenCode database. For example:

```sql
SELECT session_id, step_id, execution_id, phase,
       json_extract(data, '$.durationMs') AS duration_ms,
       json_extract(data, '$.modelID') AS selected_model,
       json_extract(data, '$.status') AS status
FROM session_timing
ORDER BY time_created DESC, rowid DESC
LIMIT 100;
```

Group comparisons by model, tier, effort, runtime and purpose, and retain errors,
cancellations and missing observations. Parallel tool durations overlap: their
sum is not elapsed task time. A completed execution is not independent proof
that the user's requested outcome was correct.
