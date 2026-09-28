import { describe, expect, it } from "vitest"
import { formatScore, shortenPath } from "./searchView.js"

describe("shortenPath", () => {
  it("keeps the full path when it fits", () => {
    expect(shortenPath("acme-widgets", "src/index.ts", 40)).toBe("acme-widgets/src/index.ts")
  })

  it("elides the directories when the full path doesn't fit", () => {
    expect(shortenPath("acme-widgets", "packages/core/src/deeply/nested/index.ts", 30)).toBe(
      "acme-widgets/…/index.ts"
    )
  })

  it("keeps the end of the file name when even that doesn't fit", () => {
    const short = shortenPath("acme-widgets", "src/a-very-long-component-name.tsx", 20)
    expect(short).toHaveLength(20)
    expect(short).toBe("…-component-name.tsx")
  })
})

describe("formatScore", () => {
  it.each([
    [1, "100%"],
    [0.855, " 86%"],
    [0.05, "  5%"]
  ])("formats %d as %j", (score, expected) => {
    expect(formatScore(score)).toBe(expected)
  })
})
