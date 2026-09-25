/**
 * File-based logger for TUI debugging
 * 
 * Uses Effect's Logger.toFile to write logs to a file,
 * keeping the terminal UI clean while capturing all log output
 * for debugging purposes.
 */
import { Effect, FileSystem, Layer, Logger, References } from "effect"
import type { LogLevel, PlatformError } from "effect"
import * as path from "node:path"
import * as os from "node:os"

/**
 * Default log file path: ~/.repobase/tui.log
 */
const getDefaultLogPath = () => {
  const homeDir = os.homedir()
  return path.join(homeDir, ".repobase", "tui.log")
}

/**
 * Ensures the directory for the log file exists, creating it if necessary.
 */
const ensureLogDirectory = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = path.dirname(filePath)
    const exists = yield* fs.exists(dir)
    if (!exists) {
      yield* fs.makeDirectory(dir, { recursive: true })
    }
  })

/**
 * Creates a Layer that provides a file-based logger.
 * 
 * The logger writes logs in logfmt format to the specified file.
 * Logs are batched for efficiency (default: 500ms window).
 * 
 * @param logPath - Path to the log file (defaults to ~/.repobase/tui.log)
 * @param options - Logger options
 * @returns A Layer that replaces the default logger with a file logger.
 *   Requires a FileSystem (e.g. BunFileSystem.layer), so tests can supply an in-memory one.
 */
export const fileLoggerLayer = (
  logPath?: string,
  options?: {
    /** Minimum log level to capture (defaults to Debug) */
    minLevel?: LogLevel.LogLevel
    /** Batch window in ms (defaults to 500) */
    batchWindow?: number
  }
): Layer.Layer<never, PlatformError.PlatformError, FileSystem.FileSystem> => {
  const filePath = logPath ?? getDefaultLogPath()
  const minLevel = options?.minLevel ?? "Debug"
  const batchWindow = options?.batchWindow ?? 500

  // Create the file logger effect, ensuring the directory exists first
  const fileLogger = Effect.gen(function* () {
    yield* ensureLogDirectory(filePath)
    return yield* Logger.formatLogFmt.pipe(
      Logger.toFile(filePath, {
        flag: "a+",
        batchWindow
      })
    )
  })

  // Replace the default logger with our file logger, and apply the minimum log level
  return Layer.mergeAll(
    Logger.layer([fileLogger]),
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
  logPath?: string,
  options?: {
    minLevel?: LogLevel.LogLevel
    batchWindow?: number
  }
): Layer.Layer<never, PlatformError.PlatformError, FileSystem.FileSystem> => {
  const filePath = logPath ?? getDefaultLogPath()
  const batchWindow = options?.batchWindow ?? 500

  // Create the file logger effect, ensuring the directory exists first
  const fileLogger = Effect.gen(function* () {
    yield* ensureLogDirectory(filePath)
    return yield* Logger.formatLogFmt.pipe(
      Logger.toFile(filePath, {
        flag: "a+",
        batchWindow
      })
    )
  })

  return Logger.layer([fileLogger], { mergeWithExisting: true })
}

/**
 * Silent logger layer - completely suppresses all logging.
 * Use this when you don't want any log output at all.
 */
export const silentLoggerLayer: Layer.Layer<never> = Layer.succeed(References.MinimumLogLevel, "None")

/**
 * Get the default log file path
 */
export const defaultLogPath = getDefaultLogPath()

