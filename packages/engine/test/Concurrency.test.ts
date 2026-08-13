import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect } from "effect"
import * as os from "os"
import {
  computeConcurrencyLimit,
  maxConcurrencyConfig,
  MAX_CONCURRENCY_ENV,
} from "../src/services/Concurrency.js"

const defaultLimit = computeConcurrencyLimit(os.cpus().length)

const resolveWith = (env: Record<string, string>) =>
  Effect.withConfigProvider(
    ConfigProvider.fromMap(new Map(Object.entries(env)))
  )(maxConcurrencyConfig)

describe("computeConcurrencyLimit", () => {
  it("uses the core count when within range", () => {
    expect(computeConcurrencyLimit(2)).toBe(2)
    expect(computeConcurrencyLimit(3)).toBe(3)
  })

  it("caps at the maximum", () => {
    expect(computeConcurrencyLimit(8)).toBe(4)
    expect(computeConcurrencyLimit(64)).toBe(4)
  })

  it("floors at 1", () => {
    expect(computeConcurrencyLimit(0)).toBe(1)
    expect(computeConcurrencyLimit(-3)).toBe(1)
  })

  it("respects a custom max", () => {
    expect(computeConcurrencyLimit(8, 6)).toBe(6)
    expect(computeConcurrencyLimit(2, 6)).toBe(2)
  })
})

describe("maxConcurrencyConfig", () => {
  it.effect("honors a valid REPOBASE_MAX_CONCURRENCY override", () =>
    Effect.gen(function* () {
      expect(yield* resolveWith({ [MAX_CONCURRENCY_ENV]: "2" })).toBe(2)
    })
  )

  it.effect("falls back to cores when the env var is absent", () =>
    Effect.gen(function* () {
      expect(yield* resolveWith({})).toBe(defaultLimit)
    })
  )

  it.effect("ignores a non-numeric env value", () =>
    Effect.gen(function* () {
      expect(yield* resolveWith({ [MAX_CONCURRENCY_ENV]: "abc" })).toBe(
        defaultLimit
      )
    })
  )

  it.effect("ignores a zero or negative env value", () =>
    Effect.gen(function* () {
      expect(yield* resolveWith({ [MAX_CONCURRENCY_ENV]: "0" })).toBe(
        defaultLimit
      )
      expect(yield* resolveWith({ [MAX_CONCURRENCY_ENV]: "-1" })).toBe(
        defaultLimit
      )
    })
  )

  it.effect("ignores a non-integer env value", () =>
    Effect.gen(function* () {
      expect(yield* resolveWith({ [MAX_CONCURRENCY_ENV]: "2.5" })).toBe(
        defaultLimit
      )
    })
  )

  it.effect("ignores an empty env value", () =>
    Effect.gen(function* () {
      expect(yield* resolveWith({ [MAX_CONCURRENCY_ENV]: "" })).toBe(
        defaultLimit
      )
    })
  )
})
