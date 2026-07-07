import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { RepobaseEngine } from "@repobase/engine";
import {
  createMockEngineLayer,
  makeDefaultMockEngineState,
  type MockEngineState,
} from "@repobase/engine/test-utils";

const { addRepo, listRepos } = Effect.serviceFunctions(RepobaseEngine);

describe("add command", () => {
  it.effect("adds a repo with tracking mode (default)", () =>
    Effect.gen(function* () {
      const repo = yield* addRepo("https://github.com/test/my-repo");
      expect(repo.id).toBe("test-my-repo");

      if (repo.mode._tag !== "tracking") {
        throw new Error("invalid test case");
      }

      expect(repo.mode._tag).toBe("tracking");
      expect(repo.mode.branch).toBe("main");
      expect(repo.url).toBe("https://github.com/test/my-repo");
    }).pipe(Effect.provide(createMockEngineLayer())),
  );

  it.effect("persists the repo in the store", () =>
    Effect.gen(function* () {
      yield* addRepo("https://github.com/test/persist-me");
      const repos = yield* listRepos();
      expect(repos).toHaveLength(1);
      expect(repos[0].id).toBe("test-persist-me");
    }).pipe(Effect.provide(createMockEngineLayer())),
  );

  it.effect("fails with RepoAlreadyExistsError for duplicate url", () =>
    Effect.gen(function* () {
      yield* addRepo("https://github.com/test/dup");
      const result = yield* Effect.exit(addRepo("https://github.com/test/dup"));
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(createMockEngineLayer())),
  );

  it.effect("accepts addRepoErrors via state config", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.engine.addRepoErrors.push("https://github.com/test/error-repo");
      const result = yield* Effect.exit(addRepo("https://github.com/test/error-repo")).pipe(
        Effect.provide(createMockEngineLayer(state)),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("adds multiple repos", () =>
    Effect.gen(function* () {
      yield* addRepo("https://github.com/test/one");
      yield* addRepo("https://github.com/test/two");
      const repos = yield* listRepos();
      expect(repos).toHaveLength(2);
    }).pipe(Effect.provide(createMockEngineLayer())),
  );
});
