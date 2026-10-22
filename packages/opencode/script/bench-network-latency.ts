// Public, unauthenticated probes only. HTTP error responses measure the network
// path and API edge, not model queueing, inference, or the physical GPU location.
const targets = [
  { name: "openai-global", url: "https://api.openai.com/v1/models" },
  { name: "openai-us", url: "https://us.api.openai.com/v1/models" },
  { name: "openai-eu", url: "https://eu.api.openai.com/v1/models" },
  { name: "codex", url: "https://chatgpt.com/backend-api/codex/models" },
  { name: "bedrock-east", url: "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/responses" },
  { name: "bedrock-west", url: "https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1/responses" },
  { name: "mantle-east", url: "https://bedrock-mantle.us-east-1.api.aws/openai/v1/responses" },
  { name: "mantle-west", url: "https://bedrock-mantle.us-west-2.api.aws/openai/v1/responses" },
]
const runs = Number(process.env.BENCH_RUNS ?? 4)
if (!Number.isInteger(runs) || runs < 2 || runs > 10) throw new Error("BENCH_RUNS must be 2-10")
const version = process.env.BENCH_HTTP_VERSION ?? "2"
if (version !== "2" && version !== "1.1") throw new Error("BENCH_HTTP_VERSION must be 2 or 1.1")
const filter = process.env.BENCH_PATHS?.split(",")
if (filter?.some((name) => !targets.some((target) => target.name === name))) throw new Error("Unknown BENCH_PATHS")
if (process.env.BENCH_OUTPUT && (await Bun.file(process.env.BENCH_OUTPUT).exists()))
  throw new Error("Refusing to overwrite BENCH_OUTPUT")
if (!Bun.which("curl")) throw new Error("curl is required")
const format =
  JSON.stringify({
    ip: "%{remote_ip}",
    http: "%{http_version}",
    status: "%{http_code}",
    connects: "%{num_connects}",
    dns: "%{time_namelookup}",
    tcp: "%{time_connect}",
    tls: "%{time_appconnect}",
    firstByte: "%{time_starttransfer}",
    total: "%{time_total}",
    edge: "%header{cf-ray}",
    server: "%header{server}",
  }) + "\n"
type Sample = {
  name: string
  trial: number
  status: number
  http: string
  connects: number
  ip: string
  dnsMs: number
  tcpMs: number
  tlsMs: number
  firstByteMs: number
  totalMs: number
  edge: string
  server: string
}
const samples: Sample[] = []
const errors: { name: string; exitCode: number }[] = []
const startedAt = new Date().toISOString()
for (const target of targets.filter((target) => !filter || filter.includes(target.name))) {
  // A single curl process reuses its connections across sequential requests.
  const process = Bun.spawn(
    [
      "curl",
      "--silent",
      "--show-error",
      "--max-time",
      "8",
      "--connect-timeout",
      "4",
      version === "2" ? "--http2" : "--http1.1",
      "--write-out",
      format,
      ...Array.from({ length: runs }, () => ["--output", "/dev/null", target.url]).flat(),
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, , exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) errors.push({ name: target.name, exitCode })
  stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .forEach((line, index) => {
      const value = JSON.parse(line) as Record<string, string>
      const sample = {
        name: target.name,
        trial: index + 1,
        status: Number(value.status),
        http: value.http,
        connects: Number(value.connects),
        ip: value.ip,
        dnsMs: Number(value.dns) * 1000,
        tcpMs: Number(value.tcp) * 1000,
        tlsMs: Number(value.tls) * 1000,
        firstByteMs: Number(value.firstByte) * 1000,
        totalMs: Number(value.total) * 1000,
        edge: value.edge,
        server: value.server,
      }
      samples.push(sample)
      console.log(JSON.stringify(sample))
    })
}
const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted.length
    ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2
    : null
}
const summary = targets
  .filter((target) => !filter || filter.includes(target.name))
  .map((target) => {
    const selected = samples.filter((sample) => sample.name === target.name)
    const warm = selected.filter((sample) => sample.connects === 0 && sample.status > 0)
    return {
      name: target.name,
      first: selected[0],
      warmSamples: warm.length,
      warmMedianFirstByteMs: median(warm.map((sample) => sample.firstByteMs)),
      warmMedianTotalMs: median(warm.map((sample) => sample.totalMs)),
    }
  })
console.log(JSON.stringify({ summary, errors }, null, 2))
if (process.env.BENCH_OUTPUT)
  await Bun.write(
    process.env.BENCH_OUTPUT,
    JSON.stringify(
      {
        startedAt,
        finishedAt: new Date().toISOString(),
        requestedHttp: version,
        measurement: "Unauthenticated edge responses, not inference; timings are cumulative from transfer start",
        summary,
        errors,
        samples,
      },
      null,
      2,
    ) + "\n",
  )
