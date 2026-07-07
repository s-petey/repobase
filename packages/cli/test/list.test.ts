import { describe, expect, it } from "@effect/vitest";
import { pinnedMode, RepobaseEngine, trackingMode, type RepoConfig } from "@repobase/engine";
import {
  createMockEngineLayer,
  makeDefaultMockEngineState,
  type MockEngineState,
} from "@repobase/engine/test-utils";
import { Effect, Option } from "effect";

const { listRepos, getRepo } = Effect.serviceFunctions(RepobaseEngine);

const makeRepo = (id: string, overrides: Partial<RepoConfig> = {}): RepoConfig => ({
  id,
  url: `https://github.com/test/${id}`,
  localPath: `/mock/.repobase/repos/${id}`,
  mode: trackingMode("main"),
  lastSyncedCommit: Option.some("abc123"),
  lastSyncedAt: Option.some(new Date("2024-06-15")),
  addedAt: new Date("2024-06-10"),
  cloudEnabled: false,
  lastPushedAt: Option.none(),
  lastPushedCommit: Option.none(),
  ...overrides,
});

describe("list command", () => {
  it.effect("returns empty list when no repos", () =>
    Effect.gen(function* () {
      const repos = yield* listRepos();
      expect(repos).toHaveLength(0);
    }).pipe(Effect.provide(createMockEngineLayer())),
  );

  it.effect("returns all added repos", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.engine.repos.push(makeRepo("alpha"));
      state.engine.repos.push(makeRepo("beta"));
      const repos = yield* listRepos().pipe(Effect.provide(createMockEngineLayer(state)));
      expect(repos).toHaveLength(2);
      expect(repos[0].id).toBe("alpha");
      expect(repos[1].id).toBe("beta");
    }),
  );

  it.effect("returns repo with correct fields", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.engine.repos.push(makeRepo("detailed"));
      const repos = yield* listRepos().pipe(Effect.provide(createMockEngineLayer(state)));
      const repo = repos[0];
      expect(repo).toHaveProperty("id");
      expect(repo).toHaveProperty("url");
      expect(repo).toHaveProperty("localPath");
      expect(repo).toHaveProperty("mode");
      expect(repo).toHaveProperty("addedAt");
      expect(repo).toHaveProperty("cloudEnabled");
    }),
  );

  it.effect("can get a single repo by id", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.engine.repos.push(makeRepo("single"));
      const repo = yield* getRepo("single").pipe(Effect.provide(createMockEngineLayer(state)));
      expect(Option.isSome(repo)).toBe(true);
      if (Option.isSome(repo)) {
        expect(repo.value.id).toBe("single");
      }
    }),
  );

  it.effect("returns None for non-existent repo", () =>
    Effect.gen(function* () {
      const repo = yield* getRepo("nope");
      expect(Option.isNone(repo)).toBe(true);
    }).pipe(Effect.provide(createMockEngineLayer())),
  );

  it.effect("reports cloud-enabled repos", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.engine.repos.push(makeRepo("local-repo"));
      state.engine.repos.push(makeRepo("cloud-repo", { cloudEnabled: true }));
      const repos = yield* listRepos().pipe(Effect.provide(createMockEngineLayer(state)));
      expect(repos.find((r) => r.cloudEnabled)!.id).toBe("cloud-repo");
      expect(repos.find((r) => !r.cloudEnabled)!.id).toBe("local-repo");
    }),
  );

  it.effect("supports pinned mode repos", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.engine.repos.push(makeRepo("pinned-repo", { mode: pinnedMode("v1.0.0") }));
      const repos = yield* listRepos().pipe(Effect.provide(createMockEngineLayer(state)));
      const repo = repos[0];
      expect(repo.mode._tag).toBe("pinned");
      if (repo.mode._tag === "pinned") {
        expect(repo.mode.ref).toBe("v1.0.0");
      }
    }),
  );
});
