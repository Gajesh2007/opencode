# GPT-6 Astra on Bedrock

Measured on 2026-10-06, 23:16:32-23:19:12 UTC, from the local macOS client.

## Results

Five measured requests per path, one warmup per path. Values below are medians;
parentheses show the observed minimum and maximum, not confidence intervals.

| Path              | First visible token, s | Complete response, s | Effective visible output, tokens/s |
| ----------------- | ---------------------- | -------------------- | ---------------------------------- |
| Runtime standard  | 5.56 (2.96-10.39)      | 12.19 (9.73-16.28)   | 55.1 (39.0-73.9)                   |
| Runtime Ultrafast | 3.32 (1.76-3.93)       | 3.49 (2.84-4.15)     | 201.3 (165.0-259.4)                |
| Mantle standard   | 2.93 (1.96-3.91)       | 9.28 (8.36-10.07)    | 76.5 (69.2-87.1)                   |

Ultrafast provided about 3.7x Runtime standard's median effective throughput and
2.6x Mantle standard's. Its median complete-response time was about 71% lower than
Runtime standard's. Mantle standard had slightly better median first-token latency
than Ultrafast in this small sample, despite taking longer to finish.

All measured requests returned the requested service tier. No retries were enabled.
All reached the configured output cap, reporting 768 output tokens including
reasoning. Median non-reasoning output counts were 672, 703, and 697 respectively.
Every request reported 62 input tokens and zero cached input tokens.

These are single-request streaming API measurements, not concurrent serving
capacity, a quality evaluation, or complete OpenCode startup/tool-loop timings.

## Streaming Caveat

Effective visible throughput is:

```text
(output_tokens - reasoning_tokens) / total_request_seconds
```

The script also records delivery rate after the first text delta. Its medians were
106.8 tokens/s for Runtime standard, 113.7 for Mantle standard, and 3027.4 for
Runtime Ultrafast. The Ultrafast stream often delivered text in a short burst after
the initial wait. That last number is therefore not a credible measurement of
model decoding speed and should not be used for a speedup claim. End-to-end
throughput is the comparable metric above.

Median time to response headers was 0.482s for Runtime standard, 0.509s for
Runtime Ultrafast, and 0.258s for Mantle standard. Headers arriving does not mean
the model has produced visible text.

The excluded warmups used a 256-token cap. Their first-token/complete-response
times were 24.82s/26.21s, 2.02s/2.05s, and 3.01s/5.49s respectively. This highlights
the variability that a five-request sample cannot fully characterize.

## Method

- Region: `us-west-2`.
- Runtime model: `us.openai.gpt-6-astra`, using the US inference profile.
- Mantle model: `openai.gpt-6-astra`.
- API: OpenAI-compatible `/openai/v1/responses`, with streaming enabled.
- Reasoning: `low`, `forceReasoning: true`, summarized reasoning, `store: false`.
- Prompt: identical synthetic TypeScript utility-generation task on every request.
- Output cap: 768 tokens, including hidden reasoning.
- Order: serial requests, rotating the starting path each round.
- Client: Bun 1.3.14, the checkout's patched `@ai-sdk/openai@3.0.53` and AI SDK.
- Tier validation: the returned `service_tier` must match the requested tier.

Reasoning token counts varied even with the same prompt and effort. Differences
in reasoning, network conditions, routing, and queueing remain part of these
client-observed timings. Results do not establish a service-level guarantee.

## Availability And Cost

Runtime accepted `service_tier: "ultrafast"` without a special header. Mantle
rejected the same value with HTTP 400, both with and without the
`OpenAI-Service-Tier: ultrafast` header. Runtime with the header alone but no
`service_tier` body field returned the default tier.

At measurement time, the models.dev US catalog listed standard input/output at
$11/$55 per million tokens and Ultrafast at $66/$330, or 6x standard. The benchmark
alone used 12288 output tokens and 1116 input tokens across the 18 requests, for
an estimated $1.83 at those rates. This excludes setup and OpenCode smoke tests;
it is not an AWS billing statement.

## Reproduce

From `packages/opencode`, with a saved `amazon-bedrock` API key or
`AWS_BEARER_TOKEN_BEDROCK` set:

```bash
BENCH_RUNS=5 BENCH_OUTPUT_TOKENS=768 \
  BENCH_OUTPUT=/tmp/bedrock-astra-benchmark.json \
  bun run script/bench-bedrock-astra.ts
```

This makes billable calls. The script logs measurements, not credentials or
generated content. It records individual trials, warmups, and summary statistics
in the optional JSON output.
