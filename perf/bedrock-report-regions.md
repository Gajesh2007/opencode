# Bedrock Astra Report-Writing Benchmark

## Results

Completed on 2026-10-06 at 23:40:18 UTC. All 27 report-writing workflows passed:
three trials for each of nine paths, with 54 successful model requests including
acknowledgements. The separate setup pilot is excluded from these statistics.
The installed executable was `1.18.34-bedrock.20261006` throughout the run.

All times below are median seconds; throughput is the median of per-request
non-reasoning output-token rates. The first-output column measures the first
report tool-argument delta, not first internal decoding or first body byte.

| AWS entry endpoint | Profile    | Tier      | Output tokens/s | First report output | Report request | Full CLI |
| ------------------ | ---------- | --------- | --------------: | ------------------: | -------------: | -------: |
| Runtime us-east-1  | US         | Standard  |            61.9 |               24.17 |          24.51 |    28.82 |
| Runtime us-east-1  | US         | Ultrafast |           237.2 |                6.06 |           6.51 |     8.87 |
| Runtime us-east-1  | Global     | Standard  |            64.0 |               23.82 |          24.21 |    33.54 |
| Runtime us-east-1  | Global     | Ultrafast |           239.6 |                6.05 |           6.47 |     9.80 |
| Runtime us-west-2  | US         | Standard  |            63.4 |               23.73 |          23.92 |    28.56 |
| Runtime us-west-2  | US         | Ultrafast |           238.2 |                6.21 |           6.39 |    13.10 |
| Runtime us-west-2  | Global     | Standard  |            63.7 |               23.89 |          24.16 |    28.92 |
| Runtime us-west-2  | Global     | Ultrafast |           223.2 |                6.53 |           6.96 |    13.34 |
| Mantle us-west-2   | Unprefixed | Standard  |            75.3 |               20.02 |          20.08 |    22.06 |

Ultrafast's median request-averaged throughput was approximately 3.5-3.8x
standard for the corresponding Runtime endpoint/profile pairs. US versus
global and eastern versus western entry endpoints showed much smaller
differences than the service tier. These three-trial measurements do not
establish a stable best region. Global routing was not consistently faster.

The four standard Runtime paths were approximately 61.9-64.0 tokens/s; the
Ultrafast paths were 223.2-239.6 tokens/s. Mantle standard was 75.3 tokens/s in
this workload, faster than Runtime standard but slower than Runtime Ultrafast.

### Observed Ranges

| AWS entry endpoint | Profile    | Tier      | Output tokens/s range | Report-request seconds range | Report words range |
| ------------------ | ---------- | --------- | --------------------- | ---------------------------- | ------------------ |
| Runtime us-east-1  | US         | Standard  | 60.6-63.4             | 24.46-25.11                  | 997-1018           |
| Runtime us-east-1  | US         | Ultrafast | 191.5-237.9           | 6.43-7.99                    | 1000-1019          |
| Runtime us-east-1  | Global     | Standard  | 63.3-64.9             | 23.94-24.51                  | 1015-1016          |
| Runtime us-east-1  | Global     | Ultrafast | 151.7-249.6           | 6.13-10.02                   | 994-1016           |
| Runtime us-west-2  | US         | Standard  | 60.9-65.6             | 23.39-25.17                  | 998-1020           |
| Runtime us-west-2  | US         | Ultrafast | 232.4-244.5           | 6.35-6.59                    | 992-1036           |
| Runtime us-west-2  | Global     | Standard  | 59.2-65.7             | 23.68-25.57                  | 990-1021           |
| Runtime us-west-2  | Global     | Ultrafast | 204.4-236.1           | 6.59-7.58                    | 1003-1029          |
| Mantle us-west-2   | Unprefixed | Standard  | 74.8-80.7             | 18.64-20.37                  | 986-1001           |

Every report was within the requested 900-1100-word range. Twenty-four report
requests reported zero reasoning tokens; the other three reported 30, 32,
and 40. These were subtracted when calculating the output rates. Reasoning was
configured to `low`, not disabled.

Full CLI time includes variable local startup and acknowledgement latency.
For example, the second eastern/global/standard trial saved its report after
27.42s but did not finish the CLI workflow until 51.02s. Its report-generation
request itself took 23.94s. That delay was not counted as slower report generation.

### Caching

The initial report requests used new per-trial directories and had zero cached
input tokens. The follow-up acknowledgements did reuse the prefix, reporting
roughly 5040-5043 cached tokens out of approximately 6600 input tokens. This
confirms automatic prompt-cache reads with `store: false`, including Ultrafast.
It also means the report-generation table describes cold-prefix writes, not
fully cached long-running sessions.

Cache hits discount input processing, not newly generated output. The catalog
lists US standard input/cache-read/output at $11/$1.10/$55 per million tokens,
and US Ultrafast at $66/$6.60/$330. Global rates are $10/$1/$50 and $60/$6/$300.
Thus cached Ultrafast input is discounted 90% relative to Ultrafast input, but
is still priced six times standard cached input. Local cost estimates are not
an AWS invoice, and the benchmark's base-model metadata should not be used as
Ultrafast billing data merely because the request selected that service tier.

## Scope

