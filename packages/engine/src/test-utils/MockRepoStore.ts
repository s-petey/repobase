import { Effect, Layer, Option } from "effect";
import type { RepoConfig } from "../schemas.js";
import { RepoStore } from "../services/RepoStore.js";

export interface MockRepoStoreState {
  repos: RepoConfig[];
}

export const makeDefaultRepoState = (): MockRepoStoreState => ({
  repos: [],
});

export const mockRepoStoreLayer = (
  state: MockRepoStoreState = makeDefaultRepoState(),
): Layer.Layer<RepoStore> =>
  Layer.succeed(
    RepoStore,
    RepoStore.of({
      load: () => Effect.sync(() => ({ version: 1 as const, repos: [...state.repos] })),

      save: (data) =>
        Effect.sync(() => {
          state.repos = [...data.repos];
        }),

      getRepo: (id) => Effect.sync(() => Option.fromNullable(state.repos.find((r) => r.id === id))),

      addRepo: (repo) =>
        Effect.sync(() => {
          state.repos.push(repo);
        }),

      updateRepo: (id, update) =>
        Effect.sync(() => {
          state.repos = state.repos.map((r) => (r.id === id ? { ...r, ...update } : r));
        }),

      removeRepo: (id) =>
        Effect.sync(() => {
          state.repos = state.repos.filter((r) => r.id !== id);
        }),
    }),
  );
