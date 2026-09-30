import {
  Cause,
  Context,
  DateTime,
  Effect,
  Exit,
  FiberMap,
  Layer,
  Option,
  Ref,
  Result,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef
} from "effect"
import { isRetryable, type StepError, UnexpectedStepError } from "./errors.js"
import { type IndexLock, makeIndexLock } from "./IndexLock.js"
import { type Job, type JobKind, type JobStatus, makeJobId, type Step, type StepRunsOn } from "./Job.js"
import { JobStore } from "./JobStore.js"

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

type NewJob = { [K in JobKind]: { readonly kind: K; readonly repoId: string; readonly payload: Extract<Job, { kind: K }>["payload"] } }[JobKind]

export interface JobRunnerService {
  // Every known job, newest first, updated as steps run
  readonly jobs: Effect.Effect<ReadonlyArray<Job>>
  readonly changes: Stream.Stream<ReadonlyArray<Job>>
  // Create a job and run it in the background
  readonly start: (job: NewJob) => Effect.Effect<Job, JobRunnerError>
  // Re-run a failed or interrupted job from the steps that didn't finish
  readonly retry: (jobId: string) => Effect.Effect<Job, JobRunnerError>
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

const initialSteps = <J extends Job>(definition: JobDefinition<J, any>): ReadonlyArray<Step> =>
  definition.steps.map((def) => ({
    key: def.name,
    name: def.name,
    runsOn: def.runsOn,
    status: "pending" as const,
    attempts: 0
  }))

// Steps a retry should run again
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

/**
 * @param concurrency - how many fan-out steps of one job run at once
 *   (typically the worker pool size)
 */
export const make = <R>(definitions: JobDefinitions<R>, options: { readonly concurrency: number }) =>
  Effect.gen(function* () {
    const store = yield* JobStore
    const services = yield* Effect.context<R>()
    const indexLock = yield* makeIndexLock
    const fibers = yield* FiberMap.make<string>()

    // Jobs left running by a previous process can't still be running
    yield* store.markInterrupted().pipe(
      Effect.catch((e) => Effect.logWarning(`Could not mark interrupted jobs: ${e.message}`))
    )
    const stored = yield* store.list().pipe(
      Effect.catch((e) =>
        Effect.logWarning(`Could not load jobs: ${e.message}`).pipe(Effect.as([] as ReadonlyArray<Job>))
      )
    )
    const state = yield* SubscriptionRef.make<ReadonlyMap<string, Job>>(
      new Map(stored.map((job) => [job.id, job]))
    )

    // Repos with a job in flight; a second job for the same repo is refused
    const activeRepos = yield* Ref.make<ReadonlySet<string>>(new Set())

    const claimRepo = (repoId: string) =>
      Ref.modify(activeRepos, (active) =>
        active.has(repoId) ? [false, active] : [true, new Set(active).add(repoId)]
      ).pipe(
        Effect.flatMap((claimed) =>
          claimed
            ? Effect.void
            : Effect.fail(
                new JobAlreadyRunningError({ repoId, message: `A job for ${repoId} is already running` })
              )
        )
      )

    const releaseRepo = (repoId: string) =>
      Ref.update(activeRepos, (active) => {
        const next = new Set(active)
        next.delete(repoId)
        return next
      })

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
          const next = { ...f(job, now), updatedAt: now } as Job
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
    const snapshot = <J extends Job>(jobId: string) =>
      Effect.gen(function* () {
        const job = Option.getOrThrow(yield* current(jobId)) as J
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
      toOutput: (value: A) => O = (value) => value as unknown as O
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

    // Free the repo before publishing the final status, so whoever awaits the
    // job can start the next one for the same repo straight away
    const releaseJobRepo = (jobId: string) =>
      current(jobId).pipe(
        Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (job) => releaseRepo(job.repoId) }))
      )

    // Uninterruptible, so a job that has started finishing isn't then saved as interrupted
    const finish = (jobId: string, status: JobStatus) =>
      releaseJobRepo(jobId).pipe(
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
        Effect.uninterruptible
      )

    // Run a fan-out. Its own step lists the items (every attempt: it is cheap
    // and must give the same items each time); the first time, one step per
    // item is added after it. Then every item step that isn't done runs.
    // Items don't cancel each other; the fan-out fails if any of them failed.
    const runFanOut = <J extends Job>(jobId: string, def: FanOutDefinition<J, any, any, R>) =>
      Effect.gen(function* () {
        const ctx = yield* snapshot<J>(jobId)
        const items: ReadonlyArray<unknown> = yield* runStep(
          jobId,
          def.name,
          FanOutCount,
          def.items(ctx),
          (items) => ({ count: items.length })
        )

        yield* updateJob(jobId, (job) => {
          const existing = job.steps.filter((s) => s.name === def.name && s.key !== def.name)
          if (existing.length > 0) {
            if (existing.length !== items.length) {
              throw new Error(
                `${def.name} of job ${jobId} now has ${items.length} items, not ${existing.length}; items must be stable`
              )
            }
            return job
          }
          const at = job.steps.findIndex((s) => s.key === def.name)
          const expanded = items.map((_, index) => ({
            key: fanOutKey(def.name, index),
            name: def.name,
            runsOn: def.runsOn,
            status: "pending" as const,
            attempts: 0
          }))
          return { ...job, steps: [...job.steps.slice(0, at + 1), ...expanded, ...job.steps.slice(at + 1)] }
        })

        const job = Option.getOrThrow(yield* current(jobId))
        const toRun = items
          .map((item, index) => ({ item, index, key: fanOutKey(def.name, index) }))
          .filter(({ key }) => job.steps.find((s) => s.key === key)?.status !== "done")

        const exits = yield* Effect.forEach(
          toRun,
          ({ item, index, key }) =>
            runStep(jobId, key, def.output, def.run(item, { index, total: items.length }, ctx)).pipe(
              Effect.exit
            ),
          { concurrency: options.concurrency }
        )
        const failure = exits.find(Exit.isFailure)
        if (failure) return yield* failure
      })

    // Run a job's remaining steps in order
    const runJob = (jobId: string) =>
      Effect.gen(function* () {
        const initial = Option.getOrThrow(yield* current(jobId))
        const definition = definitions[initial.kind] as unknown as JobDefinition<Job, R>

        for (const def of definition.steps) {
          const job = Option.getOrThrow(yield* current(jobId))
          if (def._tag === "FanOut") {
            const expanded = job.steps.filter((s) => s.name === def.name && s.key !== def.name)
            const allDone = expanded.length > 0 && expanded.every((s) => s.status === "done")
            if (allDone) continue
            yield* runFanOut(jobId, def)
            continue
          }

          if (job.steps.find((s) => s.key === def.name)?.status === "done") continue
          const ctx = yield* snapshot(jobId)
          const output = yield* runStep(jobId, def.name, def.output, def.run(ctx))
          const early = def.finishJob ? def.finishJob(output) : Option.none()
          if (Option.isSome(early)) {
            yield* finish(jobId, early.value)
            return
          }
        }
        yield* finish(jobId, "completed")
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
                yield* finish(jobId, "failed")
              })
        ),
        // A job that finished just before the interrupt keeps its final status
        Effect.onInterrupt(() =>
          releaseJobRepo(jobId).pipe(
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

    const launch = (job: Job) =>
      FiberMap.run(
        fibers,
        job.id,
        runJob(job.id).pipe(Effect.ensuring(releaseRepo(job.repoId)))
      ).pipe(Effect.asVoid)

    const start: JobRunnerService["start"] = (input) =>
      Effect.gen(function* () {
        yield* claimRepo(input.repoId)
        const now = yield* DateTime.now
        const definition = definitions[input.kind] as unknown as JobDefinition<Job, R>
        const job = {
          id: yield* makeJobId(input.kind, input.repoId),
          kind: input.kind,
          repoId: input.repoId,
          payload: input.payload,
          status: "running",
          createdAt: now,
          updatedAt: now,
          steps: initialSteps(definition)
        } as Job
        yield* publish(job)
        yield* launch(job)
        return job
      })

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
        const permanent = job.steps.find((s) => s.status === "failed" && s.error && !isRetryable(s.error))
        if (permanent?.error) {
          return yield* new JobNotRetryableError({
            jobId,
            message: `Step ${permanent.key} can't succeed on retry: ${permanent.error.message}`
          })
        }
        yield* claimRepo(job.repoId)
        const resumed = yield* updateJob(jobId, (j) => ({
          ...j,
          status: "running",
          steps: j.steps.map((s) => (unfinished(s) ? { ...s, status: "pending" as const } : s))
        }))
        yield* launch(resumed)
        return resumed
      })

    const discard: JobRunnerService["discard"] = (jobId) =>
      Effect.gen(function* () {
        yield* findJob(jobId)
        // Interrupting runs the job's own finalizers (release the repo, mark interrupted)
        yield* FiberMap.remove(fibers, jobId)
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

    return JobRunner.of({
      jobs: SubscriptionRef.get(state).pipe(Effect.map(sorted)),
      changes: SubscriptionRef.changes(state).pipe(Stream.map(sorted)),
      start,
      retry,
      discard,
      await: awaitJob,
      // Waits for each job's onInterrupt, which saves it as interrupted
      interruptAll: FiberMap.clear(fibers)
    })
  })

/**
 * JobRunner layer - requires a JobStore and whatever the job definitions need
 */
export const layer = <R>(definitions: JobDefinitions<R>, options: { readonly concurrency: number }) =>
  Layer.effect(JobRunner, make(definitions, options))
