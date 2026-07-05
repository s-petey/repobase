import { FileSystem, PlatformLogger } from "@effect/platform"
import { BunFileSystem } from "@effect/platform-bun"
import { Effect, Layer, Logger, LogLevel } from "effect"
import * as path from "node:path"
import * as os from "node:os"

const getDefaultLogPath = () => {
  return path.join(os.homedir(), ".repobase", "tui.log")
}

const ensureLogDirectory = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = path.dirname(filePath)
    const exists = yield* fs.exists(dir)
    if (!exists) {
      yield* fs.makeDirectory(dir, { recursive: true })
    }
  })

export const fileLoggerLayer = (
  logPath?: string,
): Layer.Layer<never, Error, never> => {
  const filePath = logPath ?? getDefaultLogPath()

  const fileLogger = Effect.gen(function* () {
    yield* ensureLogDirectory(filePath)
    return yield* Logger.logfmtLogger.pipe(
      PlatformLogger.toFile(filePath, {
        flag: "a+",
        batchWindow: 500,
      }),
    )
  })

  return Logger.replaceScoped(Logger.defaultLogger, fileLogger).pipe(
    Layer.provide(BunFileSystem.layer),
    Layer.provideMerge(Logger.minimumLogLevel(LogLevel.Debug)),
  )
}

export const defaultLogPath = getDefaultLogPath()
