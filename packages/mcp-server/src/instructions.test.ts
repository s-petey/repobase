import type { RepoConfig } from "@repobase/engine"
import { DateTime, Option } from "effect"
import { describe, expect, it } from "vitest"
import { serverInstructions } from "./instructions.js"

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
})
