import { describe, expect, it } from "@effect/vitest"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, Layer } from "effect"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { fileLoggerLayer } from "../src/file-logger.js"
import { telemetryLayer } from "../src/telemetry.js"

const startReceiver = () => {
  const received: Array<{ readonly path: string; readonly body: string }> = []
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      received.push({ path: new URL(request.url).pathname, body: await request.text() })
      return Response.json({})
    }
  })
  return { url: `http://127.0.0.1:${server.port}`, received, stop: () => server.stop(true) }
}

const runTraced = async (env: Record<string, string>) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repobase-telemetry-"))
  const logFile = path.join(dir, "test.log")
  await Effect.log("indexed a batch").pipe(
    Effect.withSpan("indexBatch", { attributes: { files: 50 } }),
    Effect.provide(
      telemetryLayer("repobase-test").pipe(
        Layer.provideMerge(fileLoggerLayer(logFile, { batchWindow: 10 })),
        Layer.provide(BunServices.layer),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))
      )
    ),
    Effect.runPromise
  )
  const log = await fs.readFile(logFile, "utf8")
  await fs.rm(dir, { recursive: true, force: true })
  return log
}

describe("telemetryLayer", () => {
  it("exports spans and logs to the OTLP endpoint, and still logs to the file", async () => {
    const receiver = startReceiver()
    try {
      const log = await runTraced({ OTEL_EXPORTER_OTLP_ENDPOINT: `${receiver.url}/` })

      const traces = receiver.received.filter((r) => r.path === "/v1/traces")
      const logs = receiver.received.filter((r) => r.path === "/v1/logs")
      expect(traces.map((r) => r.body).join()).toContain("indexBatch")
      expect(traces.map((r) => r.body).join()).toContain("repobase-test")
      expect(logs.map((r) => r.body).join()).toContain("indexed a batch")
      expect(log).toContain("indexed a batch")
    } finally {
      receiver.stop()
    }
  })

  it("exports nothing without an endpoint, or when disabled", async () => {
    const receiver = startReceiver()
    try {
      expect(await runTraced({})).toContain("indexed a batch")
      await runTraced({ OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url, OTEL_SDK_DISABLED: "true" })
      expect(receiver.received).toEqual([])
    } finally {
      receiver.stop()
    }
  })
})
