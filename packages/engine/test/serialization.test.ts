import { describe, it, expect } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import {
  CloudNotConfiguredError,
  GitError,
  IndexError,
  RepoAlreadyExistsError,
  RepoNotFoundError,
  SearchError,
  StoreError
} from "../src/errors.js"
import {
  AddRepoProgress,
  FileChange,
  IndexingProgress,
  IndexPlan,
  IndexSummary,
  SearchMode,
  SearchResult,
  SyncResult
} from "../src/schemas.js"

// Encode to what crosses a worker boundary / goes into a checkpoint, check it
// survives structured cloning, and decode it back
const roundTrip = <S extends Schema.Codec<any, any>>(schema: S, value: S["Type"]) =>
  Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(schema)(value)
    const cloned = structuredClone(encoded)
    const decoded = yield* Schema.decodeUnknownEffect(schema)(cloned)
    return { encoded, decoded }
  })

describe("serialization", () => {
  describe("worker message schemas", () => {
    it.effect("FileChange", () =>
      Effect.gen(function* () {
        const value = { status: "M" as const, path: "src/index.ts" }
        const { decoded } = yield* roundTrip(FileChange, value)
        expect(decoded).toEqual(value)
      })
    )

    it.effect("FileChange rejects unknown statuses", () =>
      Effect.gen(function* () {
        const result = yield* Effect.exit(
          Schema.decodeUnknownEffect(FileChange)({ status: "R100", path: "a.ts" })
        )
        expect(result._tag).toBe("Failure")
      })
    )

    it.effect("IndexPlan", () =>
      Effect.gen(function* () {
        const value = {
          toIndex: [
            { path: "a.ts", hash: "aaa" },
            { path: "b/c.ts", hash: "bbb" }
          ],
          toDelete: ["old.ts"],
          skipped: 4
        }
        const { decoded } = yield* roundTrip(IndexPlan, value)
        expect(decoded).toEqual(value)
      })
    )

    it.effect("IndexSummary", () =>
      Effect.gen(function* () {
        const value = { repo: "r", filesIndexed: 3, filesDeleted: 1, filesSkipped: 2, durationMs: 42 }
        const { decoded } = yield* roundTrip(IndexSummary, value)
        expect(decoded).toEqual(value)
      })
    )

    it.effect("IndexingProgress with and without currentFile", () =>
      Effect.gen(function* () {
        const withFile = { phase: "indexing" as const, filesProcessed: 1, totalFiles: 5, currentFile: "a.ts" }
        const withoutFile = { phase: "scanning" as const, filesProcessed: 0, totalFiles: 0 }
        expect((yield* roundTrip(IndexingProgress, withFile)).decoded).toEqual(withFile)
        expect((yield* roundTrip(IndexingProgress, withoutFile)).decoded).toEqual(withoutFile)
      })
    )

    it.effect("SearchMode and SearchResult", () =>
      Effect.gen(function* () {
        expect((yield* roundTrip(SearchMode, "hybrid")).decoded).toBe("hybrid")
        const value = { repo: "r", path: "a.ts", filename: "a.ts", score: 0.9, snippet: "export const a" }
        expect((yield* roundTrip(SearchResult, value)).decoded).toEqual(value)
      })
    )

    it.effect("AddRepoProgress", () =>
      Effect.gen(function* () {
        const value = {
          stage: "indexing" as const,
          progress: 60,
          message: "Indexing: a.ts",
          filesIndexed: 3,
          totalFiles: 10,
          currentFile: "a.ts"
        }
        expect((yield* roundTrip(AddRepoProgress, value)).decoded).toEqual(value)
      })
    )

    it.effect("SyncResult keeps Option fields", () =>
      Effect.gen(function* () {
        const updated = {
          id: "r",
          updated: true,
          previousCommit: Option.some("abc"),
          currentCommit: "def",
          indexSummary: { repo: "r", filesIndexed: 1, filesDeleted: 0, filesSkipped: 0, durationMs: 5 }
        }
        const first = yield* roundTrip(SyncResult, updated)
        expect(first.encoded.previousCommit).toBe("abc")
        expect(first.decoded).toEqual(updated)

        const neverSynced = { id: "r", updated: false, previousCommit: Option.none(), currentCommit: "def" }
        const second = yield* roundTrip(SyncResult, neverSynced)
        expect(second.encoded.previousCommit).toBeNull()
        expect(Option.isNone(second.decoded.previousCommit)).toBe(true)
      })
    )
  })

  describe("errors", () => {
    it.effect.each([
      ["GitError", new GitError({ command: "clone", message: "not found" })],
      ["StoreError", new StoreError({ operation: "save", message: "EACCES" })],
      ["IndexError", new IndexError({ operation: "embed", message: "model failed" })],
      ["SearchError", new SearchError({ message: "bad query" })],
      ["RepoNotFoundError", new RepoNotFoundError({ id: "r" })],
      ["RepoAlreadyExistsError", new RepoAlreadyExistsError({ id: "r" })],
      ["CloudNotConfiguredError", new CloudNotConfiguredError()]
    ] as const)("%s decodes back to its class", ([_, error]) =>
      Effect.gen(function* () {
        const schema = error.constructor as unknown as Schema.Codec<typeof error, unknown>
        const { encoded, decoded } = yield* roundTrip(schema, error)
        expect(encoded).toMatchObject({ _tag: error._tag })
        expect(decoded).toBeInstanceOf(error.constructor)
        expect(decoded).toEqual(error)
      })
    )

    it("keeps the error message for logging", () => {
      const error = new GitError({ command: "clone", message: "not found" })
      expect(error.message).toBe("not found")
      expect(error).toBeInstanceOf(Error)
    })
  })
})
