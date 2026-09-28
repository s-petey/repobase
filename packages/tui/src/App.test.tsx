import { afterEach, describe, expect, it, vi } from "vitest"
import { testRender } from "@opentui/react/test-utils"
import type { TestRendererSetup } from "@opentui/core/testing"
import { Option } from "effect"
import type { RepoConfig } from "@repobase/engine"
import { App } from "./App.js"
import { interact, teardown } from "./test/helpers.js"

const repo = (owner: string, name: string): RepoConfig => ({
  id: `${owner}-${name}`,
  url: `https://github.com/${owner}/${name}`,
  localPath: `/tmp/repos/${owner}-${name}`,
  mode: { _tag: "tracking", branch: "main" },
  lastSyncedCommit: Option.some("abc123"),
  lastSyncedAt: Option.some(new Date(0)),
  addedAt: new Date(0),
  cloudEnabled: false,
  lastPushedAt: Option.none(),
  lastPushedCommit: Option.none()
})

const renderApp = (repos: RepoConfig[], onQuit: () => void = () => {}) =>
  testRender(
    <App
      initialRepos={repos}
      onAddRepo={async () => repos[0]!}
      onRemoveRepo={async () => {}}
      onSyncRepo={async () => ({ updated: false })}
      onSyncAll={async () => []}
      onRefreshRepos={async () => repos}
      onSearch={async () => []}
      onJobsChange={() => () => {}}
      onRetryJob={async () => {}}
      onDiscardJob={async () => {}}
      onQuit={onQuit}
    />,
    { width: 160, height: 30 }
  )

let setup: TestRendererSetup | undefined

afterEach(async () => {
  await teardown(setup)
  setup = undefined
})

describe("App owner grouping", () => {
  const repos = [repo("sindresorhus", "ky"), repo("Effect-TS", "website"), repo("Effect-TS", "effect")]

  it("groups owners with 2+ repos under a header and leaves single repos flat", async () => {
    setup = await renderApp(repos)
    await interact(setup, () => {})
    const frame = setup.captureCharFrame()

    expect(frame).toContain("Repositories (3)")
    expect(frame).toContain("▼ Effect-TS (2 repos)")
    expect(frame).not.toContain("sindresorhus (")
    expect(frame).toContain("sindresorhus-ky")
    expect(frame).toContain("[Enter] Toggle group")

    // Rows under a header show just the repo name, sorted, after their header
    const lines = frame.split("\n")
    const at = (text: string) => lines.findIndex((l) => l.includes(text))
    expect(at("Effect-TS (2 repos)")).toBeLessThan(at(" effect "))
    expect(at(" effect ")).toBeLessThan(at(" website "))
    expect(frame).not.toContain("Effect-TS-effect")
  })

  it("collapses and expands a group with Enter, keeping the total count", async () => {
    setup = await renderApp(repos)
    await interact(setup, () => {})

    await interact(setup, () => setup!.mockInput.pressEnter())
    let frame = setup.captureCharFrame()
    expect(frame).toContain("▶ Effect-TS (2 repos)")
    expect(frame).not.toContain(" website ")
    expect(frame).toContain("Repositories (3)")

    await interact(setup, () => setup!.mockInput.pressEnter())
    frame = setup.captureCharFrame()
    expect(frame).toContain("▼ Effect-TS (2 repos)")
    expect(frame).toContain(" website ")
  })

  it("ignores delete on a header but confirms delete on a repo row", async () => {
    setup = await renderApp(repos)
    await interact(setup, () => {})

    await interact(setup, () => setup!.mockInput.pressKey("d"))
    expect(setup.captureCharFrame()).not.toContain("Are you sure")

    await interact(setup, () => setup!.mockInput.pressKey("j"))
    await interact(setup, () => setup!.mockInput.pressKey("d"))
    expect(setup.captureCharFrame()).toContain('delete "Effect-TS-effect"')
  })

  it("orders owners case-insensitively, then repos by name", async () => {
    setup = await renderApp([
      repo("zeta", "one"),
      repo("a-b", "y"),
      repo("a", "z"),
      repo("a", "x"),
      repo("Alpha", "web"),
      repo("Alpha", "api"),
      repo("beta", "solo")
    ])
    await interact(setup, () => {})
    const lines = setup.captureCharFrame().split("\n")
    const at = (text: string) => lines.findIndex((l) => l.includes(text))

    // Sorted by owner, not id: by id "a-b-y" < "a-x" would put owner "a-b" before "a"
    expect(at("▼ a (2 repos)")).toBeLessThan(at("a-b-y"))
    // Case-insensitive: "a-b" < "Alpha" < "beta" (code-point order would put "Alpha" first)
    expect(at("a-b-y")).toBeLessThan(at("Alpha (2 repos)"))
    expect(at("Alpha (2 repos)")).toBeLessThan(at(" api "))
    expect(at(" api ")).toBeLessThan(at(" web "))
    expect(at(" web ")).toBeLessThan(at("beta-solo"))
    expect(at("beta-solo")).toBeLessThan(at("zeta-one"))
  })

  it("opens the Tasks view with t or T and closes it with Esc", async () => {
    setup = await renderApp(repos)
    await interact(setup, () => {})
    expect(setup.captureCharFrame()).toContain("[t] Tasks")

    await interact(setup, () => setup!.mockInput.pressKey("t"))
    expect(setup.captureCharFrame()).toContain("No tasks yet.")

    // A lone Esc is only delivered after a short delay (it could start an escape sequence)
    await interact(setup, async () => {
      setup!.mockInput.pressEscape()
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    expect(setup.captureCharFrame()).not.toContain("No tasks yet.")

    await interact(setup, () => setup!.mockInput.pressKey("t", { shift: true }))
    expect(setup.captureCharFrame()).toContain("No tasks yet.")
  })

  it("closes the Tasks view with q without quitting the app", async () => {
    const onQuit = vi.fn()
    setup = await renderApp(repos, onQuit)
    await interact(setup, () => {})

    await interact(setup, () => setup!.mockInput.pressKey("t"))
    await interact(setup, () => setup!.mockInput.pressKey("q"))
    expect(setup.captureCharFrame()).not.toContain("No tasks yet.")
    expect(onQuit).not.toHaveBeenCalled()
  })

  it("reopens the search box with the last query when leaving the results", async () => {
    setup = await renderApp(repos)
    await interact(setup, () => {})

    await interact(setup, () => setup!.mockInput.pressKey("/"))
    await interact(setup, () => setup!.mockInput.pasteBracketedText("group repos"))
    await interact(setup, () => setup!.mockInput.pressEnter())
    expect(setup.captureCharFrame()).toContain('Search Results: "group repos"')

    await interact(setup, () => setup!.mockInput.pressKey("q"))
    let frame = setup.captureCharFrame()
    expect(frame).toContain("Search Repositories")
    expect(frame).toContain("group repos")

    // Esc from the search box goes back to the repo list
    await interact(setup, async () => {
      setup!.mockInput.pressEscape()
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    frame = setup.captureCharFrame()
    expect(frame).not.toContain("Search Repositories")
    expect(frame).toContain("Repositories (3)")
  })

  it("shows no headers or toggle hint when every owner has a single repo", async () => {
    setup = await renderApp([repo("Effect-TS", "effect"), repo("sindresorhus", "ky")])
    await interact(setup, () => {})
    const frame = setup.captureCharFrame()

    expect(frame).not.toContain("▼")
    expect(frame).not.toContain("[Enter] Toggle group")
    expect(frame).toContain("Effect-TS-effect")
    expect(frame).toContain("sindresorhus-ky")
  })
})
