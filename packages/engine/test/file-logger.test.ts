import { describe, expect, it, vi } from "vitest"
import { Effect, FileSystem, Layer, Path } from "effect"
import { fileLoggerLayer } from "../src/file-logger.js"

/**
 * In-memory FileSystem: records directories created and everything the
 * file logger writes, so nothing touches disk.
 */
const makeMemoryFileSystem = () => {
  const writes: string[] = []
  const directories: string[] = []
  const file = {
    writeAll: (buffer: Uint8Array) =>
      Effect.sync(() => {
        writes.push(new TextDecoder().decode(buffer))
      })
  } as unknown as FileSystem.File

  const layer = FileSystem.layerNoop({
    exists: () => Effect.succeed(false),
    makeDirectory: (path) => Effect.sync(() => directories.push(path)),
    open: () => Effect.succeed(file)
  })

  return { writes, directories, layer, output: () => writes.join("") }
}

// Same composition as main.tsx: the logger must be part of the layer's output
const appLayer = (fileLogger: ReturnType<typeof fileLoggerLayer>, fs: Layer.Layer<FileSystem.FileSystem>) =>
  Layer.empty.pipe(Layer.provideMerge(fileLogger), Layer.provide(Layer.merge(fs, Path.layer)))

describe("fileLoggerLayer", () => {
  it("writes logs to the log file and not the console", async () => {
    const fs = makeMemoryFileSystem()
    const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {})
    )

    try {
      await Effect.runPromise(
        Effect.log("TUI starting").pipe(
          Effect.provide(appLayer(fileLoggerLayer("/logs/tui.log"), fs.layer))
        )
      )
      for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of consoleSpies) spy.mockRestore()
    }

    expect(fs.directories).toEqual(["/logs"])
    expect(fs.output()).toContain('message="TUI starting"')
    expect(fs.output()).toContain("level=INFO")
  })

  it("respects the minimum log level", async () => {
    const fs = makeMemoryFileSystem()

    await Effect.runPromise(
      Effect.logInfo("hidden").pipe(
        Effect.andThen(Effect.logWarning("shown")),
        Effect.provide(appLayer(fileLoggerLayer("/logs/tui.log", { minLevel: "Warn" }), fs.layer))
      )
    )

    expect(fs.output()).toContain("shown")
    expect(fs.output()).not.toContain("hidden")
  })
})
