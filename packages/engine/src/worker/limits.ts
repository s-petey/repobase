import * as os from "os"

/**
 * Environment variable that overrides the computed worker count
 */
export const MAX_WORKERS_ENV = "REPOBASE_MAX_WORKERS"

/**
 * Upper bound on the default worker count. Each worker holds its own embedding
 * model and LanceDB connection, so more workers cost memory quickly.
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
  const fallback: WorkerCount = { count: Math.min(byCpu, byMem), source: "default" }

  const raw = input.override?.trim()
  if (raw === undefined || raw === "") return fallback

  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    return {
      ...fallback,
      warning: `Ignoring ${MAX_WORKERS_ENV}=${input.override}: expected a positive integer`
    }
  }

  const requested = Number(raw)
  if (requested > cores) {
    return {
      count: cores,
      source: "override",
      warning: `${MAX_WORKERS_ENV}=${requested} exceeds ${cores} available cores, using ${cores}`
    }
  }

  return { count: requested, source: "override" }
}

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
 * ONNX intra-op threads per worker, so N workers don't each claim every core
 */
export const onnxThreadsPerWorker = (cores: number, workers: number): number =>
  Math.max(1, Math.floor(cores / Math.max(1, workers)))

/**
 * Resolve the worker count for the current machine and environment
 */
export const resolveHostWorkerCount = (): WorkerCount =>
  resolveWorkerCount({
    cores: os.availableParallelism?.() ?? os.cpus().length,
    totalMemBytes: os.totalmem(),
    override: process.env[MAX_WORKERS_ENV]
  })
