import { Context, DateTime, Effect, FileSystem, Layer, Option, Order, Random, Ref, Schema } from "effect"
import * as os from "os"
import * as path from "path"
import { StoreError } from "../errors.js"
import { IndexPlan } from "../schemas.js"
import { Job } from "./Job.js"

/**
 * Persists jobs so they survive restarts. Only the main thread writes here.
 */
export interface JobStoreService {
  // All jobs, newest first. Unreadable files are skipped with a warning.
  readonly list: () => Effect.Effect<ReadonlyArray<Job>, StoreError>
  readonly get: (id: string) => Effect.Effect<Option.Option<Job>, StoreError>
  // Replace the stored job; the write is atomic
  readonly save: (job: Job) => Effect.Effect<void, StoreError>
  // Delete a job and its plan
  readonly remove: (id: string) => Effect.Effect<void, StoreError>
  // Mark jobs left `running` by a previous process as interrupted, along with
  // their running steps. Returns the jobs that changed.
  readonly markInterrupted: () => Effect.Effect<ReadonlyArray<Job>, StoreError>
  // A job's index plan is kept apart from the job: it can list every file in the repo
  readonly writePlan: (jobId: string, plan: IndexPlan) => Effect.Effect<void, StoreError>
  readonly readPlan: (jobId: string) => Effect.Effect<Option.Option<IndexPlan>, StoreError>
}

export class JobStore extends Context.Service<JobStore, JobStoreService>()(
  "@repobase/engine/JobStore"
) {}

/**
 * Default jobs directory: ~/.repobase/jobs
 */
export const defaultJobsDir = () => path.join(os.homedir(), ".repobase", "jobs")

const toStoreError =
  (operation: string) =>
  (error: unknown): StoreError =>
    new StoreError({
      operation,
      message:
        typeof error === "object" && error !== null && "message" in error
          ? String(error.message)
          : String(error)
    })

const JobJson = Schema.fromJsonString(Job)
const IndexPlanJson = Schema.fromJsonString(IndexPlan)

const newestFirst: Order.Order<Job> = Order.flip(
  Order.mapInput(DateTime.Order, (job: Job) => job.createdAt)
)

// Jobs left running by a process that is no longer around
const interruptJob = (job: Job, now: DateTime.Utc): Job => ({
  ...job,
  status: "interrupted",
  updatedAt: now,
  steps: job.steps.map((step) =>
    step.status === "running" ? { ...step, status: "interrupted" as const, finishedAt: now } : step
  )
})

/**
 * A file-backed JobStore: one `<id>.json` per job, plans in `<id>/plan.json`
 */
