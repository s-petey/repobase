import { describe, expect, it } from "@effect/vitest";
import {
  Indexer,
  RepobaseEngine,
  RepobaseEngineLayer,
  GitClientLayer,
  RepoStoreLayer,
  IndexerLayer,
} from "@repobase/engine";
import {
  createMockEngineLayer,
  makeDefaultMockEngineState,
  type MockEngineState,
} from "@repobase/engine/test-utils";
import { Effect, Layer, Option } from "effect";

describe("MCP server runtime", () => {
  it("can compose mock layers", () => {
    const layer = createMockEngineLayer();
    expect(layer).toBeDefined();
  });

  it.effect("can provide mock layers to an effect", () =>
    Effect.gen(function* () {
      const engine = yield* RepobaseEngine;
      const repos = yield* engine.listRepos();
      expect(repos).toEqual([]);
    }).pipe(Effect.provide(createMockEngineLayer())),
  );

  it.effect("mock layer provides Indexer service", () =>
    Effect.gen(function* () {
      const indexer = yield* Indexer;
      expect(indexer).toBeDefined();
    }).pipe(Effect.provide(createMockEngineLayer())),
  );

  it.effect("real layers compose without error", () =>
    Effect.gen(function* () {
      const EngineLive = RepobaseEngineLayer.pipe(
        Layer.provide(GitClientLayer),
        Layer.provide(RepoStoreLayer),
        Layer.provide(IndexerLayer),
      );
      const layer = Layer.mergeAll(EngineLive, IndexerLayer);
      yield* Effect.log("");
      expect(layer).toBeDefined();
    }),
  );

  it("mock state can be customized per test", () => {
    const state: MockEngineState = makeDefaultMockEngineState();
    state.engine.repos.push({
      id: "custom",
      url: "https://github.com/test/custom",
      localPath: "/mock/.repobase/repos/custom",
      mode: { _tag: "tracking", branch: "main" },
      lastSyncedCommit: Option.none(),
      lastSyncedAt: Option.none(),
      addedAt: new Date(),
      cloudEnabled: false,
      lastPushedAt: Option.none(),
      lastPushedCommit: Option.none(),
    });
    expect(state.engine.repos).toHaveLength(1);
    expect(state.engine.repos[0].id).toBe("custom");
  });
});
