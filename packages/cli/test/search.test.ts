import { describe, expect, it } from "@effect/vitest";
import { Indexer } from "@repobase/engine";
import {
  createMockEngineLayer,
  makeDefaultMockEngineState,
  type MockEngineState,
} from "@repobase/engine/test-utils";
import { Effect, Option } from "effect";

const { searchKeyword, searchSemantic, searchHybrid } = Effect.serviceFunctions(Indexer);

describe("search command", () => {
  it.effect("keyword search returns results", () =>
    Effect.gen(function* () {
      const results = yield* searchKeyword("hello");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toHaveProperty("repo");
      expect(results[0]).toHaveProperty("path");
      expect(results[0]).toHaveProperty("score");
      expect(results[0].score).toBeGreaterThan(0);
    }).pipe(Effect.provide(createMockEngineLayer())),
  );

  it.effect("semantic search returns results", () =>
    Effect.gen(function* () {
      const results = yield* searchSemantic("find related code");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].score).toBeDefined();
    }).pipe(Effect.provide(createMockEngineLayer())),
  );

  it.effect("hybrid search returns results", () =>
    Effect.gen(function* () {
      const results = yield* searchHybrid("export function");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].score).toBeDefined();
    }).pipe(Effect.provide(createMockEngineLayer())),
  );

  it.effect("searches return snippet in results", () =>
    Effect.gen(function* () {
      const results = yield* searchKeyword("hello");
      expect(results[0].snippet).toBeDefined();
    }).pipe(Effect.provide(createMockEngineLayer())),
  );

  it.effect("uses custom search results from state", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.indexer.searchResults = [
        {
          repo: "custom-repo",
          path: "src/custom.ts",
          filename: "custom.ts",
          score: 0.99,
          snippet: Option.some("custom result"),
        },
      ];
      const results = yield* searchKeyword("custom").pipe(
        Effect.provide(createMockEngineLayer(state)),
      );
      expect(results).toHaveLength(1);
      expect(results[0].repo).toBe("custom-repo");
      expect(results[0].score).toBe(0.99);
    }),
  );

  it.effect("filters by repo when specified", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.indexer.searchResults = [
        { repo: "repo-a", path: "a.ts", filename: "a.ts", score: 0.9, snippet: Option.some("") },
        { repo: "repo-b", path: "b.ts", filename: "b.ts", score: 0.8, snippet: Option.some("") },
      ];
      const results = yield* searchHybrid("test", { repo: "repo-a" }).pipe(
        Effect.provide(createMockEngineLayer(state)),
      );
      expect(results.every((r) => r.repo === "repo-a")).toBe(true);
    }),
  );

  it.effect("respects limit option shape", () =>
    Effect.gen(function* () {
      const results = yield* searchKeyword("limited", { limit: 5 });
      expect(results.length).toBeLessThanOrEqual(5);
    }).pipe(Effect.provide(createMockEngineLayer())),
  );
});
