# GPT-6.1 Sol Report-Writing Benchmark

Measured on 2026-10-06, 23:52:00-23:58:09 UTC, using installed OpenCode
`1.18.34-bedrock.20261006`. This repeats the
[Astra report-writing workload](bedrock-report-regions.md) with GPT-6.1 Sol.

## Results

All 12 measured workflows passed: three serial trials for each of four Runtime
endpoint/profile combinations. Each workflow generated `report.md` with
`apply_patch` and completed its acknowledgement. Reports contained 999-1054
words, within the same 900-1100-word target used for Astra.

Values below are medians. First output measures the first report tool-argument
delta; generation time covers the entire report-generation request. Full CLI
time additionally includes startup, file writing, acknowledgement, and shutdown.

| Endpoint region | Requested profile | Tier     | Output tokens/s | First report output | Report generation | Full CLI |
| --------------- | ----------------- | -------- | --------------: | ------------------: | ----------------: | -------: |
| us-east-1       | US                | Standard |            68.9 |              22.27s |            22.76s |   27.47s |
| us-east-1       | Global            | Standard |            67.8 |              22.49s |            22.95s |   30.61s |
| us-west-2       | US                | Standard |            66.9 |              22.58s |            22.84s |   31.61s |
| us-west-2       | Global            | Standard |            69.6 |              21.99s |            22.26s |   32.46s |

| Endpoint region | Profile | Output tokens/s range | Generation seconds range | Report words range |
| --------------- | ------- | --------------------- | ------------------------ | ------------------ |
| us-east-1       | US      | 61.8-72.2             | 22.25-24.10              | 999-1054           |
| us-east-1       | Global  | 66.5-68.1             | 22.65-23.71              | 1012-1037          |
| us-west-2       | US      | 63.8-73.7             | 21.63-23.86              | 1002-1049          |
| us-west-2       | Global  | 67.1-71.1             | 21.97-23.12              | 1023-1030          |

These results do not establish a regional winner. Generation durations differ
little relative to the small sample size. Local startup varied substantially,
so CLI wall times should not be interpreted as backend decoding performance.

## Comparison With Astra

| Endpoint region | Profile | Sol standard tokens/s | Astra standard tokens/s | Astra Ultrafast tokens/s |
| --------------- | ------- | --------------------: | ----------------------: | -----------------------: |
| us-east-1       | US      |                  68.9 |                    61.9 |                    237.2 |
| us-east-1       | Global  |                  67.8 |                    64.0 |                    239.6 |
| us-west-2       | US      |                  66.9 |                    63.4 |                    238.2 |
| us-west-2       | Global  |                  69.6 |                    63.7 |                    223.2 |

Sol standard delivered about 6-11% higher median request-averaged throughput
than Astra standard on matched paths in these separate runs. That is a modest
observed difference, not a statistically established advantage. Astra Ultrafast
remained approximately 3.2-3.6x faster than Sol standard.

Sol's documented short-context US rates are $2.20 input, $0.11 cache read,
and $11 output per million tokens. Relative to Astra standard's US rates, input
and output are one-fifth the price, and cached reads are one-tenth. This is a
price comparison, not an invoice or a report-quality evaluation. The benchmark
checks completion, structure, and length; it does not establish equivalent
reasoning or coding quality.

## Availability Checks

- Both US and global profile IDs returned successful standard-tier responses through `us-east-1` and `us-west-2` Runtime endpoints. Measured responses returned the matching Sol model IDs and default tier.
- An Ultrafast probe using `us.openai.gpt-6.1-sol` at the eastern Runtime endpoint returned HTTP 400: `'ultrafast' is not supported for 'service_tier' on this model`. No Ultrafast performance numbers are reported for Sol.
- During the initial experiment, Mantle in `us-east-1` returned HTTP 401 saying the model subscription was being set up. A later access recheck failed certificate verification; verification was not bypassed. Access subsequently worked, allowing the Mantle follow-up below.
- The model-card snapshot retrieved during the initial experiment said a global inference profile was not offered, while live global requests and models.dev supported it. A later direct fetch of the AWS page documented `global.openai.gpt-6.1-sol`, resolving that documentation discrepancy.

The endpoint region is an API entry region, not proof of the physical inference
region. No subscriptions, provider defaults, installed binaries, or credentials
were changed for this benchmark.

## Reasoning And Caching

All calls used `reasoning.effort: "low"`, `forceReasoning: true`, and
`store: false`. Eleven report requests reported zero reasoning tokens; one
reported 25. The throughput calculation subtracts those 25 tokens. Zero reported
reasoning tokens does not establish that reasoning is disabled internally.

