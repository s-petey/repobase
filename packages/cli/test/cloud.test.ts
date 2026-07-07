import { describe, expect, it } from "@effect/vitest";
import { CloudSync } from "@repobase/engine";
import {
  createMockEngineLayer,
  makeDefaultMockEngineState,
  type MockEngineState,
} from "@repobase/engine/test-utils";
import { Effect, Option } from "effect";

const {
  configure,
  getConfig,
  clearConfig,
  isConfigured,
  enableRepo,
  disableRepo,
  push,
  pushAll,
  pull,
  getStatus,
} = Effect.serviceFunctions(CloudSync);

describe("cloud commands", () => {
  describe("login / configure", () => {
    it.effect("configures cloud sync", () =>
      Effect.gen(function* () {
        const state: MockEngineState = makeDefaultMockEngineState();
        yield* configure({
          userId: "user1",
          apiKey: "key1",
          endpoint: "https://api.example.com",
        }).pipe(Effect.provide(createMockEngineLayer(state)));
        expect(state.cloudSync.configured).toBe(true);
      }),
    );

    it.effect("isConfigured returns true after configure", () =>
      Effect.gen(function* () {
        const state: MockEngineState = makeDefaultMockEngineState();
        yield* configure({ userId: "u", apiKey: "k", endpoint: "https://e.com" }).pipe(
          Effect.provide(createMockEngineLayer(state)),
        );
        const configured = yield* isConfigured().pipe(Effect.provide(createMockEngineLayer(state)));
        expect(configured).toBe(true);
      }),
    );
  });

  describe("logout / clear", () => {
    it.effect("clears cloud config", () =>
      Effect.gen(function* () {
        const state: MockEngineState = makeDefaultMockEngineState();
        state.cloudSync.configured = true;
        state.cloudSync.config = {
          userId: "u",
          apiKey: Option.some("k"),
          endpoint: "https://e.com",
        };
        yield* clearConfig().pipe(Effect.provide(createMockEngineLayer(state)));
        expect(state.cloudSync.configured).toBe(false);
        expect(state.cloudSync.config).toBeNull();
      }),
    );

    it.effect("isConfigured returns false after clear", () =>
      Effect.gen(function* () {
        const state: MockEngineState = makeDefaultMockEngineState();
        state.cloudSync.configured = true;
        yield* clearConfig().pipe(Effect.provide(createMockEngineLayer(state)));
        const configured = yield* isConfigured().pipe(Effect.provide(createMockEngineLayer(state)));
        expect(configured).toBe(false);
      }),
    );
  });

  describe("status", () => {
    it.effect("getConfig returns config when configured", () =>
      Effect.gen(function* () {
        const state: MockEngineState = makeDefaultMockEngineState();
        state.cloudSync.configured = true;
        state.cloudSync.config = { userId: "u", apiKey: Option.none(), endpoint: "https://e.com" };
        const config = yield* getConfig().pipe(Effect.provide(createMockEngineLayer(state)));
        expect(config.userId).toBe("u");
      }),
    );

    it.effect("getConfig fails with CloudNotConfiguredError when not configured", () =>
      Effect.gen(function* () {
        const result = yield* Effect.exit(getConfig());
        expect(result._tag).toBe("Failure");
      }).pipe(Effect.provide(createMockEngineLayer())),
    );
  });

  describe("enable / disable", () => {
    it.effect("enableRepo adds to enabled set", () =>
      Effect.gen(function* () {
        const state: MockEngineState = makeDefaultMockEngineState();
        yield* enableRepo("my-repo").pipe(Effect.provide(createMockEngineLayer(state)));
        expect(state.cloudSync.cloudEnabledRepos.has("my-repo")).toBe(true);
      }),
    );

    it.effect("disableRepo removes from enabled set", () =>
      Effect.gen(function* () {
        const state: MockEngineState = makeDefaultMockEngineState();
        state.cloudSync.cloudEnabledRepos.add("my-repo");
        yield* disableRepo("my-repo").pipe(Effect.provide(createMockEngineLayer(state)));
        expect(state.cloudSync.cloudEnabledRepos.has("my-repo")).toBe(false);
      }),
    );
  });

  describe("push", () => {
    it.effect("push succeeds when configured", () =>
      Effect.gen(function* () {
        const state: MockEngineState = makeDefaultMockEngineState();
        state.cloudSync.configured = true;
        const result = yield* push("my-repo").pipe(Effect.provide(createMockEngineLayer(state)));
        expect(result.repoId).toBe("my-repo");
        expect(result.filesUploaded).toBeGreaterThan(0);
      }),
    );

    it.effect("push fails with CloudNotConfiguredError when not configured", () =>
      Effect.gen(function* () {
        const result = yield* Effect.exit(push("my-repo"));
        expect(result._tag).toBe("Failure");
      }).pipe(Effect.provide(createMockEngineLayer())),
    );

    it.effect("pushAll succeeds when configured", () =>
      Effect.gen(function* () {
        const state: MockEngineState = makeDefaultMockEngineState();
        state.cloudSync.configured = true;
        const results = yield* pushAll().pipe(Effect.provide(createMockEngineLayer(state)));
        expect(Array.isArray(results)).toBe(true);
      }),
    );
  });

  describe("pull", () => {
    it.effect("pull succeeds when configured", () =>
      Effect.gen(function* () {
        const state: MockEngineState = makeDefaultMockEngineState();
        state.cloudSync.configured = true;
        const result = yield* pull().pipe(Effect.provide(createMockEngineLayer(state)));
        expect(result).toHaveProperty("filesDownloaded");
        expect(result).toHaveProperty("durationMs");
      }),
    );

    it.effect("pull fails with CloudNotConfiguredError when not configured", () =>
      Effect.gen(function* () {
        const result = yield* Effect.exit(pull());
        expect(result._tag).toBe("Failure");
      }).pipe(Effect.provide(createMockEngineLayer())),
    );
  });

  describe("getStatus", () => {
    it.effect("returns status when configured", () =>
      Effect.gen(function* () {
        const state: MockEngineState = makeDefaultMockEngineState();
        state.cloudSync.configured = true;
        const status = yield* getStatus("my-repo").pipe(
          Effect.provide(createMockEngineLayer(state)),
        );
        expect(status).toHaveProperty("inSync");
        expect(status).toHaveProperty("repoId");
      }),
    );
  });
});
