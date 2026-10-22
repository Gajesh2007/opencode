// Read-only AWS control-plane inspection. Do not print identity, request bodies,
// CloudTrail raw records, credential material, or log-destination names.
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
async function aws(args: string[]) {
  const child = Bun.spawn(
    ["aws", ...args, "--output", "json", "--cli-connect-timeout", "5", "--cli-read-timeout", "10"],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [text, error, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (status !== 0)
    return {
      error: error.match(/\(([A-Za-z]+Exception|AccessDenied|UnauthorizedOperation)\)/)?.[1] ?? "AWS request failed",
    }
  if (!text.trim()) return {}
  return record(JSON.parse(text))
}
const results = []
for (const region of ["us-east-1", "us-west-2"]) {
  const profiles = []
  for (const profile of ["us.openai.gpt-6.1-sol", "global.openai.gpt-6.1-sol", "us.openai.gpt-6-astra"]) {
    const result = await aws([
      "bedrock",
      "get-inference-profile",
      "--inference-profile-identifier",
      profile,
      "--region",
      region,
    ])
    profiles.push({
      profile,
      error: result.error,
      destinations: Array.isArray(result.models)
        ? [...new Set(result.models.map((model) => String(record(model).modelArn).split(":")[3] || "global-scope"))]
        : [],
    })
  }
  const logging = await aws(["bedrock", "get-model-invocation-logging-configuration", "--region", region])
  const history = await aws([
    "cloudtrail",
    "lookup-events",
    "--region",
    region,
    "--lookup-attributes",
    "AttributeKey=EventSource,AttributeValue=bedrock.amazonaws.com",
    "--start-time",
    new Date(Date.now() - 3 * 86400_000).toISOString(),
    "--max-results",
    "50",
    "--no-paginate",
  ])
  const events = Array.isArray(history.Events)
    ? history.Events.map((entry) => {
        const raw = record(entry).CloudTrailEvent
        return typeof raw === "string" ? record(JSON.parse(raw)) : {}
      })
    : []
  const calls = events.flatMap((event) => {
    const params = record(event.requestParameters)
    const extra = record(event.additionalEventData)
    const completion = record(record(record(event.serviceEventDetails).AdditionalEventData).additionalEntries)
    const model = params.modelId ?? params.model
    const inferenceRegion = extra.inferenceRegion ?? completion.inferenceRegion
    if (typeof model !== "string" || !/gpt-6(?:\.1-sol|-astra)/.test(model)) return []
    return [
      {
        time: event.eventTime,
        operation: event.eventName,
        category: event.eventType,
        model: model.split("/").at(-1),
        sourceRegion: event.awsRegion,
        inferenceRegion,
      },
    ]
  })
  const row = {
    sourceRegion: region,
    profiles,
    invocationLogging: { configurationReturned: !!logging.loggingConfig, error: logging.error },
    recentCloudTrail: {
      error: history.error,
      records: events.length,
      eventNames: [...new Set(events.map((event) => event.eventName))],
      routingCounts: calls.reduce(
        (counts, call) => {
          const key = `${call.sourceRegion} -> ${call.inferenceRegion ?? "unknown"}`
          counts[key] = (counts[key] ?? 0) + 1
          return counts
        },
        {} as Record<string, number>,
      ),
      matchingCalls: calls,
    },
  }
  results.push(row)
  console.log(
    JSON.stringify({ ...row, recentCloudTrail: { ...row.recentCloudTrail, matchingCalls: undefined } }, null, 2),
  )
}
if (process.env.BENCH_OUTPUT) {
  if (await Bun.file(process.env.BENCH_OUTPUT).exists()) throw new Error("Refusing to overwrite BENCH_OUTPUT")
  await Bun.write(
    process.env.BENCH_OUTPUT,
    JSON.stringify({ measuredAt: new Date().toISOString(), results }, null, 2) + "\n",
  )
}
