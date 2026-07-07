import { describe, expect, it } from "@effect/vitest";
import { Indexer } from "@repobase/engine";
import {
  createMockEngineLayer,
  makeDefaultMockEngineState,
  type MockEngineState,
} from "@repobase/engine/test-utils";
import { Effect } from "effect";

const { grepPattern } = Effect.serviceFunctions(Indexer);

describe("grep command", () => {
  it.effect("returns matching lines", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.indexer.grepResults = [
        {
          repo: "my-repo",
          path: "src/main.ts",
          matchCount: 1,
          matches: [{ lineNumber: 10, content: "  const x = 1", isMatch: true }],
        },
      ];
      const results = yield* grepPattern("const").pipe(
        Effect.provide(createMockEngineLayer(state)),
      );
      expect(results).toHaveLength(1);
      expect(results[0].matchCount).toBeGreaterThan(0);
    }),
  );

  it.effect("supports case-insensitive flag", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.indexer.grepResults = [
        {
          repo: "my-repo",
          path: "src/main.ts",
          matchCount: 1,
          matches: [{ lineNumber: 5, content: "  CONST X", isMatch: true }],
        },
      ];
      const results = yield* grepPattern("const", { ignoreCase: true }).pipe(
        Effect.provide(createMockEngineLayer(state)),
      );
      expect(results.length).toBeGreaterThan(0);
    }),
  );

  it.effect("supports context lines", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.indexer.grepResults = [
        {
          repo: "my-repo",
          path: "src/main.ts",
          matchCount: 1,
          matches: [
            { lineNumber: 9, content: "  // context before", isMatch: false },
            { lineNumber: 10, content: "  const x = 1", isMatch: true },
            { lineNumber: 11, content: "  // context after", isMatch: false },
          ],
        },
      ];
      const results = yield* grepPattern("const", { contextBefore: 1, contextAfter: 1 }).pipe(
        Effect.provide(createMockEngineLayer(state)),
      );
      expect(results[0].matches).toHaveLength(3);
    }),
  );

  it.effect("supports files-with-matches mode", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.indexer.grepResults = [
        {
          repo: "r",
          path: "a.ts",
          matchCount: 2,
          matches: [{ lineNumber: 1, content: "x", isMatch: true }],
        },
        {
          repo: "r",
          path: "b.ts",
          matchCount: 1,
          matches: [{ lineNumber: 1, content: "y", isMatch: true }],
        },
      ];
      const results = yield* grepPattern("pattern", { filesWithMatches: true }).pipe(
        Effect.provide(createMockEngineLayer(state)),
      );
      expect(results.every((r) => r.matchCount > 0)).toBe(true);
    }),
  );

  it.effect("supports count mode", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.indexer.grepResults = [
        {
          repo: "r",
          path: "a.ts",
          matchCount: 5,
          matches: [],
        },
      ];
      const results = yield* grepPattern("pattern", { count: true }).pipe(
        Effect.provide(createMockEngineLayer(state)),
      );
      expect(results.some((r) => r.matchCount === 5)).toBe(true);
    }),
  );

  it.effect("filters by file type", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.indexer.grepResults = [
        {
          repo: "r",
          path: "main.ts",
          matchCount: 1,
          matches: [{ lineNumber: 1, content: "x", isMatch: true }],
        },
      ];
      const results = yield* grepPattern("x", { fileType: "ts" }).pipe(
        Effect.provide(createMockEngineLayer(state)),
      );
      expect(results.some((r) => r.path.endsWith(".ts"))).toBe(true);
    }),
  );
});
