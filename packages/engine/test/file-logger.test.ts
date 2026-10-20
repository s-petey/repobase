import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { fileLoggerLayer } from "../src/file-logger.js"

// Same composition as main.tsx: the logger must be part of the layer's output
const appLayer = (fileLogger: ReturnType<typeof fileLoggerLayer>) =>
  Layer.empty.pipe(Layer.provideMerge(fileLogger), Layer.provide(BunServices.layer))

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "repobase-file-logger-"))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("fileLoggerLayer", () => {
  it("writes logs to the log file and not the console", async () => {
    const logFile = path.join(dir, "logs", "tui.log")
    const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {})
    )

    try {
      await Effect.runPromise(Effect.log("TUI starting").pipe(Effect.provide(appLayer(fileLoggerLayer(logFile)))))
      for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of consoleSpies) spy.mockRestore()
    }

    const output = await fs.readFile(logFile, "utf8")
    expect(output).toContain('message="TUI starting"')
    expect(output).toContain("level=INFO")
  })

  it("writes each line before the layer is closed", async () => {
    const logFile = path.join(dir, "worker.log")

    const output = await Effect.runPromise(
      Effect.logInfo("indexed a batch").pipe(
        Effect.andThen(Effect.promise(() => fs.readFile(logFile, "utf8"))),
        Effect.provide(appLayer(fileLoggerLayer(logFile)))
      )
    )

    expect(output).toContain("indexed a batch")
  })

  it("respects the minimum log level", async () => {
    const logFile = path.join(dir, "tui.log")

    await Effect.runPromise(
      Effect.logInfo("hidden").pipe(
        Effect.andThen(Effect.logWarning("shown")),
        Effect.provide(appLayer(fileLoggerLayer(logFile, { minLevel: "Warn" })))
      )
    )

    const output = await fs.readFile(logFile, "utf8")
    expect(output).toContain("shown")
    expect(output).not.toContain("hidden")
  })
})
