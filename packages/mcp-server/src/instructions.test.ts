import type { RepoConfig } from "@repobase/engine"
import { DateTime, Option } from "effect"
import { describe, expect, it } from "vitest"
import { reindexNotice, serverInstructions } from "./instructions.js"

const repo = (id: string, url: string): RepoConfig => ({
  id,
  url,
  localPath: `/tmp/repos/${id}`,
  mode: { _tag: "tracking", branch: "main" },
  lastSyncedCommit: Option.none(),
  lastSyncedAt: Option.none(),
  addedAt: DateTime.makeUnsafe(0),
  cloudEnabled: false,
  lastPushedAt: Option.none(),
  lastPushedCommit: Option.none(),
  indexFormat: 2
})

describe("serverInstructions", () => {
  it("lists each indexed repo by its id, and says to look here first", () => {
    const text = serverInstructions([
      repo("honojs/hono", "https://github.com/honojs/hono"),
      repo("Effect-TS/language-service", "https://github.com/Effect-TS/language-service.git")
    ])

    expect(text).toContain("- honojs/hono\n")
    expect(text).toContain("- Effect-TS/language-service\n")
    expect(text).toContain("look here first, before web searching")
  })

  it("says how to add repos when none are indexed", () => {
    expect(serverInstructions([])).toContain("no repositories indexed yet")
  })

  it("names repos in an old index format and how to re-index them", () => {
    const text = serverInstructions([
      { ...repo("honojs/hono", "https://github.com/honojs/hono"), indexFormat: 1 },
      repo("vuejs/core", "https://github.com/vuejs/core")
    ])

    expect(text).toContain("honojs/hono uses an old index format, so every repobase tool finds nothing in it until re-indexed")
    expect(text).toContain("run `repobase`) and press R to re-index")
    expect(text).not.toContain("vuejs/core uses")
  })

  it("says nothing about re-indexing when every repo is current", () => {
    expect(serverInstructions([repo("vuejs/core", "https://github.com/vuejs/core")])).not.toContain("re-index")
  })
})

describe("reindexNotice", () => {
  it("lists several repos by name", () => {
    expect(reindexNotice(["a/one", "b/two"])).toContain(
      "These repositories use an old index format, so every repobase tool finds nothing in them until re-indexed: a/one, b/two."
    )
  })
})
