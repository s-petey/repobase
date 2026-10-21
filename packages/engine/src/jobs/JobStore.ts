import {
  Context,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Order,
  Path,
  type PlatformError,
  PubSub,
  Random,
  Ref,
  Schema,
  Stream
} from "effect"
import * as os from "os"
import * as nodePath from "path"
import { StoreError } from "../errors.js"
import { IndexPlan } from "../schemas.js"
import { Job, JobOwner } from "./Job.js"
import { abandoned, isProcessAlive } from "./owner.js"

/**
 * Persists jobs so they survive restarts. Only the main thread writes here.
 */
export interface JobStoreService {
  readonly list: () => Effect.Effect<ReadonlyArray<Job>, StoreError>
  readonly get: (id: string) => Effect.Effect<Option.Option<Job>, StoreError>
  readonly save: (job: Job) => Effect.Effect<void, StoreError>
  readonly remove: (id: string) => Effect.Effect<void, StoreError>
  readonly markInterrupted: () => Effect.Effect<ReadonlyArray<Job>, StoreError>
  readonly claimRepo: (repoId: string, owner: JobOwner) => Effect.Effect<Option.Option<RepoHeld>, StoreError>
  readonly releaseRepo: (repoId: string) => Effect.Effect<void>
  readonly heldElsewhere: () => Effect.Effect<ReadonlyArray<RepoHeld>, StoreError>
  readonly changes: Stream.Stream<string, StoreError>
  readonly writePlan: (jobId: string, plan: IndexPlan) => Effect.Effect<void, StoreError>
  readonly readPlan: (jobId: string) => Effect.Effect<Option.Option<IndexPlan>, StoreError>
}

// A repo another process has claimed. Its holder is unknown while that process
// is still writing itself into the lock file.
export interface RepoHeld {
  readonly holder: Option.Option<JobOwner>
}

export const heldBy = (held: RepoHeld): string =>
  Option.match(held.holder, {
    onNone: () => "another repobase process",
    onSome: (holder) => `repobase ${holder.name} (pid ${holder.pid})`
  })

export class JobStore extends Context.Service<JobStore, JobStoreService>()(
  "@repobase/engine/JobStore"
) {}

/**
 * Default jobs directory: ~/.repobase/jobs
 */
export const defaultJobsDir = () => nodePath.join(os.homedir(), ".repobase", "jobs")

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