export const makeWith = (config: { readonly dir: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const jobFile = (id: string) => path.join(config.dir, `${id}.json`)
    const planDir = (id: string) => path.join(config.dir, id)
    const planFile = (id: string) => path.join(planDir(id), "plan.json")

    // Write to a temp file and rename over the target, so a crash mid-write
    // leaves the previous version intact rather than a truncated file
    const writeAtomic = (file: string, contents: string) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true })
        const tmp = `${file}.tmp-${process.pid}-${(yield* Random.nextInt).toString(36)}`
        yield* fs.writeFileString(tmp, contents)
        yield* fs.rename(tmp, file).pipe(Effect.tapError(() => fs.remove(tmp).pipe(Effect.ignore)))
      })

    const readJobFile = (file: string) =>
      Effect.gen(function* () {
        const contents = yield* fs.readFileString(file)
        return yield* Schema.decodeUnknownEffect(JobJson)(contents)
      })

    const list: JobStoreService["list"] = () =>
      Effect.gen(function* () {
        const exists = yield* fs.exists(config.dir)
        if (!exists) return []
        const entries = yield* fs.readDirectory(config.dir)
        const jobs: Array<Job> = []
        for (const entry of entries) {
          if (!entry.endsWith(".json")) continue // plan dirs and leftover temp files
          const file = path.join(config.dir, entry)
          const job = yield* readJobFile(file).pipe(
            Effect.map(Option.some),
            Effect.catch((error) =>
              Effect.logWarning(`Skipping unreadable job file ${file}: ${error.message}`).pipe(
                Effect.as(Option.none<Job>())
              )
            )
          )
          if (Option.isSome(job)) jobs.push(job.value)
        }
        return jobs.sort(newestFirst)
      }).pipe(Effect.mapError(toStoreError("listJobs")))

    const get: JobStoreService["get"] = (id) =>
      Effect.gen(function* () {
        const file = jobFile(id)
        if (!(yield* fs.exists(file))) return Option.none()
        return Option.some(yield* readJobFile(file))
      }).pipe(Effect.mapError(toStoreError("getJob")))

    const save: JobStoreService["save"] = (job) =>
      Effect.gen(function* () {
        const contents = yield* Schema.encodeEffect(JobJson)(job)
        yield* writeAtomic(jobFile(job.id), contents)
      }).pipe(Effect.mapError(toStoreError("saveJob")))

    const remove: JobStoreService["remove"] = (id) =>
      Effect.gen(function* () {
        yield* fs.remove(planDir(id), { recursive: true, force: true })
        yield* fs.remove(jobFile(id), { force: true })
      }).pipe(Effect.mapError(toStoreError("removeJob")))

    const markInterrupted: JobStoreService["markInterrupted"] = () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now
        const stale = (yield* list()).filter((job) => job.status === "running")
        const interrupted = stale.map((job) => interruptJob(job, now))
        yield* Effect.forEach(interrupted, save, { discard: true })
        return interrupted
      })

    const writePlan: JobStoreService["writePlan"] = (jobId, plan) =>
      Effect.gen(function* () {
        const contents = yield* Schema.encodeEffect(IndexPlanJson)(plan)
        yield* writeAtomic(planFile(jobId), contents)
      }).pipe(Effect.mapError(toStoreError("writePlan")))

    const readPlan: JobStoreService["readPlan"] = (jobId) =>
      Effect.gen(function* () {
        const file = planFile(jobId)
        if (!(yield* fs.exists(file))) return Option.none()
        const contents = yield* fs.readFileString(file)
        return Option.some(yield* Schema.decodeUnknownEffect(IndexPlanJson)(contents))
      }).pipe(Effect.mapError(toStoreError("readPlan")))

    return JobStore.of({ list, get, save, remove, markInterrupted, writePlan, readPlan })
  })

/**
 * JobStore for ~/.repobase/jobs - requires FileSystem
 */
export const layer = Layer.effect(JobStore, Effect.suspend(() => makeWith({ dir: defaultJobsDir() })))

/**
 * JobStore for a custom directory - requires FileSystem
 */
export const layerWith = (config: { readonly dir: string }) => Layer.effect(JobStore, makeWith(config))

/**
 * An in-memory JobStore for tests
 */
export const layerMemory: Layer.Layer<JobStore> = Layer.effect(
  JobStore,
  Effect.gen(function* () {
    const jobs = yield* Ref.make(new Map<string, Job>())
    const plans = yield* Ref.make(new Map<string, IndexPlan>())

    const list: JobStoreService["list"] = () =>
      Ref.get(jobs).pipe(Effect.map((m) => [...m.values()].sort(newestFirst)))

    return JobStore.of({
      list,
      get: (id) => Ref.get(jobs).pipe(Effect.map((m) => Option.fromNullishOr(m.get(id)))),
      save: (job) => Ref.update(jobs, (m) => new Map(m).set(job.id, job)),
      remove: (id) =>
        Effect.all([
          Ref.update(jobs, (m) => {
            const next = new Map(m)
            next.delete(id)
            return next
          }),
          Ref.update(plans, (m) => {
            const next = new Map(m)
            next.delete(id)
            return next
          })
        ]).pipe(Effect.asVoid),
      markInterrupted: () =>
        Effect.gen(function* () {
          const now = yield* DateTime.now
          const interrupted = (yield* list())
            .filter((job) => job.status === "running")
            .map((job) => interruptJob(job, now))
          yield* Ref.update(jobs, (m) => {
            const next = new Map(m)
            for (const job of interrupted) next.set(job.id, job)
            return next
          })
          return interrupted
        }),
      writePlan: (jobId, plan) => Ref.update(plans, (m) => new Map(m).set(jobId, plan)),
      readPlan: (jobId) => Ref.get(plans).pipe(Effect.map((m) => Option.fromNullishOr(m.get(jobId))))
    })
  })
)
