# Infrastructure Latency Investigation

The subsequent [local warming implementation](local-warming-2026-10-08.md)
increases idle retention to five minutes and adds guarded preconnection.

Measured on 2026-10-08 from the local machine. No cloud resources, logging
configuration, IAM policies, credentials, or production provider settings changed.

## Actual Inference Location

Read-only CloudTrail access succeeded. In the most recent 50 Bedrock events
queried per source region, matching Sol/Astra Responses API calls showed:

| API entry region | Matching calls | Reported inference region |
| ---------------- | -------------: | ------------------------- |
| us-east-1        |             24 | us-east-1                 |
| us-west-2        |             25 | us-east-1                 |

Thus the sampled western entry requests still executed in **Northern Virginia**.
This is stronger evidence than geolocating the public API IP, but identifies a
region, not a building, Availability Zone, rack, or GPU. The history query covers
one bounded page, not every invocation or a permanent routing commitment.

`GetInferenceProfile` confirmed that US Sol/Astra profiles can route to
`us-east-1`, `us-east-2`, and `us-west-2`. A global profile exposes global-scope
model ARNs; that is not an enumeration of every possible destination region.

For the sampled Responses calls, the actual region came from
`additionalEventData.inferenceRegion`. AWS also documents a nested
`serviceEventDetails.AdditionalEventData.additionalEntries.inferenceRegion`
field for stream-completion events. Do not count both the API-call event and its
stream-completion event as separate model requests.

## Edge and Network Measurements

Public unauthenticated HTTP probes isolated connection and edge-response costs
without running inference. Each endpoint used one curl process and four serial
requests; the final three reused its connection.

| Endpoint                  | First request through TLS | Warm response median | Status |
| ------------------------- | ------------------------: | -------------------: | -----: |
| OpenAI global             |                     209ms |                 98ms |    401 |
| OpenAI US                 |                      81ms |                176ms |    401 |
| OpenAI EU                 |                     536ms |                186ms |    401 |
| Codex                     |                     133ms |                131ms |    401 |
| Bedrock Runtime us-east-1 |                     232ms |                 69ms |    400 |
| Bedrock Runtime us-west-2 |                     119ms |                 31ms |    400 |
| Bedrock Mantle us-east-1  |                     360ms |                 66ms |    405 |
| Bedrock Mantle us-west-2  |                     236ms |                 31ms |    405 |

The first-request column includes DNS, TCP, TLS, and server response time. It is
not TLS duration alone. All these are **error-response timings, not model TTFT**.
Small samples, endpoint error handling, and routing make them unsuitable for
declaring an inference winner.

OpenAI and Codex responses carried a Cloudflare `SJC` edge suffix. Initial TCP
connections to that edge took roughly 10ms beyond DNS. This identifies an API
edge associated with San Jose, not the inference data center. The observed
suffix was also SJC for the EU host, demonstrating why an edge label cannot be
used as proof of model execution location or residency.

A separate HTTP/1.1 check returned approximately 100ms warm for global OpenAI,
71ms for eastern Runtime, and 33ms for western Runtime. There was no convincing
HTTP/2 benefit in these probes. Existing persistent WebSockets already avoid
most repeated connection setup on the optimized OpenAI path.

## Authenticated OpenAI Regional Check

Three tiny Sol Ultrafast requests to global `api.openai.com` all succeeded, with
median first text 749ms and total time 890ms. The responses exposed
`openai-processing-ms` values of 273-354ms. That header is useful telemetry,
but should not be blindly subtracted from complete streamed-response duration:
the quantities can cover different phases.

The same key against `us.api.openai.com` returned
`401 invalid_request_error:incorrect_hostname`. Therefore this account/project
cannot simply switch hostnames for regional processing. No EU inference calls
were attempted, and no account residency settings were changed.

OpenAI documents US and EU regional processing, subject to project/model
eligibility. Sol Ultrafast supports US/EU/global processing; Astra Ultrafast
supports US/global, not EU. A storage region alone does not prove inference runs
there. Supported regional processing carries a 10% pricing uplift.

