import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/react/test-utils"
import type { RepoConfig } from "@repobase/engine"
import { DateTime, Option } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { interact, teardown } from "../test/helpers.js"
import { type FlatRow, RepoList } from "./RepoList.js"

let setup: TestRendererSetup | undefined

afterEach(async () => {
  await teardown(setup)
  setup = undefined
})

const repo = (id: string, committedAt = "2026-10-21T12:00:00Z"): RepoConfig => ({
  id,
  url: `https://github.com/${id}`,
  localPath: `/tmp/repos/${id}`,
  mode: { _tag: "tracking", branch: "main" },
  lastSyncedCommit: Option.some("abc123"),
  lastSyncedAt: Option.some(DateTime.makeUnsafe(0)),
  lastSyncedCommitAt: DateTime.makeUnsafe(committedAt),
  addedAt: DateTime.makeUnsafe(0),
  cloudEnabled: false,
  lastPushedAt: Option.none(),
  lastPushedCommit: Option.none(),
  indexFormat: 2
})

const LONG_NAME = "Effect-TS/a-very-long-repository-name"

const rowsOf = (repos: ReadonlyArray<RepoConfig>): FlatRow[] =>
  repos.map((r) => ({ kind: "repo", repo: r, label: r.id, indented: false }))

const rows = rowsOf([repo("acme/widgets"), repo(LONG_NAME), repo("acme/gadgets", "2026-09-02T12:00:00Z")])

const show = async (width: number, shown = rows, height = 10) => {
  const app = await testRender(<RepoList flatRows={shown} totalRepos={shown.length} selectedIndex={0} />, {
    width,
    height
  })
  setup = app
  await interact(app, () => {})
  return app.captureCharFrame().split("\n")
}

const lineOf = (lines: ReadonlyArray<string>, text: string) => lines.find((line) => line.includes(text)) ?? ""

describe("RepoList", () => {
  it("gives a long name the room a wide terminal has", async () => {
    const lines = await show(160)
    const widgets = lineOf(lines, "acme/widgets")

    expect(widgets).toContain("tracking: main")
    expect(widgets).toContain("+ synced")
    const long = lineOf(lines, LONG_NAME)
    expect(long.indexOf("tracking: main")).toBe(widgets.indexOf("tracking: main"))
  })

  it("cuts a name longer than its column, keeping the columns aligned", async () => {
    const lines = await show(80)
    const widgets = lineOf(lines, "acme/widgets")

    expect(lines.some((line) => line.includes(LONG_NAME))).toBe(false)
    const long = lineOf(lines, "Effect-TS/a-very")
    expect(long).toContain("…")
    expect(long.indexOf("tracking: main")).toBe(widgets.indexOf("tracking: main"))
  })

  it("drops the mode column in a narrow terminal, keeping each repo on one line", async () => {
    const lines = await show(60)
    const widgets = lineOf(lines, "acme/widgets")

    expect(lines.some((line) => line.includes("tracking:"))).toBe(false)
    expect(widgets).toContain("+ synced")
    expect(widgets).toContain("21 Oct 2026")
    expect(lineOf(lines, "Effect-TS/a-very")).toContain("+ synced")
  })

  it("shows commit dates as DD MMM YYYY, so they line up", async () => {
    const lines = await show(160)
    const widgets = lineOf(lines, "acme/widgets")
    const gadgets = lineOf(lines, "acme/gadgets")

    expect(widgets).toContain("21 Oct 2026")
    expect(gadgets).toContain("02 Sep 2026")
    expect(gadgets.indexOf("02 Sep 2026")).toBe(widgets.indexOf("21 Oct 2026"))
  })

  it.each([60, 120])("keeps every date clear of the scrollbar at %i columns", async (width) => {
    const many = rowsOf(Array.from({ length: 20 }, (_, i) => repo(`acme/repo-${String(i).padStart(2, "0")}`)))
    const lines = await show(width, many, 8)

    const repoLines = lines.filter((line) => line.includes("acme/repo-"))
    expect(repoLines.length).toBeGreaterThan(0)
    for (const line of repoLines) {
      expect(line).toContain("21 Oct 2026")
      const dateEnd = line.indexOf("21 Oct 2026") + "21 Oct 2026".length
      expect(line.slice(dateEnd, dateEnd + 1)).toBe(" ")
    }
  })
})
