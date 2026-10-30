import { describe, it, expect } from "@effect/vitest"
import { ConfigProvider, Effect } from "effect"
import { consoleLogLevel, EMBED_LOG_ENV, hostEmbedLog, resolveEmbedLog } from "../src/embedLog.js"

describe("embed log level", () => {
  it.each([undefined, "", "  "])("defaults to fatal (%j)", (raw) => {
    expect(resolveEmbedLog(raw)).toEqual({ level: "fatal", severity: 4 })
  })

  it.each([
    { raw: "verbose", severity: 0 },
    { raw: "info", severity: 1 },
    { raw: "warning", severity: 2 },
    { raw: "error", severity: 3 },
    { raw: " Error ", severity: 3 }
  ])("maps $raw to onnxruntime severity $severity", ({ raw, severity }) => {
    expect(resolveEmbedLog(raw).severity).toBe(severity)
  })

  it.each(["loud", "toString"])("falls back to fatal with a warning for %s", (raw) => {
    const resolved = resolveEmbedLog(raw)
    expect(resolved.level).toBe("fatal")
    expect(resolved.warning).toContain(`${EMBED_LOG_ENV}=${raw}`)
  })

  it.each([
    { env: "fatal", level: "error", expected: "Debug" },
    { env: "error", level: "error", expected: "Error" },
    { env: "error", level: "warning", expected: "Debug" },
    { env: "info", level: "warning", expected: "Warn" }
  ] as const)("logs $level at $expected when set to $env", ({ env, level, expected }) => {
    expect(consoleLogLevel(resolveEmbedLog(env), level)).toBe(expected)
  })

  it.effect("reads the environment variable", () =>
    Effect.gen(function* () {
      const resolved = yield* hostEmbedLog
      expect(resolved.level).toBe("warning")
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { [EMBED_LOG_ENV]: "warning" } }))))
  )
})
