import { describe, it, expect } from "@effect/vitest"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, SubscriptionRef } from "effect"
import * as crypto from "node:crypto"
import * as nodeFs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Indexer, IndexError, initialIndexingProgress } from "../src/index.js"
import { layerWith as IndexerLayerWith, makeWith } from "../src/services/Indexer.js"

// These tests run the real Indexer against a real LanceDB table and real
// files, each in its own temp directory. Only the embedding model is faked.

const EMBEDDING_DIMENSION = 384

// Deterministic unit vector derived from the text
const fakeEmbed = async (text: string) => {
  const seed = crypto.createHash("sha256").update(text).digest()
  const vector = Array.from({ length: EMBEDDING_DIMENSION }, (_, i) => seed[i % seed.length] / 255 + 0.01)
  const norm = Math.hypot(...vector)
  return vector.map((v) => v / norm)
}

const tempDir = (prefix: string) => nodeFs.mkdtempSync(path.join(os.tmpdir(), `repobase-${prefix}-`))

const writeFile = (repoPath: string, relPath: string, contents: string | Uint8Array) => {
  const full = path.join(repoPath, relPath)
  nodeFs.mkdirSync(path.dirname(full), { recursive: true })
  nodeFs.writeFileSync(full, contents)
}

const BINARY = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x0d])

// A repo with three text files, one binary file and one ignored file
const makeRepo = () => {
  const repoPath = tempDir("repo")
  writeFile(repoPath, "src/index.ts", "export const hello = 'world'")
  writeFile(repoPath, "src/utils.ts", "export function add(a: number, b: number) { return a + b }")
  writeFile(repoPath, "README.md", "# Test Repo\n\nThis is a test repository.")
  writeFile(repoPath, "assets/data.dat", BINARY) // not an ignored extension, caught by the binary check
  writeFile(repoPath, "node_modules/dep/index.js", "module.exports = 1")
  return repoPath
}

const indexerLayer = (embed: (text: string) => Promise<ReadonlyArray<number>> = fakeEmbed) =>
  IndexerLayerWith({ indexDir: tempDir("index"), embed }).pipe(Layer.provide(BunServices.layer))

// Every indexed row for a repo, as path -> count (to catch duplicates)
const indexedPaths = (repo: string) =>
  Effect.gen(function* () {
    const indexer = yield* Indexer
    const files = yield* indexer.globFiles("**", { repo, limit: 10_000 })
    const counts = new Map<string, number>()
    for (const file of files) counts.set(file.path, (counts.get(file.path) ?? 0) + 1)
    return counts
  })

const REPO = "test-repo"

describe("Indexer across connections", () => {
  // Each worker thread has its own connection to the same index, and keeps it
  it.effect("sees rows another connection wrote after it opened the table, and finalizes after them", () =>
    Effect.gen(function* () {
      const indexDir = tempDir("index")
      const indexing = yield* makeWith({ indexDir, embed: fakeEmbed })
      const jobs = yield* makeWith({ indexDir, embed: fakeEmbed })
      yield* jobs.indexRepo("earlier-repo", makeRepo())

      yield* indexing.indexRepo(REPO, makeRepo())

      expect(yield* jobs.globFiles("**", { repo: REPO, limit: 100 })).toHaveLength(3)
      yield* jobs.finalizeIndex()
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer))
  )
})

