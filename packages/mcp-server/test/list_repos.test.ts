import { describe, expect, it } from "@effect/vitest";
import { RepobaseEngine, type RepoConfig } from "@repobase/engine";
import {
  createMockEngineLayer,
  makeDefaultMockEngineState,
  type MockEngineState,
} from "@repobase/engine/test-utils";
import { Effect, Option } from "effect";

const { listRepos } = Effect.serviceFunctions(RepobaseEngine);

const makeRepo = (id: string, overrides: Partial<RepoConfig> = {}): RepoConfig => ({
  id,
  url: `https://github.com/test/${id}`,
  localPath: `/mock/.repobase/repos/${id}`,
  mode: { _tag: "tracking", branch: "main" },
  lastSyncedCommit: Option.some("abc123"),
  lastSyncedAt: Option.some(new Date("2024-06-15")),
  addedAt: new Date("2024-06-10"),
  cloudEnabled: false,
  lastPushedAt: Option.none(),
  lastPushedCommit: Option.none(),
  ...overrides,
});

describe("MCP list_repos tool", () => {
  it.effect("returns empty list when no repos", () =>
    Effect.gen(function* () {
      const repos = yield* listRepos();
      expect(repos).toHaveLength(0);
    }).pipe(Effect.provide(createMockEngineLayer())),
  );

  it.effect("returns all repos", () =>
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

  it.effect("returns correct fields for handler response", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      const addedAt = new Date("2024-06-10");
      state.engine.repos.push(makeRepo("test-repo", { addedAt }));
      const repos = yield* listRepos().pipe(Effect.provide(createMockEngineLayer(state)));
      const repo = repos[0];

      const mapped = {
        id: repo.id,
        url: repo.url,
        localPath: repo.localPath,
        lastSyncedAt:
          repo.lastSyncedAt._tag === "Some" ? repo.lastSyncedAt.value.toISOString() : null,
        addedAt: repo.addedAt.toISOString(),
      };

      expect(mapped.id).toBe("test-repo");
      expect(mapped.url).toBe("https://github.com/test/test-repo");
      expect(mapped.lastSyncedAt).toBe("2024-06-15T00:00:00.000Z");
      expect(mapped.addedAt).toBe("2024-06-10T00:00:00.000Z");
    }),
  );

  it.effect("maps Option.none lastSyncedAt to null", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.engine.repos.push(makeRepo("nosync", { lastSyncedAt: Option.none() }));
      const repos = yield* listRepos().pipe(Effect.provide(createMockEngineLayer(state)));
      const mapped = {
        id: repos[0].id,
        lastSyncedAt:
          repos[0].lastSyncedAt._tag === "Some" ? repos[0].lastSyncedAt.value.toISOString() : null,
      };
      expect(mapped.lastSyncedAt).toBeNull();
    }),
  );
});
