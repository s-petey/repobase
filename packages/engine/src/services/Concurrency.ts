import { Config } from "effect"
import * as os from "os"

export const MAX_CONCURRENCY_ENV = "REPOBASE_MAX_CONCURRENCY"

export const DEFAULT_MAX_CONCURRENCY = 4

/**
 * Clamp a worker count to the allowed range [1, max].
 */
export const computeConcurrencyLimit = (cores: number, max = DEFAULT_MAX_CONCURRENCY): number =>
  Math.max(1, Math.min(cores, max))

/**
 * Resolve the concurrency cap for parallel worker operations.
 *
 * Honors `REPOBASE_MAX_CONCURRENCY` when it is a positive integer; a missing,
 * empty, or invalid value falls back to a cap derived from the CPU core count.
 * Usable directly as an `Effect` (defaults to reading `process.env`).
 */
export const maxConcurrencyConfig: Config.Config<number> = Config.orElse(
  Config.integer(MAX_CONCURRENCY_ENV).pipe(
    Config.validate({
      message: `${MAX_CONCURRENCY_ENV} must be a positive integer`,
      validation: (n) => n > 0,
    })
  ),
  () => Config.succeed(computeConcurrencyLimit(os.cpus().length))
)