This experiment runs the installed OpenCode CLI and asks GPT-6 Astra to create a
900-1100 word Markdown engineering report about the OpenCode repository. Each
trial receives the same sanitized, source-grounded evidence brief, writes
`report.md` using `apply_patch`, and then acknowledges success. The report is
about the local checkout, but this is a controlled writing task, not a fresh
repository exploration or an independent code audit on every run.

The matrix compares:

- Runtime entry endpoints in `us-east-1` and `us-west-2`.
- US-only (`us.openai.gpt-6-astra`) and global (`global.openai.gpt-6-astra`) inference profiles.
- Standard (`service_tier: "default"`) and Ultrafast (`"ultrafast"`) service tiers.
- Mantle in `us-west-2`, with the unprefixed `openai.gpt-6-astra` model and standard service tier, as a separate baseline.

`default` is a service tier, not a geographic routing choice. The US inference
profile can route within the US; it does not pin execution to a single region.
An endpoint region identifies the AWS API entry point, not the undisclosed
physical inference backend. Global routing is not automatically the default.

## Live Preconditions

- Astra rejected `reasoning.effort: "none"` with HTTP 400. Supported values in the response were `low`, `medium`, `high`, `xhigh`, and `max`.
- Runtime rejected unprefixed `openai.gpt-6-astra` with HTTP 400, requiring an inference profile.
- Both US and global profiles accepted Ultrafast through the eastern and western US Runtime endpoints.
- Mantle had rejected Ultrafast in the preceding experiment, so it is not included as a supported Ultrafast path.

All report-writing requests therefore use `low` reasoning, not disabled
reasoning. Actual reported reasoning-token usage is measured separately.
Writing prose or code does not by itself disable a model's reasoning control.

## Method

The driver is `packages/opencode/script/bench-bedrock-report.ts`. Each trial
launches the real installed `opencode` executable with isolated configuration,
state, credentials, and database directories. Only the report-writing tool is
available. External plugins, MCP servers, skills, snapshots, formatters, and LSP
are disabled. No application source or global configuration is modified.

A loopback-only authenticated proxy forwards the OpenAI Responses request body
unchanged to its fixed AWS destination. It records streaming event arrival
times and usage, without retaining credential headers, request bodies, or
generated tool arguments in the metrics. The actual Markdown report remains
in the trial directory. The proxy validates the model, tier, low reasoning,
token limit, tool inventory, completion status, and returned tier.

The two phases are measured separately: the request that generates the report
inside `apply_patch` arguments, and the final acknowledgement. At most two
upstream requests are forwarded; retries and extra tool rounds fail the trial
rather than being hidden in the timings.

There are three serial trials per path, with a rotating starting path each
round, no explicit warmups, and a fresh CLI process each time. The output cap is
3072 tokens per model request. The target report has seven prescribed sections.
Validation requires a successful patch, a nontrivial report containing those
sections, and a completed acknowledgement. Actual word counts are also
retained, because the model is not forced to generate an exact number of words.

## Metric Definitions

- **First report argument:** time from the proxy receiving the model request to the first `response.function_call_arguments.delta`. This can start with JSON/patch framing, not a prose word.
- **Report request:** time from proxy receipt to report-generation stream EOF. It excludes CLI startup, actual filesystem writing, and the acknowledgement request.
- **Report output tokens/s:** `(output_tokens - reasoning_tokens) / report_request_seconds`. This includes tool-call/patch framing as well as the document content.
- **Report words/s:** actual Markdown whitespace-delimited word count divided by report-request duration.
- **Report saved:** elapsed time from CLI launch until the successful editing-tool event is observed.
- **CLI wall time:** process launch through process exit, including startup, the report request, file writing, acknowledgement, and shutdown.

The post-first-delta delivery rate is also retained in raw metrics, but it is
not used as model decoding throughput. Providers can buffer tool arguments and
deliver most of the report in a late burst. First body bytes can arrive much
earlier as non-content SSE events.

## Interpretation Limits

Use medians of the per-trial rates, not ratios of independently aggregated
medians. Three trials support descriptive observations, not stable rankings,
tail-latency estimates, or claims of statistical significance. The rotating
order is not a fully counterbalanced or randomized experiment.

The source brief and writing instructions are fixed; full requests can still
vary with the model ID, trial directory, and generated document. Fresh local
state does not reset upstream caches or the benchmark parent's connection
pools. Report-phase cached input tokens must be considered separately from
acknowledgement cache hits.

A failed acknowledgement marks its whole workflow failed even if the report
was generated. Failures and completed report metrics are retained; successful
workflow statistics should be accompanied by attempt/success counts. Zero
reported reasoning tokens is not proof about unobserved internal computation.

## Reproduce

From `packages/opencode`, set a fresh temporary output directory and the path
to a sanitized repository brief. A stored Bedrock API key or
`AWS_BEARER_TOKEN_BEDROCK` is required. This makes billable requests.

```bash
BENCH_DIR=/tmp/bedrock-report-matrix \
  BENCH_CONTEXT=/tmp/bedrock-opencode-brief.md \
  BENCH_RUNS=3 \
  bun run script/bench-bedrock-report.ts
```

The output directory and context file must already exist. `BENCH_PATHS` can
select comma-separated matrix names such as `runtime-us-west-2-us-default`
and `runtime-us-west-2-us-ultrafast`. The driver refuses existing results/trial
directories instead of overwriting them. It saves the measurements to
`results.json` after each trial and keeps every generated `report.md`.
