import { FileSystem } from "@effect/platform";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { StoreError } from "../errors.js";
import { RepoConfig, RepoStoreData, RepoStoreDataV1 } from "../schemas.js";
import { extractRepoParts } from "../utils.js";
import * as os from "os";

/**
 * RepoStore service interface
 */
export interface RepoStoreService {
  readonly load: () => Effect.Effect<RepoStoreData, StoreError>;
  readonly save: (data: RepoStoreData) => Effect.Effect<void, StoreError>;
  readonly getRepo: (id: string) => Effect.Effect<Option.Option<RepoConfig>, StoreError>;
  readonly addRepo: (repo: RepoConfig) => Effect.Effect<void, StoreError>;
  readonly updateRepo: (
    id: string,
    update: Partial<Omit<RepoConfig, "id">>,
  ) => Effect.Effect<void, StoreError>;
  readonly removeRepo: (id: string) => Effect.Effect<void, StoreError>;
}

/**
 * RepoStore service tag
 */
export class RepoStore extends Context.Tag("@repobase/engine/RepoStore")<
  RepoStore,
  RepoStoreService
>() {}

/**
 * Helper to convert errors to StoreError
 */
const toStoreError =
  (operation: string) =>
  (error: unknown): StoreError =>
    new StoreError({
      operation,
      message: error instanceof Error ? error.message : String(error),
    });

/**
 * Get the config file path
 */
const getConfigPath = () => `${os.homedir()}/.repobase/config.json`;

/**
 * Get the repobase directory path
 */
const getRepobaseDir = () => `${os.homedir()}/.repobase`;

/**
 * Create the RepoStore service implementation
 */
export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const configPath = getConfigPath();
  const repobaseDir = getRepobaseDir();

  const load: RepoStoreService["load"] = () =>
    Effect.gen(function* () {
      const exists = yield* fs.exists(configPath);
      if (!exists) {
        return { version: 1 as const, repos: [] };
      }
      const content = yield* fs.readFileString(configPath);
      const raw = JSON.parse(content);

      // Fast path: current format (with owner/name)
      const decoded = yield* Effect.either(Schema.decodeUnknown(RepoStoreData)(raw));
      if (decoded._tag === "Right") return decoded.right;

      // Fallback: old format — decode as V1 and upgrade
      const v1 = yield* Schema.decodeUnknown(RepoStoreDataV1)(raw);
      const migrated: RepoStoreData = {
        ...v1,
        repos: v1.repos.map((r) => {
          const parts = extractRepoParts(r.url);
          return {
            ...r,
            owner: parts.owner,
            name: parts.name,
          };
        }),
      };

      return migrated;
    }).pipe(Effect.mapError(toStoreError("load")));

  const save: RepoStoreService["save"] = (data) =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encode(RepoStoreData)(data);
      yield* fs.makeDirectory(repobaseDir, { recursive: true });
      yield* fs.writeFileString(configPath, JSON.stringify(encoded, null, 2));
    }).pipe(Effect.mapError(toStoreError("save")));

  const getRepo: RepoStoreService["getRepo"] = (id) =>
    Effect.gen(function* () {
      const data = yield* load();
      const repo = data.repos.find((r) => r.id === id);
      return Option.fromNullable(repo);
    });

  const addRepo: RepoStoreService["addRepo"] = (repo) =>
    Effect.gen(function* () {
      const data = yield* load();
      const updated: RepoStoreData = {
        ...data,
        repos: [...data.repos, repo],
      };
      yield* save(updated);
    });

  const updateRepo: RepoStoreService["updateRepo"] = (id, update) =>
    Effect.gen(function* () {
      const data = yield* load();
      const updated: RepoStoreData = {
        ...data,
        repos: data.repos.map((r) => (r.id === id ? { ...r, ...update } : r)),
      };
      yield* save(updated);
    });

  const removeRepo: RepoStoreService["removeRepo"] = (id) =>
    Effect.gen(function* () {
      const data = yield* load();
      const updated: RepoStoreData = {
        ...data,
        repos: data.repos.filter((r) => r.id !== id),
      };
      yield* save(updated);
    });

  return RepoStore.of({
    load,
    save,
    getRepo,
    addRepo,
    updateRepo,
    removeRepo,
  });
});

/**
 * RepoStore layer - requires FileSystem
 */
export const layer = Layer.effect(RepoStore, make);
