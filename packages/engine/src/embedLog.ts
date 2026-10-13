import { Config, Effect, Option } from "effect"
import type { LogLevel } from "effect"

/**
 * Environment variable that sets how much the embedding stack (transformers.js
 * and the onnxruntime it runs on) logs
 */
export const EMBED_LOG_ENV = "REPOBASE_EMBED_LOG"

// onnxruntime's severity numbers
const SEVERITIES = { verbose: 0, info: 1, warning: 2, error: 3, fatal: 4 } as const

export type EmbedLogLevel = keyof typeof SEVERITIES

export interface EmbedLog {
  readonly level: EmbedLogLevel
  readonly severity: (typeof SEVERITIES)[EmbedLogLevel]
  readonly warning?: string
}

/**
 * Resolve the embedding stack's log level. It defaults to fatal because
 * onnxruntime writes straight to stderr, over the TUI, and a model run cut off
 * at shutdown fails with errors that say nothing new.
 */
export const resolveEmbedLog = (raw: string | undefined): EmbedLog => {
  const fallback: EmbedLog = { level: "fatal", severity: SEVERITIES.fatal }
  const value = raw?.trim().toLowerCase() ?? ""
  if (value === "") return fallback
  if (Object.hasOwn(SEVERITIES, value)) {
    const level = value as EmbedLogLevel
    return { level, severity: SEVERITIES[level] }
  }
  return {
    ...fallback,
    warning: `Ignoring ${EMBED_LOG_ENV}=${raw}: expected one of ${Object.keys(SEVERITIES).join(", ")}`
  }
}

/**
 * The embedding stack's log level from EMBED_LOG_ENV. Read as a string, so a bad
 * value warns and falls back instead of failing.
 */
export const hostEmbedLog: Effect.Effect<EmbedLog, Config.ConfigError> = Config.option(
  Config.String(EMBED_LOG_ENV)
).pipe(Effect.map((raw) => resolveEmbedLog(Option.getOrUndefined(raw))))

const LOG_LEVELS: Record<EmbedLogLevel, LogLevel.Severity> = {
  verbose: "Trace",
  info: "Info",
  warning: "Warn",
  error: "Error",
  fatal: "Fatal"
}

/**
 * The log level for an embedding stack message at `level`: its own level when
 * EMBED_LOG_ENV lets it through, otherwise Debug
 */
export const consoleLogLevel = (embedLog: EmbedLog, level: EmbedLogLevel): LogLevel.Severity =>
  SEVERITIES[level] >= embedLog.severity ? LOG_LEVELS[level] : "Debug"