Every report request had 5046 input tokens and zero cached input tokens. Every
acknowledgement request reported 5044 cached tokens out of 6600-6717 total input
tokens, confirming automatic cache reads with stateless requests. This measures
cold-prefix report writing, not a warm long-context agent session.

## Mantle Follow-Up

Measured on 2026-10-07, 00:09:31-00:14:59 UTC, after Mantle access began working.
The same installed executable, brief, prompt, low reasoning, and output cap were
used. Three Mantle trials were interleaved with three fresh US Runtime controls,
all entering through `us-east-1` with standard service tier.

All six report-generation requests completed and wrote valid reports. The
report-only medians below include all three report requests on each path,
including one Runtime workflow whose acknowledgement later timed out.

| Path                | Report requests completed | Output tokens/s | First report argument | Report generation |
| ------------------- | ------------------------- | --------------: | --------------------: | ----------------: |
| Mantle, unprefixed  | 3/3                       |            68.3 |                22.17s |            22.67s |
| Runtime, US profile | 3/3                       |            69.8 |                21.98s |            22.39s |

Mantle throughput ranged from 68.2 to 75.5 tokens/s; report generation took
20.19-23.37s. Reports contained 1005-1044 words. Median full CLI completion was
24.86s, with a 22.12-25.39s range. All three complete Mantle workflows succeeded.

Runtime report throughput ranged from 67.3 to 70.1 tokens/s and generation took
21.95-23.55s. Its first report was successfully saved after 24.67s, but the
acknowledgement stream did not complete before the request timeout. The harness
blocked the attempted retry and retained the failed workflow at 206.70s. The
other two Runtime workflows completed in 23.91s and 24.31s. Do not interpret one
timeout in three trials as an established reliability difference.

The raw summary intentionally filters to fully successful workflows, so it
lists 2/3 successful Runtime workflows and slightly different Runtime medians
(69.9 tokens/s, 22.17s generation). The table above instead uses every validated
report-generation phase, without hiding the acknowledgement failure.

All six report-generation requests reported zero reasoning tokens and zero
cached input tokens. Each Mantle acknowledgement reported 5046 cached input
tokens out of 6641-6710 total input tokens, with `store: false`. Mantle therefore
showed normal prompt-cache reuse but no meaningful speed advantage over Runtime
in this task. It remained a standard-tier path, not a hidden Fast mode.

Artifacts, including all six reports and the retained failure:

```text
/var/folders/hv/5779vnmn5c564l3tdknlf4x80000gp/T/opencode/bedrock-sol61-mantle-comparison/
```

To repeat this two-path comparison, use the command below with a fresh existing
output directory and set:

```bash
BENCH_PATHS=runtime-us-east-1-us-default,mantle-us-east-1-default
```

## Method And Artifacts

The same sanitized repository brief was reused, with SHA-256:

```text
b3c1fe1e035b325afecf800c037b278eaca0f7d3aaad5df2bd9c587d0fc8410b
```

Writing instructions, seven required sections, the 3072-token per-request cap,
low reasoning effort, serial order rotation, and fresh isolated CLI processes
match the preceding Astra experiment. There were no explicit warmup report
trials. An interrupted setup run with an Astra-specific validation guard was
excluded; the guard was corrected before starting the fresh final matrix.

Throughput is `(output_tokens - reasoning_tokens) / report_request_seconds`,
including patch/JSON framing. Tool arguments arrived late in bursts; their
post-first-delta delivery rate is not treated as model decoding speed. The
acknowledgement is excluded from report throughput and included in full CLI time.

Raw results and all twelve generated reports remain under:

```text
/var/folders/hv/5779vnmn5c564l3tdknlf4x80000gp/T/opencode/bedrock-sol61-report-final/
```

Run from `packages/opencode`, using a fresh existing output directory and the
sanitized brief. This sends billable requests:

```bash
BENCH_MODEL=gpt-6.1-sol \
BENCH_DIR=/tmp/bedrock-sol61-report \
BENCH_CONTEXT=/tmp/bedrock-opencode-brief.md \
BENCH_RUNS=3 \
BENCH_PATHS=runtime-us-east-1-us-default,runtime-us-east-1-global-default,runtime-us-west-2-us-default,runtime-us-west-2-global-default \
bun run script/bench-bedrock-report.ts
```

References: [AWS Sol model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-1-sol.html),
[models.dev catalog](https://models.dev/api.json).
