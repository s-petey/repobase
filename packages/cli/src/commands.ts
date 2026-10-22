import { Console, Context, DateTime, Duration, Effect, Layer, Option, Predicate, Ref } from "effect"
import {
  deriveRepoId,
  heldBy,
  InvalidRepoUrlError,
  type Job,
  jobFailed,
  JobRunner,
  JobStore,
  needsReindex,
  pinnedMode,
  type RepoConfig,
  RepobaseEngine,
  removeRepoWithJobs,
  resumableJob,
  reuseOrStart,
  runSync,
  syncUpdated,
  trackingMode
} from "@repobase/engine"
import { failureReport, followJobs } from "./progress.js"

const FAILED = 1

/**
 * The exit code the CLI ends with. Commands print their own errors and succeed,
 * so a failure only sets this; main.ts hands it to the process at the end.
 */
export class CliExit extends Context.Service<CliExit, Ref.Ref<number>>()("@repobase/cli/CliExit") {
  static readonly layer = Layer.effect(CliExit)(Ref.make(0))
}

export const printError = (message: string) =>
  Console.error(message).pipe(Effect.andThen(CliExit.use((exit) => Ref.set(exit, FAILED))))

export const reportError = (error: { readonly _tag: string; readonly message?: string }) =>
  printError(error.message ? `Error: ${error.message}` : `Error: ${error._tag} - ${JSON.stringify(error)}`)

export const formatDate = (date: DateTime.Utc): string =>
  DateTime.formatLocal(date, {
    locale: "en-US",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  })

export const shortCommit = (repo: RepoConfig) =>
  Option.match(repo.lastSyncedCommit, {
    onNone: () => "none",
    onSome: (c) => (repo.lastSyncedCommitAt ? `${c.slice(0, 8)} (${formatDate(repo.lastSyncedCommitAt)})` : c.slice(0, 8))
  })

export const outdatedRepoIds = RepobaseEngine.use((engine) => engine.listRepos()).pipe(
  Effect.map((repos) => repos.filter(needsReindex).map((r) => r.id))
)

const withProgress = <A, E, R>(repoId: string, effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(followJobs(repoId).pipe(Effect.andThen(effect))).pipe(
    Effect.onInterrupt(() => Console.error("Stopped. Run the same command again to pick up where it left off."))
  )

export const busyElsewhere = Effect.gen(function* () {
  const [held] = yield* JobStore.use((store) => store.heldElsewhere())
  if (held === undefined) return false
  yield* printError(`${heldBy(held)} is running a task; run this again once it's done`)
  return true
})

const notAdded = (repoId: string) =>
  printError(`${repoId} isn't one of your repositories; 'repobase list' shows them`)

const runJob = <E, R>(start: Effect.Effect<{ readonly job: Job }, E, R>) =>
  start.pipe(Effect.flatMap(({ job }) => JobRunner.use((runner) => runner.await(job.id))))

const reportFailedJob = (job: Job) => printError(failureReport(job))

export const handleAdd = (input: {
  readonly url: string
  readonly branch: Option.Option<string>
  readonly pin: Option.Option<string>
}) =>
  Effect.gen(function* () {
    if (yield* busyElsewhere) return
    const { url, branch, pin } = input
    const engine = yield* RepobaseEngine
    const repoId = yield* Effect.try({
      try: () => deriveRepoId(url),
      catch: () => new InvalidRepoUrlError({ url, message: `${url} isn't a GitHub repository URL` })
    })

    // An add that stopped partway has saved the repo already; it resumes
    const runner = yield* JobRunner
    if (Option.isSome(yield* engine.getRepo(repoId)) && !resumableJob(yield* runner.jobs, repoId, "addRepo")) {
      return yield* printError(`${repoId} is already added; 'repobase sync ${repoId}' updates it`)
    }

    // Without --pin or --branch the job tracks the remote's default branch
    const mode = Option.isSome(pin) ? pinnedMode(pin.value) : Option.getOrUndefined(Option.map(branch, trackingMode))

    const job = yield* withProgress(
      repoId,
      runJob(reuseOrStart({ kind: "addRepo", repoId, payload: mode ? { url, mode } : { url } }))
    )
    if (job.status !== "completed") return yield* reportFailedJob(job)

    const repo = yield* engine.getRepo(repoId)
    yield* Console.log(`✓ Added repository: ${repoId}`)
    if (Option.isSome(repo)) yield* Console.log(`  Path: ${repo.value.localPath}`)
  }).pipe(Effect.catch(reportError))

export const handleSync = (id: Option.Option<string>) =>
  Effect.gen(function* () {
    if (yield* busyElsewhere) return
    const engine = yield* RepobaseEngine
    const ids = Option.isSome(id) ? [id.value] : (yield* engine.listRepos()).map((r) => r.id)
    if (ids.length === 0) {
      yield* Console.log("No repositories to sync.")
      return
    }

    for (const repoId of ids) {
      yield* Effect.gen(function* () {
        if (Option.isNone(yield* engine.getRepo(repoId))) return yield* notAdded(repoId)
        const { job } = yield* withProgress(repoId, runSync(repoId))
        if (jobFailed(job)) return yield* reportFailedJob(job)
        if (job.status === "skipped") return yield* Console.log(`  ${repoId}: pinned, not synced`)
        if (!syncUpdated(job)) return yield* Console.log(`  ${repoId}: already up to date`)
        const repo = yield* engine.getRepo(repoId)
        yield* Console.log(`✓ ${repoId}: updated to ${Option.match(repo, { onNone: () => "?", onSome: shortCommit })}`)
      }).pipe(Effect.catch(reportError))
    }
  }).pipe(Effect.catch(reportError))

export const handleReindex = (id: Option.Option<string>) =>
  Effect.gen(function* () {
    if (yield* busyElsewhere) return
    const engine = yield* RepobaseEngine
    const ids = Option.isSome(id) ? [id.value] : yield* outdatedRepoIds
    if (ids.length === 0) {
      yield* Console.log("Every repository is on the current index format; nothing to re-index.")
      return
    }

    const runner = yield* JobRunner
    for (const oldId of ids) {
      yield* Effect.gen(function* () {
        if (Option.isNone(yield* engine.getRepo(oldId))) return yield* notAdded(oldId)
        const repoId = yield* engine.migrateRepoId(oldId)
        if (repoId !== oldId) {
          const stale = (yield* runner.jobs).filter((j) => j.repoId === oldId)
          yield* Effect.forEach(stale, (j) => runner.discard(j.id), { discard: true })
        }

        const job = yield* withProgress(repoId, runJob(reuseOrStart({ kind: "reindexRepo", repoId, payload: {} })))
        if (job.status !== "completed") return yield* reportFailedJob(job)
        const planned = job.steps.find((s) => s.key === "planFullIndex")?.output
        const files = Predicate.hasProperty(planned, "toIndex") ? `${planned.toIndex} files ` : ""
        const seconds = Duration.toSeconds(DateTime.distance(job.createdAt, job.updatedAt))
        yield* Console.log(
          `✓ ${repoId === oldId ? repoId : `${oldId} (now ${repoId})`}: ${files}re-indexed in ${seconds.toFixed(1)}s`
        )
      }).pipe(
        // One repo failing doesn't stop the rest
        Effect.catch(reportError)
      )
    }
  }).pipe(Effect.catch(reportError))

export const handleRemove = (id: string) =>
  Effect.gen(function* () {
    if (yield* busyElsewhere) return
    yield* removeRepoWithJobs(id)
    yield* Console.log(`✓ Removed repository: ${id}`)
  }).pipe(Effect.catch(reportError))
