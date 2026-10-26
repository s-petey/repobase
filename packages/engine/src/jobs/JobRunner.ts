import {
  Cause,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  FiberMap,
  Layer,
  Option,
  Ref,
  Result,
  Schedule,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef
} from "effect"
import { isRetryable, type StepError, UnexpectedStepError } from "./errors.js"
import { type IndexLock, makeIndexLock } from "./IndexLock.js"
import {
  type Job,
  type JobKind,
  type JobOwner,
  type JobStatus,
  makeJobId,
  type Step,
  type StepRunsOn,
  superseded
} from "./Job.js"
import { heldBy, JobStore } from "./JobStore.js"
import { abandoned, runningElsewhere, runningHere, thisProcessStartedAt } from "./owner.js"

const OWNER_CHECK_INTERVAL = Duration.seconds(15)

// A generic runner for jobs made of checkpointed steps. The job definitions
// (what addRepo and syncRepo actually do) live elsewhere; this file only knows
// how to run, persist, retry and cancel steps.

// ---------------------------------------------------------------------------
// Definitions

/**
 * A step's output schema: decoded from the job's checkpoint, needs no services
 */
export type OutputSchema<O> = Schema.Codec<O, unknown, never, never>

/**
 * What a running step can see: the job and the outputs of earlier steps
 */
export interface StepContext<J extends Job> {
  readonly job: J
  // The saved output of an earlier step. Dies if that step hasn't run, since
  // that means the job definition lists steps in the wrong order.
  readonly output: <O>(step: StepDefinition<J, O, any>) => Effect.Effect<O>
  // Index writes go through `write`; finalizing (compaction and the full-text
  // rebuild) goes through `exclusive`, so it never races another job's writes
  readonly indexLock: IndexLock
}

/**
 * A step that runs once
 */
export interface StepDefinition<J extends Job, O, R> {
  readonly _tag: "Step"
  readonly name: string
  readonly runsOn: StepRunsOn
  readonly output: OutputSchema<O>
  readonly run: (ctx: StepContext<J>) => Effect.Effect<O, StepError, R>
  // End the job early after this step, e.g. a pinned repo has nothing to sync.
  // The remaining steps are marked skipped.
  readonly finishJob?: (output: O) => Option.Option<"completed" | "skipped">
}

/**
 * A step that expands into one step per item (e.g. one per batch of files).
 * Items must come out the same on every call, since a retried job recomputes
 * them to re-run only the failed ones.
 */
export interface FanOutDefinition<J extends Job, I, O, R> {
  readonly _tag: "FanOut"
  readonly name: string
  readonly runsOn: StepRunsOn
  readonly output: OutputSchema<O>
  readonly items: (ctx: StepContext<J>) => Effect.Effect<ReadonlyArray<I>, StepError, R>
  readonly run: (
    item: I,
    position: { readonly index: number; readonly total: number },
    ctx: StepContext<J>
  ) => Effect.Effect<O, StepError, R>
}

export type AnyStepDefinition<J extends Job, R> =
  | StepDefinition<J, any, R>
  | FanOutDefinition<J, any, any, R>

export interface JobDefinition<J extends Job, R> {
  readonly steps: ReadonlyArray<AnyStepDefinition<J, R>>
}

export const step = <J extends Job, O, R>(
  definition: Omit<StepDefinition<J, O, R>, "_tag">
): StepDefinition<J, O, R> => ({ _tag: "Step", ...definition })

export const fanOut = <J extends Job, I, O, R>(
  definition: Omit<FanOutDefinition<J, I, O, R>, "_tag">
): FanOutDefinition<J, I, O, R> => ({ _tag: "FanOut", ...definition })

/**
 * One definition per job kind
 */
export type JobDefinitions<R> = {
  readonly [K in JobKind]: JobDefinition<Extract<Job, { kind: K }>, R>
}

// Key of the n-th step a fan-out expands into
export const fanOutKey = (name: string, index: number) => `${name}:${index}`

// What a fan-out's own step saves
const FanOutCount = Schema.Struct({ count: Schema.Number })

// ---------------------------------------------------------------------------
// Errors

export class JobAlreadyRunningError extends Schema.TaggedError<JobAlreadyRunningError>()(
  "JobAlreadyRunningError",
  {
    repoId: Schema.String,
    message: Schema.String
  }
) {}

