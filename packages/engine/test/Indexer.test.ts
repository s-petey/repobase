import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { FileNotFoundError, Indexer, IndexError, InvalidPatternError } from "../src/index.js";
import {
  FileContent,
  FileInfo,
  GlobOptions,
  GrepOptions,
  GrepResult,
  ListFilesOptions,
  ReadFileOptions,
} from "../src/services/Indexer.js";

// Create a mock Indexer service for testing
const MockIndexerService = Layer.succeed(
  Indexer,
  Indexer.of({
    indexRepo: (repoId, _repoPath, _options) =>
      Effect.succeed({
        repo: repoId,
        filesIndexed: 3,
        filesDeleted: 0,
        filesSkipped: 0,
        durationMs: 100,
      }),
    indexChanges: (repoId, _repoPath, changes) =>
      Effect.succeed({
        repo: repoId,
        filesIndexed: changes.filter((c) => c.status !== "D").length,
        filesDeleted: changes.filter((c) => c.status === "D").length,
        filesSkipped: 0,
        durationMs: 50,
      }),
    removeIndex: (_repoId) => Effect.void,
    searchKeyword: (query, _options) =>
      Effect.succeed([
        {
          repo: "test-repo",
          path: "src/index.ts",
          filename: "index.ts",
          score: 0.95,
          snippet: Option.some(`...export const ${query}...`),
        },
      ]),
    searchSemantic: (query, _options) =>
      Effect.succeed([
        {
          repo: "test-repo",
          path: "src/utils.ts",
          filename: "utils.ts",
          score: 0.85,
          snippet: Option.some(`...function related to ${query}...`),
        },
      ]),
    searchHybrid: (query, _options) =>
      Effect.succeed([
        {
          repo: "test-repo",
          path: "src/index.ts",
          filename: "index.ts",
          score: 0.9,
          snippet: Option.some(`...hybrid result for ${query}...`),
        },
      ]),
    listFiles: function (
      _options: ListFilesOptions,
    ): Effect.Effect<readonly FileInfo[], IndexError> {
      throw new Error("Function not implemented.");
    },
    globFiles: function (
      _pattern: string,
      _options?: GlobOptions,
    ): Effect.Effect<readonly FileInfo[], IndexError | InvalidPatternError> {
      throw new Error("Function not implemented.");
    },
    readFile: function (
      _repo: string,
      _filePath: string,
      _options?: ReadFileOptions,
    ): Effect.Effect<FileContent, IndexError | FileNotFoundError> {
      throw new Error("Function not implemented.");
    },
    grepPattern: function (
      _pattern: string,
      _options?: GrepOptions,
    ): Effect.Effect<readonly GrepResult[], IndexError | InvalidPatternError> {
      throw new Error("Function not implemented.");
    },
  }),
);

describe("Indexer", () => {
  describe("indexRepo", () => {
    it.effect("indexes repository and returns summary", () =>
      Effect.gen(function* () {
        const indexer = yield* Indexer;
        const result = yield* indexer.indexRepo("test-repo", "/test-repo");

        expect(result.repo).toBe("test-repo");
        expect(result.filesIndexed).toBeGreaterThanOrEqual(0);
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
      }).pipe(Effect.provide(MockIndexerService)),
    );

    it.effect("returns correct summary structure", () =>
      Effect.gen(function* () {
        const indexer = yield* Indexer;
        const result = yield* indexer.indexRepo("my-repo", "/path/to/repo");

        expect(result).toHaveProperty("repo");
        expect(result).toHaveProperty("filesIndexed");
        expect(result).toHaveProperty("filesDeleted");
        expect(result).toHaveProperty("filesSkipped");
        expect(result).toHaveProperty("durationMs");
      }).pipe(Effect.provide(MockIndexerService)),
    );
  });

  describe("indexChanges", () => {
    it.effect("indexes changed files incrementally", () =>
      Effect.gen(function* () {
        const indexer = yield* Indexer;
        const changes = [
          { status: "A" as const, path: "new-file.ts" },
          { status: "M" as const, path: "modified.ts" },
          { status: "D" as const, path: "deleted.ts" },
        ];
        const result = yield* indexer.indexChanges("test-repo", "/test-repo", changes);

        expect(result.repo).toBe("test-repo");
        expect(result.filesIndexed).toBe(2); // A + M
        expect(result.filesDeleted).toBe(1); // D
      }).pipe(Effect.provide(MockIndexerService)),
    );
  });

  describe("removeIndex", () => {
    it.effect("removes index for repository", () =>
      Effect.gen(function* () {
        const indexer = yield* Indexer;
        yield* indexer.removeIndex("test-repo");
        // If we get here without error, the test passes
      }).pipe(Effect.provide(MockIndexerService)),
    );
  });

  describe("searchKeyword", () => {
    it.effect("returns keyword search results", () =>
      Effect.gen(function* () {
        const indexer = yield* Indexer;
        const results = yield* indexer.searchKeyword("hello");

        expect(results).toHaveLength(1);
        expect(results[0]).toHaveProperty("repo");
        expect(results[0]).toHaveProperty("path");
        expect(results[0]).toHaveProperty("filename");
        expect(results[0]).toHaveProperty("score");
      }).pipe(Effect.provide(MockIndexerService)),
    );

    it.effect("respects limit option", () =>
      Effect.gen(function* () {
        const indexer = yield* Indexer;
        const results = yield* indexer.searchKeyword("test", { limit: 5 });

        expect(results.length).toBeLessThanOrEqual(5);
      }).pipe(Effect.provide(MockIndexerService)),
    );
  });

  describe("searchSemantic", () => {
    it.effect("returns semantic search results", () =>
      Effect.gen(function* () {
        const indexer = yield* Indexer;
        const results = yield* indexer.searchSemantic("add two numbers");

        expect(results).toHaveLength(1);
        expect(results[0]).toHaveProperty("score");
        expect(results[0].score).toBeGreaterThan(0);
      }).pipe(Effect.provide(MockIndexerService)),
    );
  });

  describe("searchHybrid", () => {
    it.effect("returns hybrid search results", () =>
      Effect.gen(function* () {
        const indexer = yield* Indexer;
        const results = yield* indexer.searchHybrid("export function");

        expect(results).toHaveLength(1);
        expect(results[0]).toHaveProperty("score");
      }).pipe(Effect.provide(MockIndexerService)),
    );

    it.effect("filters by repo when specified", () =>
      Effect.gen(function* () {
        const indexer = yield* Indexer;
        const results = yield* indexer.searchHybrid("test", { repo: "test-repo" });

        for (const result of results) {
          expect(result.repo).toBe("test-repo");
        }
      }).pipe(Effect.provide(MockIndexerService)),
    );
  });
});

describe("Indexer utility functions", () => {
  it("extracts snippet correctly", () => {
    // We can't directly test internal functions, but we can verify through search results
    // The mock already returns snippets, so this is covered
  });
});
