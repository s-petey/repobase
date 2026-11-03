import { Effect, Option } from "effect"

export const SHUTDOWN_DEADLINE = "3 seconds"

const tasks = (count: number) => (count === 1 ? "1 running task" : `${count} running tasks`)

export const stoppingNotice = (running: number) =>
  `Stopping ${tasks(running)} (up to 3s); resume from [t] Tasks. Press Ctrl+C to force quit.`

export const deadlineNotice = "Tasks didn't stop within 3s; exiting anyway. They show as interrupted next time."

/**
 * Leave without closing the worker pools. A worker thread that exits while
 * LanceDB work it started is still running aborts Bun, so the running jobs are
 * interrupted (saving each as interrupted) and the process exits with the
 * threads still up.
 */
export const shutdown = (options: {
  readonly running: number
  readonly interruptJobs: Effect.Effect<void>
  readonly notice: (message: string) => void
  readonly exit: (code: number) => void
  readonly code: number
}) =>
  Effect.gen(function* () {
    if (options.running > 0) options.notice(stoppingNotice(options.running))
    const stopped = yield* options.interruptJobs.pipe(Effect.timeoutOption(SHUTDOWN_DEADLINE))
    if (Option.isNone(stopped)) options.notice(deadlineNotice)
    options.exit(options.code)
  })