export class JobNotFoundError extends Schema.TaggedError<JobNotFoundError>()("JobNotFoundError", {
  jobId: Schema.String,
  message: Schema.String
}) {}

export class JobNotRetryableError extends Schema.TaggedError<JobNotRetryableError>()(
  "JobNotRetryableError",
  {
    jobId: Schema.String,
    message: Schema.String
  }
) {}

export type JobRunnerError = JobAlreadyRunningError | JobNotFoundError | JobNotRetryableError

// ---------------------------------------------------------------------------
// Service

export type NewJob = { [K in JobKind]: { readonly kind: K; readonly repoId: string; readonly payload: Extract<Job, { kind: K }>["payload"] } }[JobKind]

export interface JobRunnerService {
  // Every known job, newest first, updated as steps run
  readonly jobs: Effect.Effect<ReadonlyArray<Job>>
  readonly changes: Stream.Stream<ReadonlyArray<Job>>
  // Create a job and run it in the background; `prepare` runs first, while the repo is already claimed for it
  readonly start: <E = never, R = never>(
    job: NewJob,
    options?: { readonly prepare?: Effect.Effect<void, E, R> }
  ) => Effect.Effect<Job, JobRunnerError | E, R>
  readonly whileClaimed: <A, E, R>(repoId: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | JobAlreadyRunningError, R>
  // Re-run a failed or interrupted job from the steps that didn't finish
  readonly retry: (jobId: string) => Effect.Effect<Job, JobRunnerError>
  readonly supersede: (jobId: string, by: string) => Effect.Effect<Job, JobRunnerError>
  // Stop the job if it is running, and delete it
  readonly discard: (jobId: string) => Effect.Effect<void, JobRunnerError>
  // Wait until a job is no longer running
  readonly await: (jobId: string) => Effect.Effect<Job, JobNotFoundError>
  // Stop every running job and wait until each is saved as interrupted
  readonly interruptAll: Effect.Effect<void>
}

export class JobRunner extends Context.Service<JobRunner, JobRunnerService>()(
  "@repobase/engine/JobRunner"
) {}

// ---------------------------------------------------------------------------
// Implementation

const initialSteps = (definition: {
  readonly steps: ReadonlyArray<{ readonly name: string; readonly runsOn: StepRunsOn }>
}): ReadonlyArray<Step> =>
  definition.steps.map((def) => ({
    key: def.name,
    name: def.name,
    runsOn: def.runsOn,
    status: "pending" as const,
    attempts: 0
  }))

const hasEveryStep = <J extends Job>(job: J, definition: JobDefinition<J, any>) =>
  definition.steps.every((def) => job.steps.some((s) => s.name === def.name))

const withEveryStep = <J extends Job>(job: J, definition: JobDefinition<J, any>): J => ({
  ...job,
  steps: definition.steps.flatMap((def) => {
    const saved = job.steps.filter((s) => s.name === def.name)
    return saved.length > 0
      ? saved
      : [{ key: def.name, name: def.name, runsOn: def.runsOn, status: "pending" as const, attempts: 0 }]
  })
})

const unfinished = (step: Step) =>
  step.status === "failed" || step.status === "interrupted" || step.status === "running"

const stepErrorFrom = (repoId: string, stepKey: string, cause: Cause.Cause<StepError>): StepError =>
  Result.match(Cause.findError(cause), {
    onSuccess: (error) => error,
    onFailure: () =>
      new UnexpectedStepError({
        repoId,
        step: stepKey,
        message: String(Cause.squash(cause)),
        cause: Cause.pretty(cause)
      })
  })

export interface JobRunnerOptions {
  readonly concurrency: number
  readonly processName?: string
  readonly followOthers?: boolean
}

export const make = <R>(definitions: JobDefinitions<R>, options: JobRunnerOptions) =>
  Effect.gen(function* () {
    const store = yield* JobStore
    const services = yield* Effect.context<R>()
    const indexLock = yield* makeIndexLock
    const fibers = yield* FiberMap.make<string>()
    const owner: JobOwner = { pid: process.pid, name: options.processName ?? "repobase", startedAt: thisProcessStartedAt() }

    // Jobs left running by a previous process can't still be running
    yield* store.markInterrupted().pipe(
      Effect.catch((e) => Effect.logWarning(`Could not mark interrupted jobs: ${e.message}`))
    )
    const stored = yield* store.list().pipe(
      Effect.catch((e) =>
        Effect.logWarning(`Could not load jobs: ${e.message}`).pipe(Effect.as<ReadonlyArray<Job>>([]))
      )
    )
    const state = yield* SubscriptionRef.make<ReadonlyMap<string, Job>>(
      new Map(stored.map((job) => [job.id, job]))
    )

    // Repos with a job in flight; a second job for the same repo is refused. Each
    // claim is its own symbol, so a run that ends late can only release its own
    // claim, never the next job's for the same repo. The store's claim keeps
    // other processes from starting one too.
    const activeRepos = yield* Ref.make<ReadonlyMap<string, symbol>>(new Map())

    const dropClaim = (repoId: string, claim: symbol) =>
      Ref.modify(activeRepos, (active) => {
        if (active.get(repoId) !== claim) return [false, active]
        const next = new Map(active)
        next.delete(repoId)
        return [true, next]
      })

    const claimRepo = (repoId: string) =>
      Effect.gen(function* () {
        const claim = Symbol(repoId)
        const claimed = yield* Ref.modify(activeRepos, (active) =>
          active.has(repoId) ? [false, active] : [true, new Map(active).set(repoId, claim)]
        )
        if (!claimed) {
          return yield* new JobAlreadyRunningError({ repoId, message: `A job for ${repoId} is already running` })
        }
        // A lock that can't be written doesn't stop the job: it only guards against another process
        const held = yield* store.claimRepo(repoId, owner).pipe(
          Effect.catch((e) =>
            Effect.logWarning(`Could not claim ${repoId} for this process: ${e.message}`).pipe(Effect.as(Option.none()))
          )
        )
        if (Option.isSome(held)) {
          yield* dropClaim(repoId, claim)
          return yield* new JobAlreadyRunningError({
            repoId,
            message: `A job for ${repoId} is already running in ${heldBy(held.value)}`
          })
        }
        return claim
      })

    const releaseRepo = (repoId: string, claim: symbol) =>
      dropClaim(repoId, claim).pipe(Effect.flatMap((dropped) => (dropped ? store.releaseRepo(repoId) : Effect.void)))

    // Uninterruptible until the job's fiber takes the claim over, so a failure or interrupt in between releases it
    const withClaim = <A, E, R2>(
      repoId: string,
      use: (claim: symbol, restore: <X, EX, RX>(effect: Effect.Effect<X, EX, RX>) => Effect.Effect<X, EX, RX>) => Effect.Effect<A, E, R2>
    ) =>
      Effect.uninterruptibleMask((restore) =>
        claimRepo(repoId).pipe(
          Effect.flatMap((claim) => use(claim, restore).pipe(Effect.onError(() => releaseRepo(repoId, claim))))
        )
      )

    const sorted = (jobs: ReadonlyMap<string, Job>) =>
      [...jobs.values()].sort((a, b) => DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt))

    // All job mutations go through here: one at a time, persisted, then published
    const writeLock = yield* Semaphore.make(1)
    const publish = (job: Job) =>
      writeLock.withPermit(
        Effect.gen(function* () {
          yield* store.save(job).pipe(
            Effect.catch((e) => Effect.logWarning(`Could not save job ${job.id}: ${e.message}`))
          )
          yield* SubscriptionRef.update(state, (jobs) => new Map(jobs).set(job.id, job))
        })
      )

    const current = (jobId: string) =>
      SubscriptionRef.get(state).pipe(Effect.map((jobs) => Option.fromNullishOr(jobs.get(jobId))))

    const updateJob = (jobId: string, f: (job: Job, now: DateTime.Utc) => Job) =>
      writeLock.withPermit(
        Effect.gen(function* () {
          const now = yield* DateTime.now
          const job = Option.getOrThrow(yield* current(jobId))
          const next: Job = { ...f(job, now), updatedAt: now }
          yield* store.save(next).pipe(
            Effect.catch((e) => Effect.logWarning(`Could not save job ${jobId}: ${e.message}`))
          )
          yield* SubscriptionRef.update(state, (jobs) => new Map(jobs).set(jobId, next))
          return next
        })
      )

    const updateStep = (jobId: string, key: string, f: (step: Step, now: DateTime.Utc) => Step) =>
      updateJob(jobId, (job, now) => ({
        ...job,
        steps: job.steps.map((s) => (s.key === key ? f(s, now) : s))
      }))

    // A step context bound to the job's latest saved state
    const snapshot = <J extends Job>(jobId: string, isKind: (job: Job) => job is J) =>
      Effect.gen(function* () {
        const job = Option.getOrThrow(Option.filter(yield* current(jobId), isKind))
        const ctx: StepContext<J> = {
          job,
          indexLock,
          output: <O>(def: StepDefinition<J, O, any>) =>
            Effect.gen(function* () {
              const latest = Option.getOrThrow(yield* current(jobId))
              const saved = latest.steps.find((s) => s.key === def.name)
              if (!saved || saved.status !== "done") {
                return yield* Effect.die(
                  new Error(`Step ${def.name} of job ${jobId} has no output yet; check the step order`)
                )
              }
              return yield* Schema.decodeUnknownEffect(def.output)(saved.output).pipe(Effect.orDie)
            })
        }
        return ctx
      })

    // Run one step: persist running, run it, persist done (with its encoded
    // output) or failed (with its StepError). Succeeds with the effect's value,
    // or fails with the StepError that was recorded. `toOutput` picks what is
    // saved when that differs from the value (a fan-out saves only its count).
    const runStep = <A, O>(
      jobId: string,
      key: string,
      outputSchema: OutputSchema<O>,
      effect: Effect.Effect<A, StepError, R>,
      toOutput: (value: A) => O
    ) =>
      Effect.gen(function* () {
        yield* updateStep(jobId, key, (s, now) => ({
          ...s,
          status: "running",
          attempts: s.attempts + 1,
          startedAt: now,
          finishedAt: undefined,
          error: undefined
        }))

        const exit = yield* effect.pipe(
          Effect.flatMap((value) =>
            Schema.encodeEffect(outputSchema)(toOutput(value)).pipe(
              Effect.orDie,
              Effect.map((encoded) => ({ value, encoded }))
            )
          ),
          Effect.provide(services),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning(`Step ${key} of job ${jobId} failed`, cause)
          ),
          Effect.withSpan(`step.${key.split(":")[0]}`, { attributes: { "job.id": jobId, "step.key": key } }),
          Effect.exit
        )

        if (Exit.isSuccess(exit)) {
          yield* updateStep(jobId, key, (s, now) => ({
            ...s,
            status: "done",
            output: exit.value.encoded,
            finishedAt: now
          }))
          return exit.value.value
        }
        if (Cause.hasInterruptsOnly(exit.cause)) {
          return yield* Effect.interrupt
        }
        const job = Option.getOrThrow(yield* current(jobId))
        const error = stepErrorFrom(job.repoId, key, exit.cause)
        yield* updateStep(jobId, key, (s, now) => ({ ...s, status: "failed", error, finishedAt: now }))
        return yield* Effect.fail(error)
      })

