import { Clock, Effect } from "effect"

// Debug-only: how responsive the main (render) thread is while jobs run
export const LAG_ENV = "REPOBASE_DEBUG_LAG"

/** Main-thread lag above this makes rendering and input feel sluggish */
export const LAG_BUDGET_MS = 50

const TICK_MS = 100
const TICKS_PER_REPORT = 50 // one summary every 5 seconds

export interface LagSummary {
  readonly samples: number
  readonly maxMs: number
  readonly p95Ms: number
  readonly overBudget: number
}

/**
 * Max, 95th percentile and count over LAG_BUDGET_MS of a window of lag samples
 */
export const summarizeLag = (lags: ReadonlyArray<number>): LagSummary => {
  const sorted = [...lags].sort((a, b) => a - b)
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
  return {
    samples: sorted.length,
    maxMs: sorted.at(-1) ?? 0,
    p95Ms: at(0.95),
    overBudget: sorted.filter((lag) => lag > LAG_BUDGET_MS).length
  }
}

/**
 * Wake up every TICK_MS and record how late each wake-up is: a busy main thread
 * delays timers. Logs a summary of each window to the TUI log; runs until interrupted.
 */
export const lagSampler = Effect.gen(function* () {
  let lags: Array<number> = []
  let expected = (yield* Clock.currentTimeMillis) + TICK_MS

  while (true) {
    yield* Effect.sleep(TICK_MS)
    const now = yield* Clock.currentTimeMillis
    lags.push(Math.max(0, now - expected))
    expected = now + TICK_MS

    if (lags.length >= TICKS_PER_REPORT) {
      const summary = summarizeLag(lags)
      const line = `Event-loop lag over ${(TICKS_PER_REPORT * TICK_MS) / 1000}s: max ${summary.maxMs}ms, p95 ${summary.p95Ms}ms, ${summary.overBudget}/${summary.samples} ticks over ${LAG_BUDGET_MS}ms`
      yield* summary.overBudget > 0 ? Effect.logWarning(line) : Effect.logDebug(line)
      lags = []
    }
  }
})
