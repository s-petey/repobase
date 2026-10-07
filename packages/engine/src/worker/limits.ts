import { Config, Effect, Option } from "effect"
import * as os from "os"

/**
 * Environment variable that overrides the computed worker count
 */
export const MAX_WORKERS_ENV = "REPOBASE_MAX_WORKERS"

/**
 * Upper bound on the default worker count. Each worker holds its own LanceDB
 * connection, and the search worker its own embedding model, so more workers
 * cost memory. The indexing workers are counted separately (see
 * resolveIndexingConcurrency).
 */
export const DEFAULT_MAX_WORKERS = 4

/**
 * Rough memory footprint of one worker (embedder + ONNX runtime + LanceDB)
 */
export const MEMORY_PER_WORKER_BYTES = 512 * 1024 * 1024

/**
 * Fraction of total system memory the worker pool may use by default
 */
export const MEMORY_BUDGET_FRACTION = 0.25

/**
 * Inputs for resolving the worker count
 */
export interface WorkerCountInput {
  readonly cores: number
  readonly totalMemBytes: number
  readonly override?: string | undefined
}

/**
 * Resolved worker count and where it came from
 */
export interface WorkerCount {
  readonly count: number
  readonly source: "default" | "override"
  readonly warning?: string
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

/**
 * Resolve how many worker threads may be spawned.
 *
 * By default this leaves one core for the main (render) thread, caps at
 * DEFAULT_MAX_WORKERS, and keeps the pool within MEMORY_BUDGET_FRACTION of
 * system memory. A valid override wins but is still clamped to the core count.
 */
export const resolveWorkerCount = (input: WorkerCountInput): WorkerCount => {
  const cores = Math.max(1, Math.floor(input.cores))

  const byCpu = clamp(cores - 1, 1, DEFAULT_MAX_WORKERS)
  const byMem = Math.max(
    1,
    Math.floor((input.totalMemBytes * MEMORY_BUDGET_FRACTION) / MEMORY_PER_WORKER_BYTES)
  )
  return withOverride(MAX_WORKERS_ENV, input.override, Math.min(byCpu, byMem), cores)
}

/**
 * A positive-integer env override of `fallback`, clamped to `cores`; an
 * invalid value is ignored with a warning
 */
const withOverride = (env: string, override: string | undefined, fallback: number, cores: number): WorkerCount => {
  const defaults: WorkerCount = { count: fallback, source: "default" }

  const raw = override?.trim()
  if (raw === undefined || raw === "") return defaults

  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    return { ...defaults, warning: `Ignoring ${env}=${override}: expected a positive integer` }
  }

  const requested = Number(raw)
  if (requested > cores) {
    return {
      count: cores,
      source: "override",
      warning: `${env}=${requested} exceeds ${cores} available cores, using ${cores}`
    }
  }

  return { count: requested, source: "override" }
}

/**
 * Environment variable that overrides how many index batches may run at once
 */
export const MAX_INDEXING_ENV = "REPOBASE_MAX_INDEXING"

/**
 * ONNX Runtime threads each worker thread embeds with, which is also the cores
 * one embedding stream uses (the count includes the calling thread). Measured on
 * transformers 4.3.0: 2 threads embed ~34 chunks/s on 2 cores, where the default
 * pool embeds ~43/s on ~5, so several capped workers do more with less CPU.
 */
export const ONNX_THREADS_PER_WORKER = 2

/**
 * Upper bound on the default indexing worker count: each loads its own
 * embedding model (fp32, ~90 MB) and ONNX Runtime
 */
export const DEFAULT_MAX_INDEXING_WORKERS = 4

/**
 * Fraction of the machine's cores indexing may use by default, leaving the rest
 * for the TUI and everything else
 */
export const INDEXING_CPU_BUDGET = 0.5

/**
 * Resolve how many index batches (embedding streams) may run at once across
 * all jobs, which is also how many indexing workers there are. By default
 * that's as many as fit in INDEXING_CPU_BUDGET of the cores at
 * ONNX_THREADS_PER_WORKER each, between one and DEFAULT_MAX_INDEXING_WORKERS;
 * a valid override wins, clamped to the core count.
 */
export const resolveIndexingConcurrency = (input: {
  readonly cores: number
  readonly override?: string | undefined
}): WorkerCount => {
  const cores = Math.max(1, Math.floor(input.cores))
  const byBudget = clamp(
    Math.floor((cores * INDEXING_CPU_BUDGET) / ONNX_THREADS_PER_WORKER),
    1,
    DEFAULT_MAX_INDEXING_WORKERS
  )
  return withOverride(MAX_INDEXING_ENV, input.override, byBudget, cores)
}

/**
 * Resolve the indexing concurrency for the current machine, with the override
 * from MAX_INDEXING_ENV. It's read as a string so a bad value warns and falls
 * back instead of failing startup.
 */
export const hostIndexingConcurrency: Effect.Effect<WorkerCount, Config.ConfigError> = Config.option(
  Config.String(MAX_INDEXING_ENV)
).pipe(
  Effect.map((override) =>
    resolveIndexingConcurrency({
      cores: os.availableParallelism?.() ?? os.cpus().length,
      override: Option.getOrUndefined(override)
    })
  )
)

/**
 * How the worker budget is split between indexing jobs and search queries.
 * A query size of 0 means searches share the job pool.
 */
export interface PoolSizes {
  readonly jobs: number
  readonly query: number
}

/**
 * Split the worker budget: one warm worker for search, the rest for jobs.
 * With a single worker, jobs and queries share it.
 */
export const splitPools = (count: number): PoolSizes =>
  count <= 1 ? { jobs: 1, query: 0 } : { jobs: count - 1, query: 1 }

/**
 * Resolve the worker count for the current machine, with the override from
 * MAX_WORKERS_ENV. Read as a string, like hostIndexingConcurrency.
 */
export const hostWorkerCount: Effect.Effect<WorkerCount, Config.ConfigError> = Config.option(
  Config.String(MAX_WORKERS_ENV)
).pipe(
  Effect.map((override) =>
    resolveWorkerCount({
      cores: os.availableParallelism?.() ?? os.cpus().length,
      totalMemBytes: os.totalmem(),
      override: Option.getOrUndefined(override)
    })
  )
)
