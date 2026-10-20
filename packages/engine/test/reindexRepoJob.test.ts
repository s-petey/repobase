import { describe, it, expect } from "@effect/vitest"
import * as lancedb from "@lancedb/lancedb"
import { DateTime, Effect, Option } from "effect"
import { CURRENT_INDEX_FORMAT } from "../src/indexFormat.js"
import { Indexer } from "../src/services/Indexer.js"
import { RepoStore } from "../src/services/RepoStore.js"
import { pinnedMode } from "../src/utils.js"
import { addRepo, indexedPaths, makeSourceRepo, reindexRepo, statuses, stepOf, syncRepo, testEnv } from "./fixtures/jobEnv.js"

const REPO = "acme-widgets"

// As if the repo was indexed by a version before index formats: stamped 1,
// with nothing in the current table
const makeOutdated = (repoId = REPO) =>
  Effect.gen(function* () {
    yield* RepoStore.use((store) => store.updateRepo(repoId, { indexFormat: 1 }))
    yield* Indexer.use((indexer) => indexer.removeIndex(repoId))
  })

const indexFormat = (repoId = REPO) =>
  RepoStore.use((store) => store.getRepo(repoId)).pipe(Effect.map((repo) => Option.getOrThrow(repo).indexFormat))

// The legacy table a format-1 index has, with one row per file
const createLegacyTable = (indexDir: string) =>
  Effect.promise(async () => {
    const db = await lancedb.connect(indexDir)
    await db.createTable("files", [
      { id: "x", repo: REPO, path: "a.ts", filename: "a.ts", contents: "", mtime_ms: 0, size_bytes: 0, hash: "" }
    ])
  })

const tableNames = (indexDir: string) => Effect.promise(async () => (await lancedb.connect(indexDir)).tableNames())

describe("reindexRepo job", () => {
  it.effect("re-indexes every file and stamps the current format", () => {
    const source = makeSourceRepo(5)
    const env = testEnv()
    return Effect.gen(function* () {
      yield* addRepo(source.dir)
      yield* makeOutdated()
      expect(yield* indexedPaths(REPO)).toEqual([])

      const job = yield* reindexRepo()

      expect(job.status).toBe("completed")
      expect(stepOf(job, "planFullIndex").output).toMatchObject({ toIndex: 5 })
      expect(yield* indexedPaths(REPO)).toHaveLength(5)
      expect(yield* indexFormat()).toBe(CURRENT_INDEX_FORMAT)
    }).pipe(Effect.provide(env.layer))
  }, 60_000)

  it.effect("records the commit date of a repo synced before commit dates were recorded", () => {
    const source = makeSourceRepo(3)
    source.write("later.ts", "export const later = true\n")
    source.commit("later", "2026-01-02T03:04:05Z")
    const env = testEnv()
    return Effect.gen(function* () {
      yield* addRepo(source.dir)
      yield* RepoStore.use((store) => store.updateRepo(REPO, { lastSyncedCommitAt: undefined }))
      yield* makeOutdated()

      yield* reindexRepo()

      const repo = Option.getOrThrow(yield* RepoStore.use((store) => store.getRepo(REPO)))
      expect(repo.lastSyncedCommitAt).toEqual(DateTime.makeUnsafe("2026-01-02T03:04:05Z"))
    }).pipe(Effect.provide(env.layer))
  }, 60_000)

  it.effect("re-indexes files already in the current table too", () => {
    const source = makeSourceRepo(3)
    const env = testEnv()
    return Effect.gen(function* () {
      yield* addRepo(source.dir)
      // Stamped old, but its files are indexed: a format change must still re-embed them
      yield* RepoStore.use((store) => store.updateRepo(REPO, { indexFormat: 1 }))

      const job = yield* reindexRepo()

      expect(stepOf(job, "planFullIndex").output).toMatchObject({ toIndex: 3, skipped: 0 })
    }).pipe(Effect.provide(env.layer))
  }, 60_000)

  it.effect("runs for pinned repos, which sync skips", () => {
    const source = makeSourceRepo(3)
    const env = testEnv()
    return Effect.gen(function* () {
      yield* addRepo(source.dir)
      yield* RepoStore.use((store) => store.updateRepo(REPO, { mode: pinnedMode(source.head()) }))
      yield* makeOutdated()

      expect((yield* syncRepo()).status).toBe("skipped")
      const job = yield* reindexRepo()

      expect(job.status).toBe("completed")
      expect(yield* indexedPaths(REPO)).toHaveLength(3)
      expect(yield* indexFormat()).toBe(CURRENT_INDEX_FORMAT)
    }).pipe(Effect.provide(env.layer))
  }, 60_000)

  it.effect("drops the legacy table once the last outdated repo is re-indexed", () => {
    const one = makeSourceRepo(2)
    const two = makeSourceRepo(2)
    const env = testEnv()
    return Effect.gen(function* () {
      yield* addRepo(one.dir, "acme-one")
      yield* addRepo(two.dir, "acme-two")
      yield* makeOutdated("acme-one")
      yield* makeOutdated("acme-two")
      yield* createLegacyTable(env.indexDir)

      const first = yield* reindexRepo("acme-one")
      expect(stepOf(first, "checkLegacyIndex").output).toEqual({ unused: false })
      expect(yield* tableNames(env.indexDir)).toContain("files")

      const second = yield* reindexRepo("acme-two")
      expect(stepOf(second, "checkLegacyIndex").output).toEqual({ unused: true })
      expect(yield* tableNames(env.indexDir)).not.toContain("files")
    }).pipe(Effect.provide(env.layer))
  }, 60_000)
})

describe("syncRepo job on a repo in an old index format", () => {
  it.effect("re-indexes every file even when the remote hasn't changed", () => {
    const source = makeSourceRepo(4)
    const env = testEnv()
    return Effect.gen(function* () {
      yield* addRepo(source.dir)
      yield* makeOutdated()

      const job = yield* syncRepo()

      expect(job.status).toBe("completed")
      expect(statuses(job)).toMatchObject({ resetHard: "done", planChanges: "done", updateStore: "done" })
      expect(stepOf(job, "planChanges").output).toMatchObject({ toIndex: 4, fullScan: true })
      expect(yield* indexedPaths(REPO)).toHaveLength(4)
      expect(yield* indexFormat()).toBe(CURRENT_INDEX_FORMAT)
    }).pipe(Effect.provide(env.layer))
  }, 60_000)
})