describe("Indexer", () => {
  describe("indexRepo", () => {
    it.effect("indexes text files and skips binary and ignored files", () =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const repoPath = makeRepo()

        const summary = yield* indexer.indexRepo(REPO, repoPath)

        expect(summary).toMatchObject({ repo: REPO, filesIndexed: 3, filesDeleted: 0, filesSkipped: 1 })
        const paths = yield* indexedPaths(REPO)
        expect([...paths.keys()].sort()).toEqual(["README.md", "src/index.ts", "src/utils.ts"])
      }).pipe(Effect.provide(indexerLayer()))
    )

    it.effect("skips unchanged files on a second run", () =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const repoPath = makeRepo()
        yield* indexer.indexRepo(REPO, repoPath)

        const summary = yield* indexer.indexRepo(REPO, repoPath)

        expect(summary).toMatchObject({ filesIndexed: 0, filesDeleted: 0, filesSkipped: 4 })
      }).pipe(Effect.provide(indexerLayer()))
    )

    it.effect("re-indexes changed files and drops deleted ones", () =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const repoPath = makeRepo()
        yield* indexer.indexRepo(REPO, repoPath)

        writeFile(repoPath, "src/index.ts", "export const hello = 'changed'")
        nodeFs.rmSync(path.join(repoPath, "README.md"))

        const summary = yield* indexer.indexRepo(REPO, repoPath)

        expect(summary).toMatchObject({ filesIndexed: 1, filesDeleted: 1 })
        const paths = yield* indexedPaths(REPO)
        expect([...paths.keys()].sort()).toEqual(["src/index.ts", "src/utils.ts"])
        expect([...paths.values()].every((n) => n === 1)).toBe(true)
      }).pipe(Effect.provide(indexerLayer()))
    )

    it.effect("reports progress through the phases", () =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const progressRef = yield* SubscriptionRef.make(initialIndexingProgress)

        yield* indexer.indexRepo(REPO, makeRepo(), { progressRef })

        const final = yield* SubscriptionRef.get(progressRef)
        expect(final).toMatchObject({ phase: "finalizing", filesProcessed: 3, totalFiles: 3 })
        expect(final.currentFile).toBeUndefined()
      }).pipe(Effect.provide(indexerLayer()))
    )

    it.effect("builds the full-text index", () =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        yield* indexer.indexRepo(REPO, makeRepo())

        const results = yield* indexer.searchKeyword("repository", { repo: REPO })

        expect(results.map((r) => r.path)).toContain("README.md")
      }).pipe(Effect.provide(indexerLayer()))
    )
  })

  describe("planFullIndex", () => {
    it.effect("plans new files without reading contents into the plan", () =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const plan = yield* indexer.planFullIndex(REPO, makeRepo())

        expect(plan.toIndex.map((f) => f.path).sort()).toEqual(["README.md", "src/index.ts", "src/utils.ts"])
        expect(plan.toIndex.every((f) => /^[0-9a-f]{64}$/.test(f.hash))).toBe(true)
        expect(plan.toDelete).toEqual([])
        expect(plan.skipped).toBe(1) // the binary file; ignored paths aren't globbed at all
      }).pipe(Effect.provide(indexerLayer()))
    )

    it.effect("plans everything again when forced", () =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const repoPath = makeRepo()
        yield* indexer.indexRepo(REPO, repoPath)

        const plan = yield* indexer.planFullIndex(REPO, repoPath, { force: true })

        expect(plan.toIndex).toHaveLength(3)
      }).pipe(Effect.provide(indexerLayer()))
    )
  })

  describe("planChanges", () => {
    it.effect("sorts a git diff into files to index, delete and skip", () =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const repoPath = makeRepo()
        writeFile(repoPath, "src/new.ts", "export const fresh = true")

        const plan = yield* indexer.planChanges(REPO, repoPath, [
          { status: "A", path: "src/new.ts" },
          { status: "M", path: "src/index.ts" },
          { status: "D", path: "src/removed.ts" },
          { status: "M", path: "assets/data.dat" }, // now binary: drop any stale row
          { status: "A", path: "src/vanished.ts" }, // not on disk
          { status: "M", path: "node_modules/dep/index.js" }, // ignored directory
          { status: "A", path: "dist/bundle.js" }, // ignored directory
          { status: "M", path: "bun.lock" } // ignored extension
        ])

        expect(plan.toIndex.map((f) => f.path)).toEqual(["src/new.ts", "src/index.ts"])
        expect(plan.toDelete).toEqual(["src/removed.ts", "assets/data.dat", "src/vanished.ts"])
        expect(plan.skipped).toBe(3)
      }).pipe(Effect.provide(indexerLayer()))
    )

    it.effect("skips changed files the index already has with the same content", () =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const repoPath = makeRepo()
        // As if an earlier sync indexed this content, then stopped before recording the commit
        yield* indexer.indexRepo(REPO, repoPath)
        writeFile(repoPath, "src/utils.ts", "export const changed = true")

        const plan = yield* indexer.planChanges(REPO, repoPath, [
          { status: "M", path: "src/index.ts" }, // in the diff, but indexed as-is already
          { status: "M", path: "src/utils.ts" } // really changed since
        ])

        expect(plan.toIndex.map((f) => f.path)).toEqual(["src/utils.ts"])
        expect(plan.skipped).toBe(1)
      }).pipe(Effect.provide(indexerLayer()))
    )
  })

  describe("indexChanges", () => {
    it.effect("applies a diff and rebuilds the full-text index", () =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const repoPath = makeRepo()
        yield* indexer.indexRepo(REPO, repoPath)

        writeFile(repoPath, "src/new.ts", "export const zanzibar = 'fresh keyword'")
        nodeFs.rmSync(path.join(repoPath, "src/utils.ts"))
        const summary = yield* indexer.indexChanges(REPO, repoPath, [
          { status: "A", path: "src/new.ts" },
          { status: "D", path: "src/utils.ts" }
        ])

        expect(summary).toMatchObject({ filesIndexed: 1, filesDeleted: 1 })
        const paths = yield* indexedPaths(REPO)
        expect([...paths.keys()].sort()).toEqual(["README.md", "src/index.ts", "src/new.ts"])
        const results = yield* indexer.searchKeyword("zanzibar", { repo: REPO })
        expect(results.map((r) => r.path)).toEqual(["src/new.ts"])
      }).pipe(Effect.provide(indexerLayer()))
    )
  })

  describe("indexBatch", () => {
    it.effect("is idempotent: running a batch twice leaves one row per file", () =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const repoPath = makeRepo()
        const plan = yield* indexer.planFullIndex(REPO, repoPath)

        yield* indexer.indexBatch(REPO, repoPath, plan.toIndex)
        writeFile(repoPath, "src/index.ts", "export const hello = 'second run'")
        const second = yield* indexer.indexBatch(REPO, repoPath, plan.toIndex)

        expect(second).toEqual({ indexed: 3, skipped: 0 })
        const paths = yield* indexedPaths(REPO)
        expect(paths.size).toBe(3)
        expect([...paths.values()].every((n) => n === 1)).toBe(true)
      }).pipe(Effect.provide(indexerLayer()))
    )

    it.effect("drops a planned file that disappeared before its batch ran", () =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const repoPath = makeRepo()
        yield* indexer.indexRepo(REPO, repoPath)
        const plan = yield* indexer.planFullIndex(REPO, repoPath, { force: true })

        nodeFs.rmSync(path.join(repoPath, "README.md"))
        const result = yield* indexer.indexBatch(REPO, repoPath, plan.toIndex)

        expect(result).toEqual({ indexed: 2, skipped: 1 })
        const paths = yield* indexedPaths(REPO)
        expect(paths.has("README.md")).toBe(false)
      }).pipe(Effect.provide(indexerLayer()))
    )

    it.effect("calls onFile for each file", () =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const repoPath = makeRepo()
        const plan = yield* indexer.planFullIndex(REPO, repoPath)
        const seen: Array<string> = []

        yield* indexer.indexBatch(REPO, repoPath, plan.toIndex, {
          onFile: (p) => Effect.sync(() => seen.push(p))
        })

        expect(seen.sort()).toEqual(["README.md", "src/index.ts", "src/utils.ts"])
      }).pipe(Effect.provide(indexerLayer()))
    )

    it.effect("fails with the file being embedded", () =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const repoPath = makeRepo()
        writeFile(repoPath, "src/boom.ts", "EXPLODE")
        const plan = yield* indexer.planFullIndex(REPO, repoPath)

        const error = yield* Effect.flip(indexer.indexBatch(REPO, repoPath, plan.toIndex))

        expect(error).toBeInstanceOf(IndexError)
        expect(error.operation).toBe("indexBatch.embed")
        expect(error.path).toBe("src/boom.ts")
      }).pipe(
        Effect.provide(
          indexerLayer(async (text) => {
            if (text.includes("EXPLODE")) throw new Error("model crashed")
            return fakeEmbed(text)
          })
        )
      )
    )
  })

  describe("deletePaths", () => {
    it.effect("handles paths containing quotes", () =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const repoPath = makeRepo()
        writeFile(repoPath, "docs/it's here.md", "a file with a quote in its name")
        yield* indexer.indexRepo(REPO, repoPath)
        expect((yield* indexedPaths(REPO)).has("docs/it's here.md")).toBe(true)

        yield* indexer.deletePaths(REPO, ["docs/it's here.md", "src/index.ts"])

        const paths = yield* indexedPaths(REPO)
        expect([...paths.keys()].sort()).toEqual(["README.md", "src/utils.ts"])
      }).pipe(Effect.provide(indexerLayer()))
    )
  })

  describe("chunks", () => {
    // 300 lines of 3 words; with the word-count tokenizer, about 84 lines a chunk
    const longFile = (tail: string) =>
      Array.from({ length: 300 }, (_, i) => (i === 249 ? `line ${i + 1} ${tail}` : `line ${i + 1} filler`)).join("\n")

    it.effect("indexes a long file as several chunks, but lists it once", () =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const repoPath = makeRepo()
        writeFile(repoPath, "src/long.ts", longFile("zebracorn"))
        yield* indexer.indexRepo(REPO, repoPath)

        const paths = yield* indexedPaths(REPO)
        expect(paths.get("src/long.ts")).toBe(1)

        // The term is near the end, so only a later chunk can match it
        const [hit] = yield* indexer.searchKeyword("zebracorn", { repo: REPO })
        expect(hit).toMatchObject({ path: "src/long.ts" })
        expect(hit.startLine).toBeGreaterThan(1)
        expect(hit.startLine).toBeLessThanOrEqual(250)
        expect(hit.endLine).toBeGreaterThanOrEqual(250)
        expect(hit.snippet).toContain("zebracorn")
      }).pipe(Effect.provide(indexerLayer()))
    )

    it.effect("returns each file once, however many of its chunks match", () =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const repoPath = makeRepo()
        writeFile(repoPath, "src/long.ts", longFile("zebracorn"))
        yield* indexer.indexRepo(REPO, repoPath)

        for (const mode of ["searchKeyword", "searchSemantic", "searchHybrid"] as const) {
          const results = yield* indexer[mode]("filler", { repo: REPO })
          const paths = results.map((r) => r.path)
          expect(new Set(paths).size).toBe(paths.length)
        }
      }).pipe(Effect.provide(indexerLayer()))
    )

    it.effect("drops the chunks a file no longer has when it shrinks", () =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const repoPath = makeRepo()
        writeFile(repoPath, "src/long.ts", longFile("zebracorn"))
        yield* indexer.indexRepo(REPO, repoPath)

        writeFile(repoPath, "src/long.ts", "export const short = true")
        yield* indexer.indexRepo(REPO, repoPath)

        expect(yield* indexer.searchKeyword("zebracorn", { repo: REPO })).toEqual([])
        expect((yield* indexer.searchKeyword("short", { repo: REPO })).map((r) => r.path)).toEqual(["src/long.ts"])
      }).pipe(Effect.provide(indexerLayer()))
    )

    it.effect("deletes every chunk of a removed file", () =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        const repoPath = makeRepo()
        writeFile(repoPath, "src/long.ts", longFile("zebracorn"))
        yield* indexer.indexRepo(REPO, repoPath)

        yield* indexer.deletePaths(REPO, ["src/long.ts"])
        yield* indexer.finalizeIndex()

        expect(yield* indexer.searchKeyword("zebracorn", { repo: REPO })).toEqual([])
        expect((yield* indexedPaths(REPO)).has("src/long.ts")).toBe(false)
      }).pipe(Effect.provide(indexerLayer()))
    )
  })

  describe("search with a path", () => {
    const modes = ["searchKeyword", "searchSemantic", "searchHybrid"] as const

    for (const mode of modes) {
      it.effect(`${mode} returns only results under the path`, () =>
        Effect.gen(function* () {
          const indexer = yield* Indexer
          const repoPath = makeRepo()
          writeFile(repoPath, "src-extra/other.ts", "export const other = 'world'")
          yield* indexer.indexRepo(REPO, repoPath)

          const inDir = yield* indexer[mode]("export", { repo: REPO, path: "src" })
          const inFile = yield* indexer[mode]("export", { repo: REPO, path: "src/utils.ts" })

          expect(inDir.map((r) => r.path).sort()).toEqual(["src/index.ts", "src/utils.ts"])
          expect(inFile.map((r) => r.path)).toEqual(["src/utils.ts"])
        }).pipe(Effect.provide(indexerLayer()))
      )

      it.effect(`${mode} returns only results matching a glob`, () =>
        Effect.gen(function* () {
          const indexer = yield* Indexer
          const repoPath = makeRepo()
          writeFile(repoPath, "src-extra/other.ts", "export const other = 'world'")
          writeFile(repoPath, "docs/it's export.md", "export notes")
          yield* indexer.indexRepo(REPO, repoPath)

          const paths = (glob: string) =>
            indexer[mode]("export", { repo: REPO, glob }).pipe(Effect.map((rs) => rs.map((r) => r.path).sort()))

          expect(yield* paths("src*/**/*.ts")).toEqual(["src-extra/other.ts", "src/index.ts", "src/utils.ts"])
          expect(yield* paths("**/u*.ts")).toEqual(["src/utils.ts"])
          // Semantic results don't need to contain the query, so README.md can come back too
          const markdown = yield* paths("*.md")
          expect(markdown).toContain("docs/it's export.md")
          expect(markdown.every((p) => p.endsWith(".md"))).toBe(true)
        }).pipe(Effect.provide(indexerLayer()))
      )

      it.effect(`${mode} returns only results from the given repos`, () =>
        Effect.gen(function* () {
          const indexer = yield* Indexer
          for (const repo of ["acme/one", "acme/two", "other's/three"]) {
            yield* indexer.indexRepo(repo, makeRepo())
          }

          const repos = (list: ReadonlyArray<string>) =>
            indexer[mode]("export", { repos: list }).pipe(Effect.map((rs) => [...new Set(rs.map((r) => r.repo))].sort()))

          expect(yield* repos(["acme/one", "acme/two"])).toEqual(["acme/one", "acme/two"])
          expect(yield* repos(["other's/three"])).toEqual(["other's/three"])
          // Empty means no filter
          expect(yield* repos([])).toEqual(["acme/one", "acme/two", "other's/three"])
        }).pipe(Effect.provide(indexerLayer()))
      )
    }
  })

  describe("grepPattern", () => {
    // grep reads files from <reposDir>/<repo>, so the repos live there
    const grepSetup = Effect.gen(function* () {
      const reposDir = tempDir("repos")
      const indexer = yield* makeWith({ indexDir: tempDir("index"), reposDir, embed: fakeEmbed })
      for (const repo of [REPO, "other-repo"]) {
        const repoPath = path.join(reposDir, repo)
        writeFile(repoPath, "src/editor/menu.ts", "export const needle = 1")
        writeFile(repoPath, "src/editor/menu.test.ts", "needle()")
        writeFile(repoPath, "src/editor-extra/menu.ts", "export const needle = 2")
        writeFile(repoPath, "src/main.ts", "needle.go()")
        writeFile(repoPath, "README.md", "a needle in a haystack")
        yield* indexer.indexRepo(repo, repoPath)
      }
      return indexer
    })

    const grepPaths = (options: Parameters<Indexer["Service"]["grepPattern"]>[1]) =>
      Effect.gen(function* () {
        const indexer = yield* grepSetup
        const results = yield* indexer.grepPattern("needle", options)
        return results.map((r) => `${r.repo}/${r.path}`).sort()
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer))

    it.effect("limits results to one file", () =>
      Effect.gen(function* () {
        expect(yield* grepPaths({ repo: REPO, path: "src/editor/menu.ts" })).toEqual([`${REPO}/src/editor/menu.ts`])
      })
    )

    it.effect("limits results to a directory, not siblings sharing its prefix", () =>
      Effect.gen(function* () {
        expect(yield* grepPaths({ repo: REPO, path: "src/editor/" })).toEqual([
          `${REPO}/src/editor/menu.test.ts`,
          `${REPO}/src/editor/menu.ts`
        ])
      })
    )

    it.effect("limits results to files matching a glob", () =>
      Effect.gen(function* () {
        expect(yield* grepPaths({ repo: REPO, glob: "src/editor/**" })).toEqual([
          `${REPO}/src/editor/menu.test.ts`,
          `${REPO}/src/editor/menu.ts`
        ])
        expect(yield* grepPaths({ repo: REPO, glob: "*.md" })).toEqual([`${REPO}/README.md`])
      })
    )

    it.effect("skips files matching the exclude glob", () =>
      Effect.gen(function* () {
        expect(yield* grepPaths({ repo: REPO, path: "src", exclude: "**/*.test.ts" })).toEqual([
          `${REPO}/src/editor-extra/menu.ts`,
          `${REPO}/src/editor/menu.ts`,
          `${REPO}/src/main.ts`
        ])
      })
    )

    it.effect("combines the repo, file type and path filters", () =>
      Effect.gen(function* () {
        expect(yield* grepPaths({ repo: REPO, fileType: "ts", path: "src/editor" })).toEqual([
          `${REPO}/src/editor/menu.test.ts`,
          `${REPO}/src/editor/menu.ts`
        ])
        expect(yield* grepPaths({ path: "src/main.ts" })).toEqual([`other-repo/src/main.ts`, `${REPO}/src/main.ts`])
      })
    )
  })

  describe("removeIndex", () => {
    it.effect("removes only the given repo", () =>
      Effect.gen(function* () {
        const indexer = yield* Indexer
        yield* indexer.indexRepo(REPO, makeRepo())
        yield* indexer.indexRepo("other-repo", makeRepo())

        yield* indexer.removeIndex(REPO)

        expect((yield* indexedPaths(REPO)).size).toBe(0)
        expect((yield* indexedPaths("other-repo")).size).toBe(3)
      }).pipe(Effect.provide(indexerLayer()))
    )
  })
})
