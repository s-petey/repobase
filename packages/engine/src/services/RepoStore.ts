import { Context, Effect, FileSystem, Layer, Option, Schema, Semaphore } from "effect"
import { StoreError } from "../errors.js"
import { RepoConfig, RepoStoreData } from "../schemas.js"
import * as os from "os"

/**
 * RepoStore service interface
 */
export interface RepoStoreService {
  readonly load: () => Effect.Effect<RepoStoreData, StoreError>
  readonly save: (data: RepoStoreData) => Effect.Effect<void, StoreError>
  readonly getRepo: (id: string) => Effect.Effect<Option.Option<RepoConfig>, StoreError>
  readonly addRepo: (repo: RepoConfig) => Effect.Effect<void, StoreError>
  readonly updateRepo: (
    id: string,
    update: Partial<Omit<RepoConfig, "id">>
  ) => Effect.Effect<void, StoreError>
  readonly removeRepo: (id: string) => Effect.Effect<void, StoreError>
  // Load, change and save in one step, so no other change in this process lands in between
  readonly modify: (f: (data: RepoStoreData) => RepoStoreData) => Effect.Effect<void, StoreError>
}

/**
 * RepoStore service tag
 */
export class RepoStore extends Context.Service<RepoStore, RepoStoreService>()(
  "@repobase/engine/RepoStore"
) {}

/**
 * Helper to convert errors to StoreError
 */
const toStoreError =
  (operation: string) =>
  (error: unknown): StoreError =>
    new StoreError({
      operation,
      message: error instanceof Error ? error.message : String(error)
    })

const RepoStoreJson = Schema.fromJsonString(RepoStoreData)

/**
 * Get the config file path
 */
const getConfigPath = () => `${os.homedir()}/.repobase/config.json`

/**
 * Get the repobase directory path
 */
const getRepobaseDir = () => `${os.homedir()}/.repobase`

/**
 * Create the RepoStore service implementation
 */
export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const configPath = getConfigPath()
  const repobaseDir = getRepobaseDir()

  // Concurrent jobs change the config; each change loads and saves it whole
  const writeLock = yield* Semaphore.make(1)

  const load: RepoStoreService["load"] = () =>
    Effect.gen(function* () {
      const exists = yield* fs.exists(configPath)
      if (!exists) {
        return { version: 1 as const, repos: [] }
      }
      const content = yield* fs.readFileString(configPath)
      return yield* Schema.decodeUnknownEffect(RepoStoreJson)(content)
    }).pipe(Effect.mapError(toStoreError("load")))

  // Written to a temp file and renamed over the config, so another process
  // (the MCP server) never reads it half-written
  const write = (data: RepoStoreData) =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(RepoStoreData)(data)
      yield* fs.makeDirectory(repobaseDir, { recursive: true })
      const tmp = `${configPath}.tmp-${process.pid}`
      yield* fs.writeFileString(tmp, JSON.stringify(encoded, null, 2))
      yield* fs.rename(tmp, configPath)
    }).pipe(Effect.mapError(toStoreError("save")))

  const save: RepoStoreService["save"] = (data) => writeLock.withPermit(write(data))

  const modify: RepoStoreService["modify"] = (f) =>
    writeLock.withPermit(load().pipe(Effect.flatMap((data) => write(f(data)))))

  const getRepo: RepoStoreService["getRepo"] = (id) =>
    load().pipe(Effect.map((data) => Option.fromNullishOr(data.repos.find((r) => r.id === id))))

  const addRepo: RepoStoreService["addRepo"] = (repo) =>
    modify((data) => ({ ...data, repos: [...data.repos, repo] }))

  const updateRepo: RepoStoreService["updateRepo"] = (id, update) =>
    modify((data) => ({ ...data, repos: data.repos.map((r) => (r.id === id ? { ...r, ...update } : r)) }))

  const removeRepo: RepoStoreService["removeRepo"] = (id) =>
    modify((data) => ({ ...data, repos: data.repos.filter((r) => r.id !== id) }))

  return RepoStore.of({
    load,
    save,
    getRepo,
    addRepo,
    updateRepo,
    removeRepo,
    modify
  })
})

/**
 * RepoStore layer - requires FileSystem
 */
export const layer = Layer.effect(RepoStore, make)
