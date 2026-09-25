import { afterEach, describe, expect, it } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import type { TestRendererSetup } from "@opentui/core/testing"
import { Option } from "effect"
import type { RepoConfig } from "@repobase/engine"
import { App } from "../src/App.js"
import { interact, teardown } from "./helpers.js"

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

const renderApp = (repos: RepoConfig[]) =>
  testRender(
    <App
      initialRepos={repos}
      onAddRepo={async () => repos[0]!}
      onRemoveRepo={async () => {}}
      onSyncRepo={async () => ({ updated: false })}
      onSyncAll={async () => []}
      onRefreshRepos={async () => repos}
      onSearch={async () => []}
      onQuit={() => {}}
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