## Highest-Value Next Experiments

1. **Run the complete agent near the measured backend.** Compare the same
   workload from the local machine, an existing us-east-1 host, and an existing
   us-west-2 host. Move the repo, tools, and model loop together; a proxy that
   leaves every tool round trip on the local machine can add latency instead.
   For Bedrock, us-east-1 is the first candidate because all 49 sampled matching
   requests executed there, not because its public endpoint had the lowest ping.
2. **Correlate routing with real inference latency.** Log request IDs, selected
   model/tier, returned tier, cache usage, headers/first-text/completion timing,
   and retry counts. Join Bedrock request IDs with CloudTrail asynchronously.
   Do not put CloudTrail queries on the interactive request path.
3. **Test regional OpenAI access only after eligibility is configured.** Request
   a suitable project/endpoint setup rather than treating a hostname change as
   an optimization toggle. Compare session-level runs to preserve cache and
   continuation affinity; do not switch regions on every turn.
4. **Consider private networking for jitter/control, not guaranteed speed.**
   Bedrock supports interface endpoints through AWS PrivateLink. OpenAI's
   enterprise Private Link uses Azure regional rails, currently South Central
   US, West US, East US 2, and Spain Central/EU. It requires onboarding and can
   still route among backing clusters. An AWS-to-Azure proxy may be slower.
5. **Measure socket reuse across realistic tool pauses.** The current pool has
   a 30-second idle TTL. Longer tests/builds can let it expire, losing connection
   and continuation warmth. A bounded 2-5-minute TTL experiment may help, but
   should track idle sockets, memory, reconnections, and stale-pointer fallbacks.

The network-only regional difference observed here was tens of milliseconds,
not several seconds. Benefits can accumulate across many sequential model/tool
turns, but should not be multiplied by total request count when calls overlap.
Server queueing, reasoning, output length, and cache behavior can still dominate.

Do not pin public anycast IPs, disable TLS verification, or infer private GPU
location from DNS/WHOIS. Do not enable full invocation logging merely to locate
inference: it can retain prompts and outputs, while CloudTrail metadata already
provided a location signal here.

## Reproduce

From `packages/opencode`:

```sh
BENCH_RUNS=4 bun run script/bench-network-latency.ts
BENCH_RUNS=4 BENCH_HTTP_VERSION=1.1 \
  BENCH_PATHS=openai-global,bedrock-east,bedrock-west \
  bun run script/bench-network-latency.ts
bun run script/inspect-inference-routing.ts
```

The routing inspection needs AWS CLI IAM credentials, not only a Bedrock bearer
token. It prints sanitized model/region metadata, not account identities,
credentials, raw CloudTrail records, or prompt/output content. It performs no
write API operations. `BENCH_OUTPUT` on either script saves to a new file.

The existing provider benchmark now accepts
`BENCH_OPENAI_REGION=global|us|eu` and records the endpoint and selected timing
headers. Its regional probes are billable if accepted; model/tier/region access
must be checked rather than assumed.

Artifacts under the approved temporary directory:

- `network-http2-20261008.json`
- `network-http1-20261008.json`
- `inference-routing-final-20261008.json`
- `openai-global-infra-probe-20261008.json`
- `openai-us-infra-probe-20261008.json`

## Sources

- [AWS cross-region routing and inferenceRegion](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html)
- [AWS CloudTrail event and stream-completion fields](https://docs.aws.amazon.com/bedrock/latest/userguide/logging-using-cloudtrail.html)
- [AWS Sol endpoint/profile support](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-1-sol.html)
- [OpenAI regional processing and eligibility](https://developers.openai.com/api/docs/guides/your-data)
- [OpenAI Private Link](https://developers.openai.com/api/docs/guides/private-link)
- [Bedrock PrivateLink](https://docs.aws.amazon.com/bedrock/latest/userguide/vpc-interface-endpoints.html)
- [Cloudflare Ray identifiers](https://developers.cloudflare.com/fundamentals/reference/cloudflare-ray-id/)
