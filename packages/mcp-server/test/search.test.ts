import { describe, expect, it } from "@effect/vitest";
import { RepobaseEngine } from "@repobase/engine";
import {
  createMockEngineLayer,
  makeDefaultMockEngineState,
  type MockEngineState,
} from "@repobase/engine/test-utils";
import { Effect, Option } from "effect";

const { search } = Effect.serviceFunctions(RepobaseEngine);

describe("MCP search tool", () => {
  it.effect("keyword search returns results", () =>
    Effect.gen(function* () {
      const results = yield* search("hello", "keyword");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toHaveProperty("repo");
      expect(results[0]).toHaveProperty("path");
      expect(results[0]).toHaveProperty("score");
      expect(results[0].snippet).toBeDefined();
    }).pipe(Effect.provide(createMockEngineLayer())),
  );

  it.effect("semantic search returns results", () =>
    Effect.gen(function* () {
      const results = yield* search("find related code", "semantic");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].score).toBeDefined();
    }).pipe(Effect.provide(createMockEngineLayer())),
  );

  it.effect("hybrid search returns results", () =>
    Effect.gen(function* () {
      const results = yield* search("export function", "hybrid");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].score).toBeDefined();
    }).pipe(Effect.provide(createMockEngineLayer())),
  );

  it.effect("handler response format is correct", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.engine.searchResults = [
        {
          repo: "my-repo",
          path: "src/test.ts",
          filename: "test.ts",
          score: 0.95,
          snippet: Option.some("...hello..."),
        },
      ];
      const results = yield* search("hello", "keyword", { limit: 20 }).pipe(
        Effect.provide(createMockEngineLayer(state)),
      );

      const mapped = results.map((r) => ({
        repo: r.repo,
        path: r.path,
        filename: r.filename,
        score: r.score,
        snippet: r.snippet,
      }));

      expect(mapped).toHaveLength(1);
      expect(mapped[0].repo).toBe("my-repo");
      expect(mapped[0].score).toBe(0.95);
    }),
  );

  it.effect("respects repo filter option", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.engine.searchResults = [
        { repo: "repo-a", path: "a.ts", filename: "a.ts", score: 0.9, snippet: Option.some("") },
        { repo: "repo-b", path: "b.ts", filename: "b.ts", score: 0.8, snippet: Option.some("") },
      ];
      const results = yield* search("test", "keyword", { repo: "repo-a" }).pipe(
        Effect.provide(createMockEngineLayer(state)),
      );
      expect(results.every((r) => r.repo === "repo-a")).toBe(true);
    }),
  );
});