    // Finished jobs that nothing will look at again: for each repo only its
    // latest job is kept, plus failed and interrupted ones until they're retried,
    // superseded or discarded. Their plans can list every file of a repo. A job
    // that just finished is its repo's latest, even when it's a retry of an older job.
    const prune = (justFinished?: Job) =>
      writeLock.withPermit(
        Effect.gen(function* () {
          const done = (job: Job) => job.status === "completed" || job.status === "skipped" || superseded(job)
          const jobs = [...(yield* SubscriptionRef.get(state)).values()]
          const stale = justFinished
            ? jobs.filter((job) => job.repoId === justFinished.repoId && job.id !== justFinished.id && done(job))
            : jobs
                .sort((a, b) => DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt))
                .filter((job, i, latestFirst) => done(job) && latestFirst.findIndex((j) => j.repoId === job.repoId) !== i)
          if (stale.length === 0) return
          yield* Effect.forEach(stale, (job) =>
            store
              .remove(job.id)
              .pipe(Effect.catch((e) => Effect.logWarning(`Could not delete job ${job.id}: ${e.message}`)))
          )
          yield* SubscriptionRef.update(state, (jobs) => {
            const next = new Map(jobs)
            for (const job of stale) next.delete(job.id)
            return next
          })
        })
      )

    // Free the repo before publishing the final status, so whoever awaits the
    // job can start the next one for the same repo straight away.
    // Uninterruptible, so a job that has started finishing isn't then saved as interrupted
    const finish = (jobId: string, status: JobStatus, release: Effect.Effect<void>) =>
      release.pipe(
        Effect.andThen(
          updateJob(jobId, (job) => ({
            ...job,
            status,
            steps:
              status === "completed" || status === "skipped"
                ? job.steps.map((s) => (s.status === "pending" ? { ...s, status: "skipped" as const } : s))
                : job.steps
          }))
        ),
        Effect.tap((job) => Effect.logInfo(`${job.kind} for ${job.repoId} ${status}`)),
        Effect.tap(prune),
        Effect.uninterruptible
      )

    // Run a fan-out. Its own step lists the items (every attempt: it is cheap);
    // the first time, or if the items changed, one step per item is made afresh
    // after it. Then every item step that isn't done runs.
    // Items don't cancel each other; the fan-out fails if any of them failed.
    const runFanOut = <J extends Job>(jobId: string, def: FanOutDefinition<J, any, any, R>, isKind: (job: Job) => job is J) =>
      Effect.gen(function* () {
        const ctx = yield* snapshot(jobId, isKind)
        const items: ReadonlyArray<unknown> = yield* runStep(
          jobId,
          def.name,
          FanOutCount,
          def.items(ctx),
          (items) => ({ count: items.length })
        )

        yield* updateJob(jobId, (job) => {
          const isItem = (s: Step) => s.name === def.name && s.key !== def.name
          if (job.steps.filter(isItem).length === items.length) return job
          const others = job.steps.filter((s) => !isItem(s))
          const at = others.findIndex((s) => s.key === def.name)
          const expanded = items.map((_, index) => ({
            key: fanOutKey(def.name, index),
            name: def.name,
            runsOn: def.runsOn,
            status: "pending" as const,
            attempts: 0
          }))
          return { ...job, steps: [...others.slice(0, at + 1), ...expanded, ...others.slice(at + 1)] }
        })

        const job = Option.getOrThrow(yield* current(jobId))
        const toRun = items
          .map((item, index) => ({ item, index, key: fanOutKey(def.name, index) }))
          .filter(({ key }) => job.steps.find((s) => s.key === key)?.status !== "done")

        const exits = yield* Effect.forEach(
          toRun,
          ({ item, index, key }) =>
            runStep(jobId, key, def.output, def.run(item, { index, total: items.length }, ctx), (value) => value).pipe(
              Effect.exit
            ),
          { concurrency: options.concurrency }
        )
        const failure = exits.find(Exit.isFailure)
        if (failure) return yield* failure
      })

    // Run a job's remaining steps in order
    const runJob = <K extends JobKind>(kind: K, jobId: string, release: Effect.Effect<void>) =>
      Effect.gen(function* () {
        const definition = definitions[kind]
        const isKind = (job: Job): job is Extract<Job, { kind: K }> => job.kind === kind
        const initial = Option.getOrThrow(Option.filter(yield* current(jobId), isKind))
        if (!hasEveryStep(initial, definition)) {
          yield* updateJob(jobId, (job) => (isKind(job) ? withEveryStep(job, definition) : job))
        }

        for (const def of definition.steps) {
          const job = Option.getOrThrow(yield* current(jobId))
          if (def._tag === "FanOut") {
            const expanded = job.steps.filter((s) => s.name === def.name && s.key !== def.name)
            const allDone = expanded.length > 0 && expanded.every((s) => s.status === "done")
            if (allDone) continue
            yield* runFanOut(jobId, def, isKind)
            continue
          }

          // A step done before an interrupt still decides whether the job ends there
          const saved = job.steps.find((s) => s.key === def.name)
          const output =
            saved?.status === "done"
              ? yield* Schema.decodeUnknownEffect(def.output)(saved.output).pipe(Effect.orDie)
              : yield* runStep(jobId, def.name, def.output, def.run(yield* snapshot(jobId, isKind)), (value) => value)
          const early = def.finishJob ? def.finishJob(output) : Option.none()
          if (Option.isSome(early)) {
            yield* finish(jobId, early.value, release)
            return
          }
        }
        yield* finish(jobId, "completed", release)
      }).pipe(
        // A failed step is already recorded on the step. Anything else (a bug
        // in the runner or a definition) is logged; either way the job ends
        // failed instead of looking like it's still running.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.gen(function* () {
                if (Result.isFailure(Cause.findError(cause))) {
                  yield* Effect.logError(`Job ${jobId} crashed`, cause)
                }
                yield* finish(jobId, "failed", release)
              })
        ),
        // A job that finished just before the interrupt keeps its final status
        Effect.onInterrupt(() =>
          release.pipe(
            Effect.andThen(
              updateJob(jobId, (job, now) =>
                job.status !== "running"
                  ? job
                  : {
                      ...job,
                      status: "interrupted",
                      steps: job.steps.map((s) =>
                        s.status === "running" ? { ...s, status: "interrupted" as const, finishedAt: now } : s
                      )
                    }
              )
            ),
            Effect.ignore
          )
        )
      )

    // Its own trace: a job outlives whatever started it
    const launch = (job: Job, claim: symbol) => {
      const release = releaseRepo(job.repoId, claim)
      return FiberMap.run(
        fibers,
        job.id,
        runJob(job.kind, job.id, release).pipe(
          Effect.withSpan(`job.${job.kind}`, {
            root: true,
            attributes: { "job.id": job.id, "job.repo": job.repoId, "job.kind": job.kind }
          }),
          Effect.ensuring(release),
          Effect.interruptible
        )
      ).pipe(Effect.asVoid)
    }

    const start: JobRunnerService["start"] = (input, options) =>
      withClaim(input.repoId, (claim, restore) =>
        Effect.gen(function* () {
          if (options?.prepare) yield* restore(options.prepare)
          const now = yield* DateTime.now
          const job: Job = {
            ...input,
            id: yield* makeJobId(input.kind, input.repoId),
            status: "running",
            createdAt: now,
            updatedAt: now,
            owner,
            steps: initialSteps(definitions[input.kind])
          }
          yield* publish(job)
          yield* Effect.logInfo(`Started ${job.kind} for ${job.repoId} (${job.id})`)
          yield* launch(job, claim)
          return job
        })
      )

    const whileClaimed: JobRunnerService["whileClaimed"] = (repoId, effect) =>
      withClaim(repoId, (claim, restore) => restore(effect).pipe(Effect.ensuring(releaseRepo(repoId, claim))))

    const findJob = (jobId: string) =>
      current(jobId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new JobNotFoundError({ jobId, message: `No job ${jobId}` })),
            onSome: Effect.succeed
          })
        )
      )

    const retry: JobRunnerService["retry"] = (jobId) =>
      Effect.gen(function* () {
        const job = yield* findJob(jobId)
        if (job.status !== "failed" && job.status !== "interrupted") {
          return yield* new JobNotRetryableError({ jobId, message: `Job ${jobId} is ${job.status}` })
        }
        if (superseded(job)) {
          return yield* new JobNotRetryableError({ jobId, message: `Job ${jobId} was replaced by ${job.supersededBy}` })
        }
        const permanent = job.steps.find((s) => s.status === "failed" && s.error && !isRetryable(s.error))
        if (permanent?.error) {
          return yield* new JobNotRetryableError({
            jobId,
            message: `Step ${permanent.key} can't succeed on retry: ${permanent.error.message}`
          })
        }
        const from = job.steps.find((s) => s.status !== "done" && s.status !== "skipped")
        const items = job.steps.filter((s) => s.key !== s.name)
        const itemsDone = items.filter((s) => s.status === "done").length
        return yield* withClaim(job.repoId, (claim) =>
          Effect.gen(function* () {
            yield* Effect.logInfo(
              `Resuming ${job.kind} for ${job.repoId} at ${from?.key ?? "the end"}${
                items.length > 0 ? ` (${itemsDone}/${items.length} ${items[0].name} done)` : ""
              }`
            )
            const resumed = yield* updateJob(jobId, (j, now) => ({
              ...j,
              createdAt: now,
              status: "running",
              owner,
              steps: j.steps.map((s) => (unfinished(s) ? { ...s, status: "pending" as const } : s))
            }))
            yield* launch(resumed, claim)
            return resumed
          })
        )
      })

    const supersede: JobRunnerService["supersede"] = (jobId, by) =>
      Effect.gen(function* () {
        const job = yield* findJob(jobId)
        if (runningElsewhere(job)) {
          return yield* new JobAlreadyRunningError({
            repoId: job.repoId,
            message: `This ${job.kind} is running in another repobase process (${job.owner?.name})`
          })
        }
        if (job.status !== "failed" && job.status !== "interrupted") {
          return yield* new JobNotRetryableError({
            jobId,
            message: `Only a failed or interrupted job can be superseded (${jobId} is ${job.status})`
          })
        }
        yield* Effect.logInfo(`${job.kind} for ${job.repoId} (${jobId}) superseded by ${by}`)
        return yield* updateJob(jobId, (j) => ({ ...j, supersededBy: by }))
      })

    const discard: JobRunnerService["discard"] = (jobId) =>
      Effect.gen(function* () {
        const job = yield* findJob(jobId)
        if (runningElsewhere(job)) {
          return yield* new JobAlreadyRunningError({
            repoId: job.repoId,
            message: `This ${job.kind} is running in another repobase process (${job.owner?.name}); stop it there first`
          })
        }
        // Interrupting runs the job's own finalizers (release the repo, mark interrupted)
        yield* FiberMap.remove(fibers, jobId)
        yield* Effect.logInfo(`Discarded ${job.kind} for ${job.repoId} (${jobId})`)
        yield* writeLock.withPermit(
          Effect.gen(function* () {
            yield* store.remove(jobId).pipe(
              Effect.catch((e) => Effect.logWarning(`Could not delete job ${jobId}: ${e.message}`))
            )
            yield* SubscriptionRef.update(state, (jobs) => {
              const next = new Map(jobs)
              next.delete(jobId)
              return next
            })
          })
        )
      })

    const awaitJob: JobRunnerService["await"] = (jobId) =>
      Effect.gen(function* () {
        yield* findJob(jobId)
        const done = yield* SubscriptionRef.changes(state).pipe(
          Stream.map((jobs) => jobs.get(jobId)),
          Stream.filter((job): job is Job => job === undefined || job.status !== "running"),
          Stream.runHead
        )
        return yield* Option.match(Option.flatMap(done, Option.fromNullishOr), {
          onNone: () => Effect.fail(new JobNotFoundError({ jobId, message: `Job ${jobId} was discarded` })),
          onSome: Effect.succeed
        })
      })

    const follow = (jobId: string) =>
      writeLock.withPermit(
        Effect.gen(function* () {
          const mine = (yield* SubscriptionRef.get(state)).get(jobId)
          if (mine && runningHere(mine)) return
          const stored = yield* store.get(jobId)
          yield* SubscriptionRef.update(state, (jobs) => {
            const next = new Map(jobs)
            if (Option.isSome(stored)) {
              next.set(jobId, stored.value)
            } else {
              next.delete(jobId)
            }
            return next
          })
        })
      ).pipe(Effect.catch((e) => Effect.logWarning(`Could not reload job ${jobId}: ${e.message}`)))

    const interruptAbandoned = Effect.gen(function* () {
      const ids = [...(yield* SubscriptionRef.get(state)).values()].filter(abandoned).map((job) => job.id)
      if (ids.length === 0) return
      yield* store.markInterrupted()
      yield* Effect.forEach(ids, follow, { discard: true })
    }).pipe(Effect.catch((e) => Effect.logWarning(`Could not check other processes' jobs: ${e.message}`)))

    if (options.followOthers) {
      // Started now, so it's subscribed before anything is saved
      yield* Effect.forkScoped(
        Stream.runForEach(store.changes, follow).pipe(
          Effect.catch((e) => Effect.logWarning(`Stopped following other processes' jobs: ${e.message}`))
        ),
        { startImmediately: true }
      )
      yield* Effect.forkScoped(Effect.repeat(interruptAbandoned, Schedule.spaced(OWNER_CHECK_INTERVAL)))
    }

    yield* prune()

    return JobRunner.of({
      jobs: SubscriptionRef.get(state).pipe(Effect.map(sorted)),
      changes: SubscriptionRef.changes(state).pipe(Stream.map(sorted)),
      start,
      whileClaimed,
      retry,
      supersede,
      discard,
      await: awaitJob,
      // Waits for each job's onInterrupt, which saves it as interrupted
      interruptAll: FiberMap.clear(fibers)
    })
  })

/**
 * JobRunner layer - requires a JobStore and whatever the job definitions need
 */
export const layer = <R>(definitions: JobDefinitions<R>, options: JobRunnerOptions) =>
  Layer.effect(JobRunner, make(definitions, options))
