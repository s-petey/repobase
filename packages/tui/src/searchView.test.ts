import { describe, expect, it } from "vitest"
import { describeFilter, filterToGlob, formatLines, formatScore, shortenPath } from "./searchView.js"

describe("formatLines", () => {
  it("shows a range, a single line, or nothing", () => {
    expect(formatLines({ startLine: 210, endLine: 260 })).toBe("lines 210–260")
    expect(formatLines({ startLine: 7, endLine: 7 })).toBe("line 7")
    expect(formatLines({})).toBeUndefined()
  })
})

describe("filterToGlob", () => {
  it("uses a glob as is", () => {
    expect(filterToGlob({ kind: "glob", text: "crates/*/src/**/*.rs" })).toBe("crates/*/src/**/*.rs")
  })

  it("wraps a path fragment so any path containing it matches", () => {
    expect(filterToGlob({ kind: "path", text: "editor" })).toBe("**/*editor*{,/**}")
    expect(filterToGlob({ kind: "path", text: "/src/editor/" })).toBe("**/*src/editor*{,/**}")
  })
})

describe("describeFilter", () => {
  it("says which kind of filter it is", () => {
    expect(describeFilter({ kind: "path", text: "editor" })).toBe("in paths containing editor")
    expect(describeFilter({ kind: "glob", text: "*.md" })).toBe("matching *.md")
  })
})

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
