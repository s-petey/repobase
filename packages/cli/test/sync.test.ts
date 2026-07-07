import { describe, expect, it } from "@effect/vitest";
import { RepobaseEngine, trackingMode, type RepoConfig } from "@repobase/engine";
import {
  createMockEngineLayer,
  makeDefaultMockEngineState,
  type MockEngineState,
} from "@repobase/engine/test-utils";
import { Effect, Option } from "effect";

const { syncRepo, syncAll } = Effect.serviceFunctions(RepobaseEngine);

const makeRepo = (id: string): RepoConfig => ({
  id,
  url: `https://github.com/test/${id}`,
  localPath: `/mock/.repobase/repos/${id}`,
  mode: trackingMode("main"),
  lastSyncedCommit: Option.some("commit-a"),
  lastSyncedAt: Option.some(new Date()),
  addedAt: new Date(),
  cloudEnabled: false,
  lastPushedAt: Option.none(),
  lastPushedCommit: Option.none(),
});

describe("sync command", () => {
  it.effect("syncs a repo and reports updated=true", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.engine.repos.push(makeRepo("sync-me"));
      const result = yield* syncRepo("sync-me").pipe(Effect.provide(createMockEngineLayer(state)));
      expect(result.id).toBe("sync-me");
      expect(result.updated).toBe(true);
      expect(result.currentCommit).toBe("mock-new-commit");
    }),
  );

  it.effect("syncs all repos", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.engine.repos.push(makeRepo("repo-a"));
      state.engine.repos.push(makeRepo("repo-b"));
      const results = yield* syncAll().pipe(Effect.provide(createMockEngineLayer(state)));
      expect(results).toHaveLength(2);
      for (const r of results) {
        expect(r.updated).toBe(true);
      }
    }),
  );

  it.effect("fails with RepoNotFoundError for non-existent repo", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(syncRepo("nope"));
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(createMockEngineLayer())),
  );

  it.effect("syncs empty list when no repos", () =>
    Effect.gen(function* () {
      const results = yield* syncAll();
      expect(results).toHaveLength(0);
    }).pipe(Effect.provide(createMockEngineLayer())),
  );

  it.effect("reports already-up-to-date via mock syncResults", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.engine.repos.push(makeRepo("uptodate"));
      state.engine.syncResults.set("uptodate", {
        id: "uptodate",
        updated: false,
        previousCommit: Option.some("same-commit"),
        currentCommit: "same-commit",
      });
      const result = yield* syncRepo("uptodate").pipe(Effect.provide(createMockEngineLayer(state)));
      expect(result.updated).toBe(false);
    }),
  );

  it.effect("syncAll overrides empty syncResults", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.engine.repos.push(makeRepo("fresh"));
      state.engine.repos.push(makeRepo("fresh2"));
      const results = yield* syncAll().pipe(Effect.provide(createMockEngineLayer(state)));
      for (const r of results) {
        expect(r.updated).toBe(true);
      }
    }),
  );
});
