import { DateTime, Effect, Ref, Schedule, Stream } from "effect"
import {
  JobProgress,
  JobRunner,
  jobFailureMessage,
  kindLabel,
  resumePoint,
  retryState,
  stepIcon,
  stepLines,
  type FileProgress,
  type Job,
  type StepLine
} from "@repobase/engine"

const finished = (status: StepLine["status"]) => status === "done" || status === "failed" || status === "interrupted"

const settled = (line: StepLine) =>
  finished(line.status) && !(line.children ?? []).some((c) => c.status === "running" || c.status === "pending")

export const stepReport = (line: StepLine): ReadonlyArray<string> => [
  `  ${stepIcon[line.status]} ${line.label}`,
  ...(line.error ? [`    ${line.error.title}`, ...(line.error.hint ? [`    Hint: ${line.error.hint}`] : [])] : [])
]

export const failureReport = (job: Job): string => {
  const retry = retryState(job)
  // A failed step's error is printed under that step already
  const why = job.steps.some((s) => s.status === "failed" && s.error) ? "" : `: ${jobFailureMessage(job)}`
  return `✗ ${kindLabel[job.kind]} ${job.repoId} ${job.status}${why}\n  ${
    retry.canRetry ? "Run the same command again to retry from where it stopped." : retry.reason
  }`
}

const batchCounts = (job: Job) => {
  const batches = job.steps.filter((s) => s.name === "indexBatch" && s.key !== "indexBatch")
  return { done: batches.filter((s) => s.status === "done").length, total: batches.length }
}

export const followJobs = (repoId: string) =>
  Effect.gen(function* () {
    const runner = yield* JobRunner
    const progress = yield* JobProgress
    const files = yield* Ref.make<ReadonlyMap<string, FileProgress>>(new Map())
    const since = DateTime.toEpochMillis(yield* DateTime.now)
    const tty = process.stdout.isTTY === true

    const printed = new Map<string, Set<string>>()
    const reportedTenth = new Map<string, number>()
    let live = ""

    const write = (text: string) => process.stdout.write(text)
    const clearLive = () => {
      if (live !== "") write("\r\x1b[2K")
      live = ""
    }
    const print = (line: string) => {
      clearLive()
      write(`${line}\n`)
    }

    const liveLine = (job: Job, fileProgress: FileProgress | undefined) => {
      const running = stepLines(job).find((line) => line.status === "running")
      if (!running) return ""
      const indexing =
        running.key === "indexBatch" && fileProgress
          ? ` · ${fileProgress.filesStarted.toLocaleString()}/${fileProgress.totalFiles.toLocaleString()} files${fileProgress.currentFile ? ` · ${fileProgress.currentFile}` : ""}`
          : ""
      const text = `  ${stepIcon.running} ${running.label}${indexing}`
      const width = process.stdout.columns ?? 80
      return text.length < width ? text : `${text.slice(0, width - 2)}…`
    }

    const render = Effect.gen(function* () {
      const fileProgress = yield* Ref.get(files)
      const jobs = [...(yield* runner.jobs)]
        .filter((job) => job.repoId === repoId && job.owner?.pid === process.pid)
        .reverse()

      let current = ""
      for (const job of jobs) {
        let shown = printed.get(job.id)
        if (!shown) {
          shown = new Set()
          printed.set(job.id, shown)
          const resumed = DateTime.toEpochMillis(job.createdAt) < since
          print(`${kindLabel[job.kind]} ${repoId}${resumed ? ` (resuming at ${resumePoint(job) ?? "where it stopped"})` : ""}`)
        }

        for (const line of stepLines(job)) {
          if (shown.has(line.key) || !settled(line)) continue
          shown.add(line.key)
          stepReport(line).forEach(print)
        }

        if (job.status !== "running") continue
        if (tty) {
          current = liveLine(job, fileProgress.get(job.id))
        } else {
          const { done, total } = batchCounts(job)
          const tenth = total === 0 ? 0 : Math.floor((done / total) * 10)
          if (tenth > (reportedTenth.get(job.id) ?? 0) && done < total) {
            reportedTenth.set(job.id, tenth)
            print(`  ${stepIcon.running} indexBatch ${done}/${total}`)
          }
        }
      }

      if (current !== live) {
        write(`\r\x1b[2K${current}`)
        live = current
      }
    })

    yield* Effect.forkScoped(Stream.runForEach(progress.changes, (next) => Ref.set(files, next)))
    yield* Effect.forkScoped(Effect.repeat(render, Schedule.spaced("100 millis")))
    // Runs before the fibers above stop: the jobs' final steps are printed, then the live line goes
    yield* Effect.addFinalizer(() => render.pipe(Effect.andThen(Effect.sync(clearLive))))
  })
