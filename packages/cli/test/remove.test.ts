import { describe, expect, it } from "@effect/vitest";
import { RepobaseEngine, trackingMode, type RepoConfig } from "@repobase/engine";
import {
  createMockEngineLayer,
  makeDefaultMockEngineState,
  type MockEngineState,
} from "@repobase/engine/test-utils";
import { Effect, Option } from "effect";

const { removeRepo } = Effect.serviceFunctions(RepobaseEngine);

const makeRepo = (id: string): RepoConfig => ({
  id,
  url: `https://github.com/test/${id}`,
  localPath: `/mock/.repobase/repos/${id}`,
  mode: trackingMode("main"),
  lastSyncedCommit: Option.some("abc"),
  lastSyncedAt: Option.some(new Date()),
  addedAt: new Date(),
  cloudEnabled: false,
  lastPushedAt: Option.none(),
  lastPushedCommit: Option.none(),
});

describe("remove command", () => {
  it.effect("removes an existing repo", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.engine.repos.push(makeRepo("to-remove"));
      yield* removeRepo("to-remove").pipe(Effect.provide(createMockEngineLayer(state)));
      expect(state.engine.repos).toHaveLength(0);
    }),
  );

  it.effect("fails for non-existent repo", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(removeRepo("nope"));
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(createMockEngineLayer())),
  );

  it.effect("only removes the targeted repo", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.engine.repos.push(makeRepo("keep"));
      state.engine.repos.push(makeRepo("delete"));
      yield* removeRepo("delete").pipe(Effect.provide(createMockEngineLayer(state)));
      expect(state.engine.repos).toHaveLength(1);
      expect(state.engine.repos[0].id).toBe("keep");
    }),
  );

  it.effect("removeRepo on already-removed id fails", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.engine.repos.push(makeRepo("gone"));
      yield* removeRepo("gone").pipe(Effect.provide(createMockEngineLayer(state)));
      const result = yield* Effect.exit(
        removeRepo("gone").pipe(Effect.provide(createMockEngineLayer(state))),
      );
      expect(result._tag).toBe("Failure");
    }),
  );
});