const JOB_EXTENSION = ".json"
const LOCKS_DIR = "locks"
const LOCK_EXTENSION = ".lock"
const CREATE_ONLY = "wx" satisfies FileSystem.OpenFlag
const ALREADY_EXISTS = "AlreadyExists" satisfies PlatformError.SystemErrorTag
// How long a lock file may stay empty while its process writes its owner into it
const LOCK_WRITE_GRACE = Duration.seconds(5)
const LockJson = Schema.fromJsonString(JobOwner)
// The pid in a temp file name written by writeAtomic: <file>.json.tmp-<pid>-<random>
const TEMP_FILE_PID = /\.json\.tmp-(\d+)-/

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
    const path = yield* Path.Path
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
        const stale = (yield* list()).filter(abandoned)
        const interrupted = stale.map((job) => interruptJob(job, now))
        yield* Effect.forEach(interrupted, save, { discard: true })

        if (yield* fs.exists(config.dir).pipe(Effect.mapError(toStoreError("markInterrupted")))) {
          // Only a process that's gone: a live one may be about to rename its temp file
          const leftovers = (yield* fs.readDirectory(config.dir).pipe(Effect.mapError(toStoreError("markInterrupted"))))
            .filter((entry) => {
              const pid = Number(TEMP_FILE_PID.exec(entry)?.[1])
              return Number.isInteger(pid) && pid !== process.pid && !isProcessAlive(pid)
            })
          yield* Effect.forEach(leftovers, (entry) => fs.remove(path.join(config.dir, entry)).pipe(Effect.ignore), {
            discard: true
          })
        }
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

    // A lock file per repo holding its owner, created only if it doesn't exist
    const lockFile = (repoId: string) =>
      path.join(config.dir, LOCKS_DIR, `${repoId.replaceAll("/", "__")}${LOCK_EXTENSION}`)
    const lockHolder = (file: string) =>
      fs.readFileString(file).pipe(Effect.flatMap(Schema.decodeUnknownEffect(LockJson)), Effect.option)

    // An empty or unreadable lock file older than the grace period: its process
    // stopped before writing itself into it
    const leftUnwritten = (file: string) =>
      Effect.gen(function* () {
        const info = yield* fs.stat(file).pipe(Effect.option)
        const modified = Option.flatMap(info, (i) => i.mtime)
        if (Option.isNone(modified)) return true
        const age = DateTime.distance(DateTime.fromDateUnsafe(modified.value), yield* DateTime.now)
        return Duration.isGreaterThan(age, LOCK_WRITE_GRACE)
      })

    const liveClaim = (file: string) =>
      Effect.gen(function* () {
        const holder = yield* lockHolder(file)
        const live = Option.isSome(holder) ? isProcessAlive(holder.value.pid) : !(yield* leftUnwritten(file))
        return live ? Option.some<RepoHeld>({ holder }) : Option.none<RepoHeld>()
      })

    const heldElsewhere: JobStoreService["heldElsewhere"] = () =>
      Effect.gen(function* () {
        const dir = path.join(config.dir, LOCKS_DIR)
        if (!(yield* fs.exists(dir))) return []
        const files = (yield* fs.readDirectory(dir)).filter((entry) => entry.endsWith(LOCK_EXTENSION))
        const claims = yield* Effect.forEach(files, (entry) => liveClaim(path.join(dir, entry)))
        return claims.flatMap((claim) =>
          Option.isSome(claim) && !Option.exists(claim.value.holder, (holder) => holder.pid === process.pid)
            ? [claim.value]
            : []
        )
      }).pipe(Effect.mapError(toStoreError("heldElsewhere")))

    const claimRepo: JobStoreService["claimRepo"] = (repoId, owner) =>
      Effect.gen(function* () {
        const file = lockFile(repoId)
        const contents = yield* Schema.encodeEffect(LockJson)(owner)
        yield* fs.makeDirectory(path.dirname(file), { recursive: true })
        // Twice: once more after removing a claim its process left behind
        for (let attempt = 0; attempt < 2; attempt++) {
          const created = yield* fs.writeFileString(file, contents, { flag: CREATE_ONLY }).pipe(
            Effect.as(true),
            Effect.catch((e) => (e.reason._tag === ALREADY_EXISTS ? Effect.succeed(false) : Effect.fail(e)))
          )
          if (created) return Option.none()
          const held = yield* liveClaim(file)
          if (Option.isSome(held)) return held
          yield* fs.remove(file, { force: true })
        }
        return Option.some({ holder: Option.none() })
      }).pipe(Effect.mapError(toStoreError("claimRepo")))

    const releaseRepo: JobStoreService["releaseRepo"] = (repoId) =>
      Effect.gen(function* () {
        const file = lockFile(repoId)
        const holder = yield* lockHolder(file)
        if (Option.isSome(holder) && holder.value.pid === process.pid) yield* fs.remove(file, { force: true })
      }).pipe(Effect.ignore)

    const changes: JobStoreService["changes"] = fs.makeDirectory(config.dir, { recursive: true }).pipe(
      Effect.as(fs.watch(config.dir)),
      Stream.unwrap,
      Stream.filter((event) => event.path.endsWith(JOB_EXTENSION)),
      Stream.map((event) => event.path.slice(0, -JOB_EXTENSION.length)),
      Stream.mapError(toStoreError("watchJobs"))
    )

    return JobStore.of({
      list,
      get,
      save,
      remove,
      markInterrupted,
      claimRepo,
      releaseRepo,
      heldElsewhere,
      changes,
      writePlan,
      readPlan
    })
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
    const claims = yield* Ref.make<ReadonlyMap<string, JobOwner>>(new Map())
    const changed = yield* PubSub.unbounded<string>()

    const list: JobStoreService["list"] = () =>
      Ref.get(jobs).pipe(Effect.map((m) => [...m.values()].sort(newestFirst)))

    return JobStore.of({
      list,
      get: (id) => Ref.get(jobs).pipe(Effect.map((m) => Option.fromNullishOr(m.get(id)))),
      save: (job) =>
        Ref.update(jobs, (m) => new Map(m).set(job.id, job)).pipe(Effect.andThen(PubSub.publish(changed, job.id)), Effect.asVoid),
      changes: Stream.fromPubSub(changed),
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
        ]).pipe(Effect.andThen(PubSub.publish(changed, id)), Effect.asVoid),
      markInterrupted: () =>
        Effect.gen(function* () {
          const now = yield* DateTime.now
          const interrupted = (yield* list())
            .filter(abandoned)
            .map((job) => interruptJob(job, now))
          yield* Ref.update(jobs, (m) => {
            const next = new Map(m)
            for (const job of interrupted) next.set(job.id, job)
            return next
          })
          return interrupted
        }),
      claimRepo: (repoId, owner) =>
        Ref.modify(claims, (held): [Option.Option<RepoHeld>, ReadonlyMap<string, JobOwner>] => {
          const holder = Option.fromUndefinedOr(held.get(repoId))
          return Option.isSome(holder) ? [Option.some({ holder }), held] : [Option.none(), new Map(held).set(repoId, owner)]
        }),
      releaseRepo: (repoId) =>
        Ref.update(claims, (held) => {
          const next = new Map(held)
          next.delete(repoId)
          return next
        }),
      heldElsewhere: () =>
        Ref.get(claims).pipe(
          Effect.map((held) =>
            [...held.values()].filter((owner) => owner.pid !== process.pid).map((owner) => ({ holder: Option.some(owner) }))
          )
        ),
      writePlan: (jobId, plan) => Ref.update(plans, (m) => new Map(m).set(jobId, plan)),
      readPlan: (jobId) => Ref.get(plans).pipe(Effect.map((m) => Option.fromNullishOr(m.get(jobId))))
    })
  })
)
