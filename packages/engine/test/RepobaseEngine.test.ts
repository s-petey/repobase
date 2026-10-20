import { describe, it, expect } from "@effect/vitest"
import { BunServices } from "@effect/platform-bun"
import * as lancedb from "@lancedb/lancedb"
import { DateTime, Effect, FileSystem, Layer, Option, Path } from "effect"
import { execSync } from "node:child_process"
import { CURRENT_INDEX_FORMAT } from "../src/indexFormat.js"
import type { RepoConfig } from "../src/schemas.js"
import { layer as GitClientLayer } from "../src/services/GitClient.js"
import { Indexer, layerWith as IndexerLayerWith } from "../src/services/Indexer.js"
import { layerWith as RepobaseEngineLayerWith, RepobaseEngine } from "../src/services/RepobaseEngine.js"
import { RepoStore } from "../src/services/RepoStore.js"
import { pinnedMode, trackingMode } from "../src/utils.js"
import { indexedPaths, makeSourceRepo, MemoryRepoStore, tempDir } from "./fixtures/jobEnv.js"


const REPO = "acme-widgets"
const fakeEmbed = async () => Array.from({ length: 384 }, (_, i) => (i + 1) / 384)

const setup = (
  source: ReturnType<typeof makeSourceRepo>,
  mode: RepoConfig["mode"] = trackingMode("main"),
  reposDir = tempDir("repos")
) => {
  const indexDir = tempDir("index")
  const localPath = tempDir("clone")
  execSync(`git clone -q ${source.dir} ${localPath}`)
  const repo: RepoConfig = {
    id: REPO,
    url: source.dir,
    localPath,
    mode,
    lastSyncedCommit: Option.some(source.head()),
    lastSyncedAt: Option.none(),
    addedAt: DateTime.makeUnsafe(0),
    cloudEnabled: false,
    lastPushedAt: Option.none(),
    lastPushedCommit: Option.none(),
    indexFormat: 1
  }
  const layer = RepobaseEngineLayerWith({ reposDir }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(GitClientLayer, MemoryRepoStore, IndexerLayerWith({ indexDir, embed: fakeEmbed }))
    ),
    Layer.provideMerge(BunServices.layer)
  )
  const addRepo = RepoStore.use((store) => store.addRepo(repo))
  return { indexDir, layer, addRepo }
}

const indexFormat = RepoStore.use((store) => store.getRepo(REPO)).pipe(
  Effect.map((repo) => Option.getOrThrow(repo).indexFormat)
)

describe("RepobaseEngine on a repo in an old index format", () => {
  it.effect("syncRepo re-indexes every file even when the remote hasn't changed", () => {
    const source = makeSourceRepo(4)
    const env = setup(source)
    return Effect.gen(function* () {
      yield* env.addRepo
      const engine = yield* RepobaseEngine

      const result = yield* engine.syncRepo(REPO)

      expect(result.updated).toBe(true)
      expect(result.indexSummary?.filesIndexed).toBe(4)
      expect(yield* indexedPaths(REPO)).toHaveLength(4)
      expect(yield* indexFormat).toBe(CURRENT_INDEX_FORMAT)

      // Now current: the next sync with nothing new does nothing
      expect((yield* engine.syncRepo(REPO)).updated).toBe(false)
    }).pipe(Effect.provide(env.layer))
  }, 60_000)

  it.effect("reindexRepo re-indexes a pinned repo, which sync skips", () => {
    const source = makeSourceRepo(3)
    const env = setup(source, pinnedMode(source.head()))
    return Effect.gen(function* () {
      yield* env.addRepo
      const engine = yield* RepobaseEngine

      expect((yield* engine.syncRepo(REPO)).updated).toBe(false)
      const summary = yield* engine.reindexRepo(REPO)

      expect(summary.filesIndexed).toBe(3)
      expect(yield* indexFormat).toBe(CURRENT_INDEX_FORMAT)
      // Recorded from the clone, for repos synced before commit dates were
      const repo = Option.getOrThrow(yield* engine.getRepo(REPO))
      expect(repo.lastSyncedCommitAt && DateTime.toEpochMillis(repo.lastSyncedCommitAt)).toBe(source.commitTime())
    }).pipe(Effect.provide(env.layer))
  }, 60_000)

  it.effect("reindexRepo gives a repo with an id from before owner/name ids its new id", () => {
    const source = makeSourceRepo(3)
    const reposDir = tempDir("repos")
    const env = setup(source, trackingMode("main"), reposDir)
    return Effect.gen(function* () {
      yield* env.addRepo
      yield* RepoStore.use((store) => store.updateRepo(REPO, { url: "https://github.com/acme/widgets" }))
      const oldClone = Option.getOrThrow(yield* RepoStore.use((store) => store.getRepo(REPO))).localPath
      // Something indexed under the old id
      yield* Indexer.use((indexer) => indexer.indexRepo(REPO, oldClone))
      const engine = yield* RepobaseEngine

      const summary = yield* engine.reindexRepo(REPO)

      expect(summary.id).toBe("acme/widgets")
      const ids = (yield* engine.listRepos()).map((r) => r.id)
      expect(ids).toEqual(["acme/widgets"])
      const repo = Option.getOrThrow(yield* engine.getRepo("acme/widgets"))
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      expect(repo.localPath).toBe(path.join(reposDir, "acme", "widgets"))
      expect(yield* fs.exists(path.join(repo.localPath, "file-00.ts"))).toBe(true)
      expect(yield* fs.exists(oldClone)).toBe(false)
      expect(repo.indexFormat).toBe(CURRENT_INDEX_FORMAT)
      expect(yield* indexedPaths(REPO)).toEqual([])
      expect(yield* indexedPaths("acme/widgets")).toHaveLength(3)

      // Current ids are left alone
      expect(yield* engine.migrateRepoId("acme/widgets")).toBe("acme/widgets")
    }).pipe(Effect.provide(env.layer))
  }, 60_000)

  it.effect("migrateRepoId removes an old copy of a repo that was added again under its new id", () => {
    const source = makeSourceRepo(2)
    const env = setup(source, trackingMode("main"), tempDir("repos"))
    return Effect.gen(function* () {
      yield* env.addRepo
      yield* RepoStore.use((store) => store.updateRepo(REPO, { url: "https://github.com/acme/widgets" }))
      const old = Option.getOrThrow(yield* RepoStore.use((store) => store.getRepo(REPO)))
      yield* RepoStore.use((store) => store.addRepo({ ...old, id: "acme/widgets", localPath: tempDir("clone") }))
      const engine = yield* RepobaseEngine

      expect(yield* engine.migrateRepoId(REPO)).toBe("acme/widgets")
      expect((yield* engine.listRepos()).map((r) => r.id)).toEqual(["acme/widgets"])
      expect(yield* FileSystem.FileSystem.use((fs) => fs.exists(old.localPath))).toBe(false)
    }).pipe(Effect.provide(env.layer))
  }, 60_000)

  it.effect("drops the legacy table once no repo needs it", () => {
    const source = makeSourceRepo(2)
    const env = setup(source)
    return Effect.gen(function* () {
      yield* env.addRepo
      yield* Effect.promise(async () => {
        const db = await lancedb.connect(env.indexDir)
        await db.createTable("files", [{ id: "x", repo: REPO, path: "a.ts" }])
      })

      yield* (yield* RepobaseEngine).reindexRepo(REPO)

      const tables = yield* Effect.promise(async () => (await lancedb.connect(env.indexDir)).tableNames())
      expect(tables).not.toContain("files")
    }).pipe(Effect.provide(env.layer))
  }, 60_000)
})
