import { Effect, Layer, Option, SubscriptionRef } from "effect";
import { RepoAlreadyExistsError, RepoNotFoundError } from "../errors.js";
import type { RepoConfig } from "../schemas.js";
import type { SearchMode, SearchOptions, SearchResult } from "../services/Indexer.js";
import type { AddRepoOptions, SyncResult } from "../services/RepobaseEngine.js";
import { RepobaseEngine } from "../services/RepobaseEngine.js";
import { deriveRepoId, extractRepoParts, trackingMode } from "../utils.js";

export interface MockRepobaseEngineState {
  repos: RepoConfig[];
  addRepoErrors: string[];
  syncResults: Map<string, SyncResult>;
  searchResults: SearchResult[];
}

export const makeDefaultEngineState = (): MockRepobaseEngineState => ({
  repos: [],
  addRepoErrors: [],
  syncResults: new Map(),
  searchResults: [],
});

export const mockRepobaseEngineLayer = (
  state: MockRepobaseEngineState = makeDefaultEngineState(),
): Layer.Layer<RepobaseEngine> =>
  Layer.succeed(
    RepobaseEngine,
    RepobaseEngine.of({
      addRepo: (url: string, options?: AddRepoOptions) =>
        Effect.gen(function* () {
          if (state.addRepoErrors.includes(url)) {
            return yield* Effect.fail(new RepoAlreadyExistsError({ id: deriveRepoId(url) }));
          }

          const { owner, name } = extractRepoParts(url);
          const id = `${owner}-${name}`;
          if (state.repos.some((r) => r.id === id)) {
            return yield* Effect.fail(new RepoAlreadyExistsError({ id }));
          }

          const repo: RepoConfig = {
            id,
            url,
            owner,
            name,
            localPath: `/mock/.repobase/repos/${id}`,
            mode: options?.mode ?? trackingMode("main"),
            lastSyncedCommit: Option.some("mock-commit"),
            lastSyncedAt: Option.some(new Date()),
            addedAt: new Date(),
            cloudEnabled: false,
            lastPushedAt: Option.none(),
            lastPushedCommit: Option.none(),
          };
          state.repos.push(repo);

          if (options?.progressRef) {
            yield* SubscriptionRef.update(options.progressRef, () => ({
              stage: "complete" as const,
              progress: 100,
              message: `Added ${id}`,
              filesIndexed: 3,
              totalFiles: 3,
            }));
          }

          return repo;
        }).pipe(Effect.mapError((e) => e)),

      removeRepo: (id: string) =>
        Effect.gen(function* () {
          const idx = state.repos.findIndex((r) => r.id === id);
          if (idx === -1) {
            return yield* Effect.fail(new RepoNotFoundError({ id }));
          }
          state.repos.splice(idx, 1);
        }).pipe(Effect.mapError((e) => e)),

      listRepos: () => Effect.succeed([...state.repos]),

      getRepo: (id: string) =>
        Effect.succeed(Option.fromNullable(state.repos.find((r) => r.id === id))),

      syncRepo: (id: string) =>
        Effect.gen(function* () {
          const repo = state.repos.find((r) => r.id === id);
          if (!repo) {
            return yield* Effect.fail(new RepoNotFoundError({ id }));
          }

          const existing = state.syncResults.get(id);
          if (existing) {
            return existing;
          }

          const result: SyncResult = {
            id,
            updated: true,
            previousCommit: repo.lastSyncedCommit,
            currentCommit: "mock-new-commit",
          };
          state.syncResults.set(id, result);
          return result;
        }).pipe(Effect.mapError((e) => e)),

      syncAll: () =>
        Effect.forEach([...state.repos], (repo) =>
          Effect.succeed({
            id: repo.id,
            updated: true,
            previousCommit: repo.lastSyncedCommit,
            currentCommit: "mock-new-commit",
          }),
        ),

      search: (query: string, _mode: SearchMode, options?: SearchOptions) => {
        const results =
          state.searchResults.length > 0
            ? state.searchResults
            : [
                {
                  repo: "mock-repo",
                  path: "src/file.ts",
                  filename: "file.ts",
                  score: 0.95,
                  snippet: Option.some(`...${query}...`),
                },
              ];
        return Effect.succeed(
          options?.repo ? results.filter((r) => r.repo === options.repo) : results,
        );
      },
    }),
  );
