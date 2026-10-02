import type { ComponentProps } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { testRender } from "@opentui/react/test-utils"
import type { TestRendererSetup } from "@opentui/core/testing"
import { DateTime, Option } from "effect"
import type { Job, RepoConfig } from "@repobase/engine"
import { App } from "./App.js"
import { interact, teardown } from "./test/helpers.js"

const repo = (owner: string, name: string): RepoConfig => ({
  id: `${owner}/${name}`,
  url: `https://github.com/${owner}/${name}`,
  localPath: `/tmp/repos/${owner}/${name}`,
  mode: { _tag: "tracking", branch: "main" },
  lastSyncedCommit: Option.some("abc123"),
  lastSyncedAt: Option.some(DateTime.makeUnsafe(0)),
  addedAt: DateTime.makeUnsafe(0),
  cloudEnabled: false,
  lastPushedAt: Option.none(),
  lastPushedCommit: Option.none()
})

const renderApp = (
  repos: RepoConfig[],
  onQuit: () => void = () => {},
  overrides: Partial<ComponentProps<typeof App>> = {}
) =>
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
      {...overrides}
    />,
    // As in main.tsx, so Ctrl+C reaches the App instead of destroying the renderer
    { width: 160, height: 30, exitOnCtrlC: false }
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
    expect(frame).toContain("sindresorhus/ky")
    expect(frame).toContain("[Enter] Toggle group")

    // Rows under a header show just the repo name, sorted, after their header
    const lines = frame.split("\n")
    const at = (text: string) => lines.findIndex((l) => l.includes(text))
    expect(at("Effect-TS (2 repos)")).toBeLessThan(at(" effect "))
    expect(at(" effect ")).toBeLessThan(at(" website "))
    expect(frame).not.toContain("Effect-TS/effect")
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
    expect(setup.captureCharFrame()).toContain('delete "Effect-TS/effect"')
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

    // Sorted by owner, then name: owner "a" comes before owner "a-b"
    expect(at("▼ a (2 repos)")).toBeLessThan(at("a-b/y"))
    // Case-insensitive: "a-b" < "Alpha" < "beta" (code-point order would put "Alpha" first)
    expect(at("a-b/y")).toBeLessThan(at("Alpha (2 repos)"))
    expect(at("Alpha (2 repos)")).toBeLessThan(at(" api "))
    expect(at(" api ")).toBeLessThan(at(" web "))
    expect(at(" web ")).toBeLessThan(at("beta/solo"))
    expect(at("beta/solo")).toBeLessThan(at("zeta/one"))
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

  it("searches with a glob filter and keeps it when reopening the search box", async () => {
    const onSearch = vi.fn(async (_query: string, _mode: string, _filter: unknown, _repos: unknown) => [])
    setup = await renderApp(repos, () => {}, { onSearch })
    await interact(setup, () => {})
    const glob = { kind: "glob", text: "src/**/*.ts" }
    // The Effect-TS group header is highlighted
    const group = ["Effect-TS/website", "Effect-TS/effect"]

    await interact(setup, () => setup!.mockInput.pressKey("/"))
    await interact(setup, () => setup!.mockInput.pasteBracketedText("group repos"))
    await interact(setup, () => setup!.mockInput.pressTab())
    await interact(setup, () => setup!.mockInput.pasteBracketedText("src/**/*.ts"))
    await interact(setup, () => setup!.mockInput.pressTab())
    await interact(setup, () => setup!.mockInput.pressKey("l"))
    await interact(setup, () => setup!.mockInput.pressEnter())
    expect(onSearch.mock.calls).toEqual([["group repos", "hybrid", glob, group]])
    expect(setup.captureCharFrame()).toContain(
      'Search Results: "group repos" in Effect-TS (2 repos) matching src/**/*.ts (Hybrid)'
    )

    await interact(setup, () => setup!.mockInput.pressKey("q"))
    const frame = setup.captureCharFrame()
    expect(frame).toContain("src/**/*.ts")
    expect(frame).toContain("[*] Glob")
    await interact(setup, () => setup!.mockInput.pressEnter())
    expect(onSearch.mock.calls[1]).toEqual(["group repos", "hybrid", glob, group])
  })

  it("searches the highlighted repo, or every repo once Search all is checked", async () => {
    const onSearch = vi.fn(async (_query: string, _mode: string, _filter: unknown, _repos: unknown) => [])
    setup = await renderApp(repos, () => {}, { onSearch })
    await interact(setup, () => {})

    // The first repo row under the Effect-TS header is Effect-TS/effect
    await interact(setup, () => setup!.mockInput.pressKey("j"))
    await interact(setup, () => setup!.mockInput.pressKey("/"))
    expect(setup.captureCharFrame()).toContain("(searching Effect-TS/effect)")
    await interact(setup, () => setup!.mockInput.pasteBracketedText("duration"))
    await interact(setup, () => setup!.mockInput.pressEnter())
    expect(onSearch.mock.calls.at(-1)?.[3]).toEqual(["Effect-TS/effect"])
    expect(setup.captureCharFrame()).toContain('Search Results: "duration" in Effect-TS/effect (Hybrid)')

    // Back to the search box, check Search all and search again
    await interact(setup, () => setup!.mockInput.pressKey("q"))
    for (let i = 0; i < 3; i++) await interact(setup, () => setup!.mockInput.pressTab())
    await interact(setup, () => setup!.mockInput.pressKey(" "))
    await interact(setup, () => setup!.mockInput.pressEnter())
    expect(onSearch.mock.calls.at(-1)?.[3]).toBeUndefined()
    expect(setup.captureCharFrame()).toContain('Search Results: "duration" (Hybrid)')

    // The checkbox stays checked when reopening
    await interact(setup, () => setup!.mockInput.pressKey("q"))
    expect(setup.captureCharFrame()).toContain("[x] Search all repositories")
  })

  it("shows Sync All's progress and the worker limit while it runs", async () => {
    setup = await renderApp(repos, () => {}, {
      onSyncAll: () => new Promise(() => {}),
      workerLimit: 2
    })
    await interact(setup, () => {})

    await interact(setup, () => setup!.mockInput.pressKey("s", { shift: true }))
    let frame = setup.captureCharFrame()
    expect(frame).toContain("Syncing 0/3 repos · up to 2 workers")
    expect(frame).not.toContain("Processing...")
    expect(frame).toContain("[t] Tasks")

    // Still interactive while it runs: a second Sync All is refused, and other keys work
    await interact(setup, () => setup!.mockInput.pressKey("s", { shift: true }))
    expect(setup.captureCharFrame()).toContain("Sync All is already running")

    await interact(setup, () => setup!.mockInput.pressKey("t"))
    expect(setup.captureCharFrame()).toContain("No tasks yet.")
  })

  it("hides the add progress with Esc while the add carries on in the background", async () => {
    setup = await renderApp(repos, () => {}, {
      // Stays pending, so the add is still running when Esc is pressed
      onAddRepo: () => new Promise(() => {})
    })
    await interact(setup, () => {})

    await interact(setup, () => setup!.mockInput.pressKey("a"))
    await interact(setup, () => setup!.mockInput.pasteBracketedText("https://github.com/acme/widgets"))
    await interact(setup, () => setup!.mockInput.pressEnter())
    expect(setup.captureCharFrame()).toContain("Adding Repository")

    await interact(setup, async () => {
      setup!.mockInput.pressEscape()
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    const frame = setup.captureCharFrame()
    expect(frame).not.toContain("Adding Repository")
    expect(frame).toContain("Adding in the background")
  })

  it("won't delete a repo while it has a task running", async () => {
    const running = {
      id: "syncRepo-Effect-TS__effect-1",
      kind: "syncRepo",
      repoId: "Effect-TS/effect",
      payload: {},
      status: "running",
      createdAt: DateTime.makeUnsafe(0),
      updatedAt: DateTime.makeUnsafe(0),
      steps: []
    } as unknown as Job
    setup = await renderApp(repos, () => {}, {
      onJobsChange: (listener) => {
        listener([running])
        return () => {}
      }
    })
    await interact(setup, () => {})

    // The first repo row under the Effect-TS header is Effect-TS/effect
    await interact(setup, () => setup!.mockInput.pressKey("j"))
    await interact(setup, () => setup!.mockInput.pressKey("d"))
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Effect-TS/effect has a task running")
    expect(frame).not.toContain("Are you sure")
  })

  it("warns on the first Ctrl+C and quits on the second", async () => {
    const onQuit = vi.fn()
    setup = await renderApp(repos, onQuit)
    await interact(setup, () => {})

    await interact(setup, () => setup!.mockInput.pressCtrlC())
    expect(setup.captureCharFrame()).toContain("Press Ctrl+C again to exit")
    // Ctrl+C is not the [c] Copy MCP Config key
    expect(setup.captureCharFrame()).not.toContain("copied to clipboard")
    expect(onQuit).not.toHaveBeenCalled()

    await interact(setup, () => setup!.mockInput.pressCtrlC())
    expect(onQuit).toHaveBeenCalledTimes(1)
    expect(setup.captureCharFrame()).toContain("press Ctrl+C again to force quit")

    // Every press after that asks again, so the entry point can force the exit
    await interact(setup, () => setup!.mockInput.pressCtrlC())
    expect(onQuit).toHaveBeenCalledTimes(2)
  })

  it("says how many running tasks Ctrl+C will stop", async () => {
    const running = (id: string) =>
      ({ id, kind: "syncRepo", repoId: id, payload: {}, status: "running", steps: [] }) as unknown as Job
    setup = await renderApp(repos, () => {}, {
      onJobsChange: (listener) => {
        listener([running("a/one"), running("b/two")])
        return () => {}
      }
    })
    await interact(setup, () => {})

    await interact(setup, () => setup!.mockInput.pressCtrlC())
    expect(setup.captureCharFrame()).toContain("2 running tasks will stop; resume or retry from [t] Tasks")
  })

  it("handles Ctrl+C while the search input has focus", async () => {
    const onQuit = vi.fn()
    setup = await renderApp(repos, onQuit)
    await interact(setup, () => {})

    await interact(setup, () => setup!.mockInput.pressKey("/"))
    await interact(setup, () => setup!.mockInput.pressCtrlC())
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Search Repositories")
    expect(frame).toContain("Press Ctrl+C again to exit")

    await interact(setup, () => setup!.mockInput.pressCtrlC())
    expect(onQuit).toHaveBeenCalledTimes(1)
  })

  it("shows the Ctrl+C warning in the Tasks view, which has no status bar", async () => {
    setup = await renderApp(repos)
    await interact(setup, () => {})

    await interact(setup, () => setup!.mockInput.pressKey("t"))
    await interact(setup, () => setup!.mockInput.pressCtrlC())
    const frame = setup.captureCharFrame()
    expect(frame).toContain("No tasks yet.")
    expect(frame).toContain("Press Ctrl+C again to exit")
  })

  it("shows no headers or toggle hint when every owner has a single repo", async () => {
    setup = await renderApp([repo("Effect-TS", "effect"), repo("sindresorhus", "ky")])
    await interact(setup, () => {})
    const frame = setup.captureCharFrame()

    expect(frame).not.toContain("▼")
    expect(frame).not.toContain("[Enter] Toggle group")
    expect(frame).toContain("Effect-TS/effect")
    expect(frame).toContain("sindresorhus/ky")
  })

  it("shows the repo id for a lone repo whose URL isn't a GitHub URL", async () => {
    setup = await renderApp([{ ...repo("local", "thing"), id: "local-thing", url: "file:///srv/thing" }])
    await interact(setup, () => {})
    expect(setup.captureCharFrame()).toContain("local-thing")
  })
})
