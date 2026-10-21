import { describe, it, expect } from "@effect/vitest"
import { DateTime, Effect, Option } from "effect"
import type { Job, Step } from "../src/jobs/Job.js"
import { isCurrent, plannedCommit } from "../src/jobs/reuse.js"
import { pinnedMode, trackingMode } from "../src/utils.js"
import { addRepo, makeSourceRepo, testEnv } from "./fixtures/jobEnv.js"

const REPO = "acme-widgets"
const at = DateTime.makeUnsafe(0)

const done = (key: string, output: unknown): Step => ({
  key,
  name: key,
  runsOn: "worker",
  status: "done",
  attempts: 1,
  output
})

const interrupted = (key: string): Step => ({ key, name: key, runsOn: "worker", status: "interrupted", attempts: 1 })

const fields = (steps: ReadonlyArray<Step>) => ({
  id: "job-1",
  repoId: REPO,
  status: "interrupted" as const,
  createdAt: at,
  updatedAt: at,
  steps
})

const syncJob = (steps: ReadonlyArray<Step>, force?: boolean): Job => ({
  ...fields(steps),
  kind: "syncRepo",
  payload: force === undefined ? {} : { force }
})

const reindexJob = (steps: ReadonlyArray<Step>): Job => ({ ...fields(steps), kind: "reindexRepo", payload: {} })

const addJob = (url: string, steps: ReadonlyArray<Step>): Job => ({ ...fields(steps), kind: "addRepo", payload: { url } })

const syncPlanned = (commit: string) =>
  done("resolveRemoteHead", { commit, committedAt: 0, upToDate: false })

const syncRequest = { kind: "syncRepo", repoId: REPO, payload: { force: false } } as const
const reindexRequest = { kind: "reindexRepo", repoId: REPO, payload: {} } as const

describe("plannedCommit", () => {
  it("is the commit a job's head step saved", () => {
    expect(plannedCommit(syncJob([done("fetch", null), syncPlanned("abc123")]))).toEqual(Option.some("abc123"))
    expect(plannedCommit(reindexJob([done("planFullIndex", { toIndex: 1, toDelete: 0, skipped: 0, commit: "def456" })]))).toEqual(
      Option.some("def456")
    )
    expect(plannedCommit(addJob("u", [done("resolveHead", { commit: "789abc", branch: "main" })]))).toEqual(
      Option.some("789abc")
    )
  })

  it("is nothing before the head step finished, or for a re-index saved before commits were recorded", () => {
    expect(plannedCommit(syncJob([done("fetch", null), interrupted("resolveRemoteHead")]))).toEqual(Option.none())
    expect(plannedCommit(reindexJob([done("planFullIndex", { toIndex: 1, toDelete: 0, skipped: 0 })]))).toEqual(
      Option.none()
    )
  })
})

describe("isCurrent", () => {
  it.effect("a sync is current until the remote branch moves", () => {
    const source = makeSourceRepo(3)
    const env = testEnv()
    return Effect.gen(function* () {
      yield* addRepo(source.dir)
      const job = syncJob([syncPlanned(source.head())], false)

      expect(yield* isCurrent(job, syncRequest)).toBe(true)
      source.write("new.ts", "export const fresh = true\n")
      source.commit()
      expect(yield* isCurrent(job, syncRequest)).toBe(false)
    }).pipe(Effect.provide(env.layer))
  })

  it.effect("a sync isn't current when it was forced and this one isn't, or the other way round", () => {
    const source = makeSourceRepo(3)
    const env = testEnv()
    return Effect.gen(function* () {
      yield* addRepo(source.dir)
      const planned = syncPlanned(source.head())

      expect(yield* isCurrent(syncJob([planned], true), syncRequest)).toBe(false)
      expect(yield* isCurrent(syncJob([planned]), { ...syncRequest, payload: { force: true } })).toBe(false)
      expect(yield* isCurrent(syncJob([planned]), syncRequest)).toBe(true)
    }).pipe(Effect.provide(env.layer))
  })

  it.effect("a job that planned nothing yet is current", () => {
    const source = makeSourceRepo(3)
    const env = testEnv()
    return Effect.gen(function* () {
      yield* addRepo(source.dir)
      source.write("new.ts", "export const fresh = true\n")
      source.commit()

      expect(yield* isCurrent(syncJob([done("fetch", null), interrupted("resolveRemoteHead")]), syncRequest)).toBe(true)
    }).pipe(Effect.provide(env.layer))
  })

  it.effect("a re-index is current while the clone is still on the commit it planned", () => {
    const source = makeSourceRepo(3)
    const env = testEnv()
    return Effect.gen(function* () {
      yield* addRepo(source.dir)
      const planned = (commit: string) =>
        reindexJob([done("planFullIndex", { toIndex: 3, toDelete: 0, skipped: 0, commit })])

      expect(yield* isCurrent(planned(source.head()), reindexRequest)).toBe(true)
      expect(yield* isCurrent(planned("0000000"), reindexRequest)).toBe(false)
    }).pipe(Effect.provide(env.layer))
  })

  it.effect("an add is current until the branch it tracks moves; a pinned one always is", () => {
    const source = makeSourceRepo(3)
    const env = testEnv()
    return Effect.gen(function* () {
      const cloned = [done("resolveHead", { commit: source.head(), branch: "main" })]
      const request = (mode?: ReturnType<typeof trackingMode>) =>
        ({ kind: "addRepo", repoId: REPO, payload: mode ? { url: source.dir, mode } : { url: source.dir } }) as const

      expect(yield* isCurrent(addJob(source.dir, cloned), request())).toBe(true)
      expect(yield* isCurrent(addJob(source.dir, cloned), request(trackingMode("main")))).toBe(true)
      source.write("new.ts", "export const fresh = true\n")
      source.commit()
      expect(yield* isCurrent(addJob(source.dir, cloned), request())).toBe(false)
      expect(yield* isCurrent(addJob(source.dir, cloned), request(trackingMode("main")))).toBe(false)
      expect(
        yield* isCurrent(addJob(source.dir, cloned), {
          kind: "addRepo",
          repoId: REPO,
          payload: { url: source.dir, mode: pinnedMode("v1") }
        })
      ).toBe(true)
    }).pipe(Effect.provide(env.layer))
  })

  it.effect("counts a job as current when the remote can't be reached", () => {
    const env = testEnv()
    return Effect.gen(function* () {
      const url = "/nonexistent/repobase-remote"
      const job = addJob(url, [done("resolveHead", { commit: "abc123", branch: "main" })])

      expect(yield* isCurrent(job, { kind: "addRepo", repoId: REPO, payload: { url } })).toBe(true)
    }).pipe(Effect.provide(env.layer))
  })
})
