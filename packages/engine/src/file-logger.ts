/**
 * File-based logger for the TUI and its worker threads
 *
 * Writes logs in logfmt format to a file, keeping the terminal UI clean while
 * capturing all log output for debugging purposes.
 */
import { Effect, FileSystem, Layer, Logger, Path, PlatformError, References } from "effect"
import type { LogLevel, Scope } from "effect"
import * as nodeFs from "node:fs"
import * as nodePath from "node:path"
import * as os from "node:os"

/**
 * Log file path for a component: ~/.repobase/<name>.log
 */
export const logPath = (name: string) => nodePath.join(os.homedir(), ".repobase", `${name}.log`)

/**
 * Ensures the directory for the log file exists, creating it if necessary.
 */
const ensureLogDirectory = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = path.dirname(filePath)
    const exists = yield* fs.exists(dir)
    if (!exists) {
      yield* fs.makeDirectory(dir, { recursive: true })
    }
  })

/**
 * A logger that appends each line to the file as it's logged. The TUI exits
 * without closing its own or its worker threads' scopes (see shutdown.ts), so a
 * batched logger would lose whatever it hadn't written yet.
 */
const fileLogger = (
  filePath: string
): Effect.Effect<Logger.Logger<unknown, void>, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path | Scope.Scope> =>
  Effect.gen(function* () {
    yield* ensureLogDirectory(filePath)
    const fd = yield* Effect.acquireRelease(
      Effect.try({
        try: () => nodeFs.openSync(filePath, "a"),
        catch: (cause) =>
          PlatformError.systemError({ _tag: "Unknown", module: "FileLogger", method: "open", pathOrDescriptor: filePath, cause })
      }),
      (fd) => Effect.sync(() => nodeFs.closeSync(fd))
    )
    return Logger.formatLogFmt.pipe(
      Logger.map((line) => {
        try {
          nodeFs.writeSync(fd, `${line}\n`)
        } catch {
          // A log line that can't be written is dropped, like Logger.toFile does
        }
      })
    )
  })

/**
 * Creates a Layer that provides a file-based logger.
 *
 * @param filePath - Path to the log file (see `logPath`)
 * @param options - Logger options
 * @returns A Layer that replaces the default logger with a file logger.
 *   Requires a FileSystem (e.g. BunFileSystem.layer) and a Path (e.g. Path.layer).
 */
export const fileLoggerLayer = (
  filePath: string,
  options?: {
    /** Minimum log level to capture (defaults to Debug) */
    minLevel?: LogLevel.LogLevel
  }
): Layer.Layer<never, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> => {
  const minLevel = options?.minLevel ?? "Debug"

  // Replace the default logger with our file logger, and apply the minimum log level
  return Layer.mergeAll(
    Logger.layer([fileLogger(filePath)]),
    Layer.succeed(References.MinimumLogLevel, minLevel)
  )
}

/**
 * A simpler approach: just write logs to file without replacing the default logger.
 * This adds file logging in addition to any existing loggers.
 *
 * Note: For TUI, we typically want to REPLACE the default logger to avoid
 * console output interfering with the UI.
 */
export const addFileLoggerLayer = (
  filePath: string
): Layer.Layer<never, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Logger.layer([fileLogger(filePath)], { mergeWithExisting: true })

/**
 * Silent logger layer - completely suppresses all logging.
 * Use this when you don't want any log output at all.
 */
export const silentLoggerLayer: Layer.Layer<never> = Layer.succeed(References.MinimumLogLevel, "None")
