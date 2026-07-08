import { describe, expect, it } from "@effect/vitest";
import { Indexer } from "@repobase/engine";
import {
  createMockEngineLayer,
  makeDefaultMockEngineState,
  type MockEngineState,
} from "@repobase/engine/test-utils";
import { Effect } from "effect";

const { grepPattern } = Effect.serviceFunctions(Indexer);

describe("MCP grep tool", () => {
  it.effect("returns matching lines from state", () =>
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

  it.effect("handler response format includes match detail", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.indexer.grepResults = [
        {
          repo: "r",
          path: "src/main.ts",
          matchCount: 2,
          matches: [
            { lineNumber: 10, content: "  const x = 1", isMatch: true },
            { lineNumber: 11, content: "  // context", isMatch: false },
          ],
        },
      ];
      const results = yield* grepPattern("const").pipe(
        Effect.provide(createMockEngineLayer(state)),
      );

      const mapped = results.map((r) => ({
        repo: r.repo,
        path: r.path,
        matchCount: r.matchCount,
        matches: r.matches.map((m) => ({
          lineNumber: m.lineNumber,
          content: m.content,
          isMatch: m.isMatch,
        })),
      }));

      expect(mapped[0].repo).toBe("r");
      expect(mapped[0].matchCount).toBe(2);
      expect(mapped[0].matches).toHaveLength(2);
      expect(mapped[0].matches[0].lineNumber).toBe(10);
      expect(mapped[0].matches[0].isMatch).toBe(true);
      expect(mapped[0].matches[1].isMatch).toBe(false);
    }),
  );

  it.effect("supports repo filter", () =>
    Effect.gen(function* () {
      const state: MockEngineState = makeDefaultMockEngineState();
      state.indexer.grepResults = [
        {
          repo: "repo-a",
          path: "a.ts",
          matchCount: 1,
          matches: [{ lineNumber: 1, content: "x", isMatch: true }],
        },
        {
          repo: "repo-b",
          path: "b.ts",
          matchCount: 1,
          matches: [{ lineNumber: 1, content: "y", isMatch: true }],
        },
      ];
      const results = yield* grepPattern("pattern", { repo: "repo-a" }).pipe(
        Effect.provide(createMockEngineLayer(state)),
      );
      expect(results.every((r) => r.repo === "repo-a")).toBe(true);
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
            { lineNumber: 9, content: "  // before", isMatch: false },
            { lineNumber: 10, content: "  const x = 1", isMatch: true },
            { lineNumber: 11, content: "  // after", isMatch: false },
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
});
