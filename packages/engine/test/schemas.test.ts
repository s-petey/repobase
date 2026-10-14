import { describe, it, expect } from "@effect/vitest"
import { DateTime, Effect, Option, Schema } from "effect"
import {
  TrackingMode,
  PinnedMode,
  RepoMode,
  RepoConfig,
  RepoStoreData
} from "../src/schemas.js"
import { deriveRepoId, extractRepoParts, repoNames, splitRepoPath, trackingMode, pinnedMode } from "../src/utils.js"

const STORED_DATE_MS = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-09-21T12:00:00Z"))

describe("schemas", () => {
  describe("deriveRepoId", () => {
    it("derives GitHub's owner/name from the URL", () => {
      expect(deriveRepoId("https://github.com/Effect-TS/effect")).toBe("Effect-TS/effect")
    })

    it("handles .git suffix", () => {
      expect(deriveRepoId("https://github.com/Effect-TS/effect.git")).toBe("Effect-TS/effect")
    })

    it("keeps repos apart whose names differ only in where the hyphens fall", () => {
      expect(deriveRepoId("https://github.com/a-b/c")).not.toBe(deriveRepoId("https://github.com/a/b-c"))
    })

    it("throws for invalid URLs", () => {
      expect(() => deriveRepoId("not-a-url")).toThrow("Invalid GitHub URL")
    })
  })

  describe("extractRepoParts", () => {
    it("extracts owner and name from GitHub URL", () => {
      expect(extractRepoParts("https://github.com/Effect-TS/effect")).toEqual({
        owner: "Effect-TS",
        name: "effect"
      })
    })

    it("handles .git suffix", () => {
      expect(extractRepoParts("https://github.com/Effect-TS/effect.git")).toEqual({
        owner: "Effect-TS",
        name: "effect"
      })
    })

    it("throws for invalid URLs", () => {
      expect(() => extractRepoParts("not-a-url")).toThrow("Invalid GitHub URL")
    })
  })

  describe("repoNames", () => {
    it("gives the owner and name from the URL", () => {
      const url = "https://github.com/Effect-TS/language-service.git"
      expect(repoNames({ id: deriveRepoId(url), url })).toEqual({ owner: "Effect-TS", name: "language-service" })
    })

    it("falls back to the id when the URL isn't a GitHub URL", () => {
      expect(repoNames({ id: "local-thing", url: "file:///srv/thing" })).toEqual({
        owner: "local-thing",
        name: "local-thing"
      })
    })
  })

  describe("splitRepoPath", () => {
    const ids = ["honojs/hono", "honojs/hono-extra", "old-style"]

    it("splits an owner/name id from the path inside it", () => {
      expect(splitRepoPath(ids, "honojs/hono/src/index.ts")).toEqual({ repo: "honojs/hono", path: "src/index.ts" })
    })

    it("takes a bare repo id as the repo's root", () => {
      expect(splitRepoPath(ids, "honojs/hono")).toEqual({ repo: "honojs/hono", path: "" })
    })

    it("doesn't mistake a repo for another one its id starts with", () => {
      expect(splitRepoPath(ids, "honojs/hono-extra/README.md")).toEqual({ repo: "honojs/hono-extra", path: "README.md" })
    })

    it("still reads ids without a slash", () => {
      expect(splitRepoPath(ids, "old-style/a/b.ts")).toEqual({ repo: "old-style", path: "a/b.ts" })
    })

    it("finds nothing for a repo that isn't indexed", () => {
      expect(splitRepoPath(ids, "honojs/other/README.md")).toBeUndefined()
    })
  })

  describe("trackingMode helper", () => {
    it("creates tracking mode with default branch", () => {
      const mode = trackingMode()
      expect(mode).toEqual({ _tag: "tracking", branch: "main" })
    })

    it("creates tracking mode with custom branch", () => {
      const mode = trackingMode("develop")
      expect(mode).toEqual({ _tag: "tracking", branch: "develop" })
    })
  })

  describe("pinnedMode helper", () => {
    it("creates pinned mode with ref", () => {
      const mode = pinnedMode("v1.0.0")
      expect(mode).toEqual({ _tag: "pinned", ref: "v1.0.0" })
    })
  })

  describe("TrackingMode schema", () => {
    it.effect("decodes valid tracking mode", () =>
      Effect.gen(function* () {
        const input = { _tag: "tracking", branch: "main" }
        const result = yield* Schema.decodeUnknownEffect(TrackingMode)(input)
        expect(result).toEqual({ _tag: "tracking", branch: "main" })
      })
    )

    it.effect("fails on invalid tracking mode", () =>
      Effect.gen(function* () {
        const input = { _tag: "tracking" } // missing branch
        const result = yield* Effect.exit(Schema.decodeUnknownEffect(TrackingMode)(input))
        expect(result._tag).toBe("Failure")
      })
    )
  })

  describe("PinnedMode schema", () => {
    it.effect("decodes valid pinned mode", () =>
      Effect.gen(function* () {
        const input = { _tag: "pinned", ref: "abc123" }
        const result = yield* Schema.decodeUnknownEffect(PinnedMode)(input)
        expect(result).toEqual({ _tag: "pinned", ref: "abc123" })
      })
    )
  })

  describe("RepoMode schema", () => {
    it.effect("decodes tracking mode", () =>
      Effect.gen(function* () {
        const input = { _tag: "tracking", branch: "main" }
        const result = yield* Schema.decodeUnknownEffect(RepoMode)(input)
        expect(result._tag).toBe("tracking")
      })
    )

    it.effect("decodes pinned mode", () =>
      Effect.gen(function* () {
        const input = { _tag: "pinned", ref: "v1.0.0" }
        const result = yield* Schema.decodeUnknownEffect(RepoMode)(input)
        expect(result._tag).toBe("pinned")
      })
    )
  })

  describe("RepoConfig schema", () => {
    it.effect("decodes and encodes full config", () =>
      Effect.gen(function* () {
        const input = {
          id: "Effect-TS-effect",
          url: "https://github.com/Effect-TS/effect",
          localPath: "/home/user/.repobase/repos/Effect-TS-effect",
          mode: { _tag: "tracking", branch: "main" },
          lastSyncedCommit: "abc123",
          lastSyncedAt: STORED_DATE_MS,
          addedAt: STORED_DATE_MS,
          lastPushedAt: null,
          lastPushedCommit: null
        }

        const decoded = yield* Schema.decodeUnknownEffect(RepoConfig)(input)
        expect(decoded.id).toBe("Effect-TS-effect")
        expect(Option.isSome(decoded.lastSyncedCommit)).toBe(true)
        expect(Option.getOrNull(decoded.lastSyncedCommit)).toBe("abc123")
        expect(DateTime.toEpochMillis(decoded.addedAt)).toBe(STORED_DATE_MS)

        const encoded = yield* Schema.encodeEffect(RepoConfig)(decoded)
        expect(encoded.id).toBe("Effect-TS-effect")
        expect(encoded.lastSyncedCommit).toBe("abc123")
        expect(encoded).toMatchObject({ addedAt: STORED_DATE_MS, lastSyncedAt: STORED_DATE_MS, lastPushedAt: null })
      })
    )

    it.effect("handles null optional fields", () =>
      Effect.gen(function* () {
        const input = {
          id: "test-repo",
          url: "https://github.com/test/repo",
          localPath: "/path/to/repo",
          mode: { _tag: "pinned", ref: "v1.0.0" },
          lastSyncedCommit: null,
          lastSyncedAt: null,
          addedAt: STORED_DATE_MS,
          lastPushedAt: null,
          lastPushedCommit: null
        }

        const decoded = yield* Schema.decodeUnknownEffect(RepoConfig)(input)
        expect(Option.isNone(decoded.lastSyncedCommit)).toBe(true)
        expect(Option.isNone(decoded.lastSyncedAt)).toBe(true)
      })
    )
  })

  describe("RepoStoreData schema", () => {
    it.effect("decodes empty store", () =>
      Effect.gen(function* () {
        const input = { version: 1, repos: [] }
        const result = yield* Schema.decodeUnknownEffect(RepoStoreData)(input)
        expect(result.version).toBe(1)
        expect(result.repos).toHaveLength(0)
      })
    )

    it.effect("decodes store with repos", () =>
      Effect.gen(function* () {
        const input = {
          version: 1,
          repos: [
            {
              id: "repo1",
              url: "https://github.com/test/repo1",
              localPath: "/path/repo1",
              mode: { _tag: "tracking", branch: "main" },
              lastSyncedCommit: null,
              lastSyncedAt: null,
              addedAt: STORED_DATE_MS,
              lastPushedAt: null,
              lastPushedCommit: null
            }
          ]
        }

        const result = yield* Schema.decodeUnknownEffect(RepoStoreData)(input)
        expect(result.repos).toHaveLength(1)
        expect(result.repos[0].id).toBe("repo1")
      })
    )
  })
})
