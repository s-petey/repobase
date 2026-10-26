import { type ComponentProps, Profiler } from "react"
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
  lastPushedCommit: Option.none(),
  indexFormat: 2
})

const runningJob = (id: string, repoId: string, kind: "syncRepo" | "reindexRepo" = "syncRepo"): Job => ({
  id,
  repoId,
  kind,
  payload: {},
  status: "running",
  createdAt: DateTime.makeUnsafe(0),
  updatedAt: DateTime.makeUnsafe(0),
  steps: []
})

const renderApp = (
  repos: RepoConfig[],
  onQuit: () => void = () => {},
  overrides: Partial<ComponentProps<typeof App>> = {}
) =>
  testRender(
    <App
      initialRepos={repos}
      onAddRepo={async () => repo("acme", "widgets")}
      onRemoveRepo={async () => {}}
      onSyncRepo={async () => ({ updated: false })}
      onSyncAll={async () => []}
      onRefreshRepos={async () => repos}
      onReindexRepos={async (ids) => ids.length}
      onSearch={async () => []}
      onJobsChange={() => () => {}}
      onProgressChange={() => () => {}}
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

const show = async (...args: Parameters<typeof renderApp>) => {
  const app = await renderApp(...args)
  setup = app
  return app
}

describe("App owner grouping", () => {
  const repos = [repo("sindresorhus", "ky"), repo("Effect-TS", "website"), repo("Effect-TS", "effect")]

  it("groups owners with 2+ repos under a header and leaves single repos flat", async () => {
    const app = await show(repos)
    await interact(app, () => {})
    const frame = app.captureCharFrame()

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
    const app = await show(repos)
    await interact(app, () => {})

    await interact(app, () => app.mockInput.pressEnter())
    let frame = app.captureCharFrame()
    expect(frame).toContain("▶ Effect-TS (2 repos)")
    expect(frame).not.toContain(" website ")
    expect(frame).toContain("Repositories (3)")

    await interact(app, () => app.mockInput.pressEnter())
    frame = app.captureCharFrame()
    expect(frame).toContain("▼ Effect-TS (2 repos)")
    expect(frame).toContain(" website ")
  })

  it("ignores delete on a header but confirms delete on a repo row", async () => {
    const app = await show(repos)
    await interact(app, () => {})

    await interact(app, () => app.mockInput.pressKey("d"))
    expect(app.captureCharFrame()).not.toContain("Are you sure")

    await interact(app, () => app.mockInput.pressKey("j"))
    await interact(app, () => app.mockInput.pressKey("d"))
    expect(app.captureCharFrame()).toContain('delete "Effect-TS/effect"')
  })

  it("orders owners case-insensitively, then repos by name", async () => {
    const app = await show([
      repo("zeta", "one"),
      repo("a-b", "y"),
      repo("a", "z"),
      repo("a", "x"),
      repo("Alpha", "web"),
      repo("Alpha", "api"),
      repo("beta", "solo")
    ])
    await interact(app, () => {})
    const lines = app.captureCharFrame().split("\n")
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
    const app = await show(repos)
    await interact(app, () => {})
    expect(app.captureCharFrame()).toContain("[t] Tasks")

    await interact(app, () => app.mockInput.pressKey("t"))
    expect(app.captureCharFrame()).toContain("No tasks yet.")

    // A lone Esc is only delivered after a short delay (it could start an escape sequence)
    await interact(app, async () => {
      app.mockInput.pressEscape()
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    expect(app.captureCharFrame()).not.toContain("No tasks yet.")

    await interact(app, () => app.mockInput.pressKey("t", { shift: true }))
    expect(app.captureCharFrame()).toContain("No tasks yet.")
  })

  it("closes the Tasks view with q without quitting the app", async () => {
    const onQuit = vi.fn()
    const app = await show(repos, onQuit)
    await interact(app, () => {})

    await interact(app, () => app.mockInput.pressKey("t"))
    await interact(app, () => app.mockInput.pressKey("q"))
    expect(app.captureCharFrame()).not.toContain("No tasks yet.")
    expect(onQuit).not.toHaveBeenCalled()
  })

  it("reopens the search box with the last query when leaving the results", async () => {
    const app = await show(repos)
    await interact(app, () => {})

    await interact(app, () => app.mockInput.pressKey("/"))
    await interact(app, () => app.mockInput.pasteBracketedText("group repos"))
    await interact(app, () => app.mockInput.pressEnter())
    expect(app.captureCharFrame()).toContain('Search Results: "group repos"')

    await interact(app, () => app.mockInput.pressKey("q"))
    let frame = app.captureCharFrame()
    expect(frame).toContain("Search Repositories")
    expect(frame).toContain("group repos")

    // Esc from the search box goes back to the repo list
    await interact(app, async () => {
      app.mockInput.pressEscape()
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    frame = app.captureCharFrame()
    expect(frame).not.toContain("Search Repositories")
    expect(frame).toContain("Repositories (3)")
  })

  it("searches with a glob filter and keeps it when reopening the search box", async () => {
    const onSearch = vi.fn(async (_query: string, _mode: string, _filter: unknown, _repos: unknown) => [])
    const app = await show(repos, () => {}, { onSearch })
    await interact(app, () => {})
    const glob = { kind: "glob", text: "src/**/*.ts" }
    // The Effect-TS group header is highlighted
    const group = ["Effect-TS/website", "Effect-TS/effect"]

    await interact(app, () => app.mockInput.pressKey("/"))
    await interact(app, () => app.mockInput.pasteBracketedText("group repos"))
    await interact(app, () => app.mockInput.pressTab())
    await interact(app, () => app.mockInput.pasteBracketedText("src/**/*.ts"))
    await interact(app, () => app.mockInput.pressTab())
    await interact(app, () => app.mockInput.pressKey("l"))
    await interact(app, () => app.mockInput.pressEnter())
    expect(onSearch.mock.calls).toEqual([["group repos", "hybrid", glob, group]])
    expect(app.captureCharFrame()).toContain(
      'Search Results: "group repos" in Effect-TS (2 repos) matching src/**/*.ts (Hybrid)'
    )

    await interact(app, () => app.mockInput.pressKey("q"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("src/**/*.ts")
    expect(frame).toContain("[*] Glob")
    await interact(app, () => app.mockInput.pressEnter())
    expect(onSearch.mock.calls[1]).toEqual(["group repos", "hybrid", glob, group])
  })

  it("searches the highlighted repo, or every repo once Search all is checked", async () => {
    const onSearch = vi.fn(async (_query: string, _mode: string, _filter: unknown, _repos: unknown) => [])
    const app = await show(repos, () => {}, { onSearch })
    await interact(app, () => {})

    // The first repo row under the Effect-TS header is Effect-TS/effect
    await interact(app, () => app.mockInput.pressKey("j"))
    await interact(app, () => app.mockInput.pressKey("/"))
    expect(app.captureCharFrame()).toContain("(searching Effect-TS/effect)")
    await interact(app, () => app.mockInput.pasteBracketedText("duration"))
    await interact(app, () => app.mockInput.pressEnter())
    expect(onSearch.mock.calls.at(-1)?.[3]).toEqual(["Effect-TS/effect"])
    expect(app.captureCharFrame()).toContain('Search Results: "duration" in Effect-TS/effect (Hybrid)')

    // Back to the search box, check Search all and search again
    await interact(app, () => app.mockInput.pressKey("q"))
    for (let i = 0; i < 3; i++) await interact(app, () => app.mockInput.pressTab())
    await interact(app, () => app.mockInput.pressKey(" "))
    await interact(app, () => app.mockInput.pressEnter())
    expect(onSearch.mock.calls.at(-1)?.[3]).toBeUndefined()
    expect(app.captureCharFrame()).toContain('Search Results: "duration" (Hybrid)')

    // The checkbox stays checked when reopening
    await interact(app, () => app.mockInput.pressKey("q"))
    expect(app.captureCharFrame()).toContain("[x] Search all repositories")
  })

  it("shows Sync All's progress and the worker limit while it runs", async () => {
    const app = await show(repos, () => {}, {
      onSyncAll: () => new Promise(() => {}),
      workerLimit: 2
    })
    await interact(app, () => {})

    await interact(app, () => app.mockInput.pressKey("s", { shift: true }))
    let frame = app.captureCharFrame()
    expect(frame).toContain("Syncing 0/3 repos · up to 2 workers")
    expect(frame).not.toContain("Processing...")
    expect(frame).toContain("[t] Tasks")

    // Still interactive while it runs: a second Sync All is refused, and other keys work
    await interact(app, () => app.mockInput.pressKey("s", { shift: true }))
    expect(app.captureCharFrame()).toContain("Sync All is already running")

    await interact(app, () => app.mockInput.pressKey("t"))
    expect(app.captureCharFrame()).toContain("No tasks yet.")
  })

  it("hides the add progress with Esc while the add carries on in the background", async () => {
    const app = await show(repos, () => {}, {
      // Stays pending, so the add is still running when Esc is pressed
      onAddRepo: () => new Promise(() => {})
    })
    await interact(app, () => {})

    await interact(app, () => app.mockInput.pressKey("a"))
    await interact(app, () => app.mockInput.pasteBracketedText("https://github.com/acme/widgets"))
    await interact(app, () => app.mockInput.pressEnter())
    expect(app.captureCharFrame()).toContain("Adding Repository")

    await interact(app, async () => {
      app.mockInput.pressEscape()
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    const frame = app.captureCharFrame()
    expect(frame).not.toContain("Adding Repository")
    expect(frame).toContain("Adding in the background")
  })

  it("won't delete a repo while it has a task running", async () => {
    const running = runningJob("syncRepo-Effect-TS__effect-1", "Effect-TS/effect")
    const app = await show(repos, () => {}, {
      onJobsChange: (listener) => {
        listener([running])
        return () => {}
      }
    })
    await interact(app, () => {})

    // The first repo row under the Effect-TS header is Effect-TS/effect
    await interact(app, () => app.mockInput.pressKey("j"))
    await interact(app, () => app.mockInput.pressKey("d"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("Effect-TS/effect has a task running")
    expect(frame).not.toContain("Are you sure")
  })

  it("warns on the first Ctrl+C and quits on the second", async () => {
    const onQuit = vi.fn()
    const app = await show(repos, onQuit)
    await interact(app, () => {})

    await interact(app, () => app.mockInput.pressCtrlC())
    expect(app.captureCharFrame()).toContain("Press Ctrl+C again to exit")
    // Ctrl+C is not the [c] Copy MCP Config key
    expect(app.captureCharFrame()).not.toContain("copied to clipboard")
    expect(onQuit).not.toHaveBeenCalled()

    await interact(app, () => app.mockInput.pressCtrlC())
    expect(onQuit).toHaveBeenCalledTimes(1)
    expect(app.captureCharFrame()).toContain("press Ctrl+C again to force quit")

    // Every press after that asks again, so the entry point can force the exit
    await interact(app, () => app.mockInput.pressCtrlC())
    expect(onQuit).toHaveBeenCalledTimes(2)
  })

  it("says how many running tasks Ctrl+C will stop", async () => {
    const running = (id: string) => runningJob(id, id)
    const app = await show(repos, () => {}, {
      onJobsChange: (listener) => {
        listener([running("a/one"), running("b/two")])
        return () => {}
      }
    })
    await interact(app, () => {})

    await interact(app, () => app.mockInput.pressCtrlC())
    expect(app.captureCharFrame()).toContain("2 running tasks will stop; resume or retry from [t] Tasks")
  })

  it("handles Ctrl+C while the search input has focus", async () => {
    const onQuit = vi.fn()
    const app = await show(repos, onQuit)
    await interact(app, () => {})

    await interact(app, () => app.mockInput.pressKey("/"))
    await interact(app, () => app.mockInput.pressCtrlC())
    const frame = app.captureCharFrame()
    expect(frame).toContain("Search Repositories")
    expect(frame).toContain("Press Ctrl+C again to exit")

    await interact(app, () => app.mockInput.pressCtrlC())
    expect(onQuit).toHaveBeenCalledTimes(1)
  })

  it("shows the Ctrl+C warning in the Tasks view, which has no status bar", async () => {
    const app = await show(repos)
    await interact(app, () => {})

    await interact(app, () => app.mockInput.pressKey("t"))
    await interact(app, () => app.mockInput.pressCtrlC())
    const frame = app.captureCharFrame()
    expect(frame).toContain("No tasks yet.")
    expect(frame).toContain("Press Ctrl+C again to exit")
  })

  it("shows no headers or toggle hint when every owner has a single repo", async () => {
    const app = await show([repo("Effect-TS", "effect"), repo("sindresorhus", "ky")])
    await interact(app, () => {})
    const frame = app.captureCharFrame()

    expect(frame).not.toContain("▼")
    expect(frame).not.toContain("[Enter] Toggle group")
    expect(frame).toContain("Effect-TS/effect")
    expect(frame).toContain("sindresorhus/ky")
  })

  it("shows the repo id for a lone repo whose URL isn't a GitHub URL", async () => {
    const app = await show([{ ...repo("local", "thing"), id: "local-thing", url: "file:///srv/thing" }])
    await interact(app, () => {})
    expect(app.captureCharFrame()).toContain("local-thing")
  })
})

describe("App status messages", () => {
  it("keeps a new message for its full time when an older one's timer runs out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const onSyncRepo = vi
        .fn<() => Promise<{ updated: boolean }>>()
        .mockResolvedValueOnce({ updated: true })
        .mockResolvedValueOnce({ updated: false })
      const app = await show([repo("m", "one")], () => {}, { onSyncRepo })
      await interact(app, () => {})

      await interact(app, () => app.mockInput.pressKey("s"))
      expect(app.captureCharFrame()).toContain("[OK] m/one updated")

      const advance = (ms: number) => () => {
        vi.advanceTimersByTime(ms)
      }
      await interact(app, advance(2500))
      await interact(app, () => app.mockInput.pressKey("s"))
      await interact(app, advance(1000))
      expect(app.captureCharFrame()).toContain("m/one already up to date")

      await interact(app, advance(2500))
      expect(app.captureCharFrame()).not.toContain("m/one already up to date")
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("App repo list selection and refresh", () => {
  const completed = (id: string, repoId: string): Job => ({
    id,
    repoId,
    kind: "syncRepo",
    payload: {},
    status: "completed",
    createdAt: DateTime.makeUnsafe(0),
    updatedAt: DateTime.makeUnsafe(0),
    steps: []
  })

  const withJobs = () => {
    let emit: (jobs: ReadonlyArray<Job>) => void = () => {}
    const onJobsChange = (listener: (jobs: ReadonlyArray<Job>) => void) => {
      emit = listener
      return () => {}
    }
    return { onJobsChange, emit: (jobs: ReadonlyArray<Job>) => emit(jobs) }
  }

  it("refreshes the repo list once when a job completes", async () => {
    const jobs = withJobs()
    const onRefreshRepos = vi.fn(async () => [repo("m", "one")])
    const app = await show([repo("m", "one")], () => {}, { onJobsChange: jobs.onJobsChange, onRefreshRepos })
    await interact(app, () => jobs.emit([]))

    await interact(app, () => jobs.emit([completed("j1", "m/one")]))
    await interact(app, () => jobs.emit([completed("j1", "m/one")]))

    expect(onRefreshRepos).toHaveBeenCalledTimes(1)
  })

  it("keeps the selected repo when a refresh lists another repo above it", async () => {
    const jobs = withJobs()
    const before = [repo("m", "one"), repo("p", "two")]
    const after = [repo("a", "zero"), ...before]
    const app = await show(before, () => {}, { onJobsChange: jobs.onJobsChange, onRefreshRepos: async () => after })
    await interact(app, () => jobs.emit([]))
    await interact(app, () => app.mockInput.pressKey("j"))

    await interact(app, () => jobs.emit([completed("j1", "a/zero")]))
    await interact(app, () => {})
    await interact(app, () => app.mockInput.pressKey("d"))

    expect(app.captureCharFrame()).toContain('delete "p/two"')
  })

  it("moves to the last repo in the same commit when the list shrinks under the cursor", async () => {
    const jobs = withJobs()
    const before = [repo("m", "one"), repo("p", "two"), repo("s", "three")]
    let commits = 0
    const app = (setup = await testRender(
      <Profiler id="app" onRender={() => commits++}>
        <App
          initialRepos={before}
          onAddRepo={async () => before[0]}
          onRemoveRepo={async () => {}}
          onSyncRepo={async () => ({ updated: false })}
          onSyncAll={async () => []}
          onRefreshRepos={async () => before.slice(0, 2)}
          onReindexRepos={async (ids) => ids.length}
          onSearch={async () => []}
          onJobsChange={jobs.onJobsChange}
          onProgressChange={() => () => {}}
          onRetryJob={async () => {}}
          onDiscardJob={async () => {}}
          onQuit={() => {}}
        />
      </Profiler>,
      { width: 160, height: 30, exitOnCtrlC: false }
    ))
    await interact(app, () => jobs.emit([]))
    await interact(app, () => app.mockInput.pressKey("j"))
    await interact(app, () => app.mockInput.pressKey("j"))

    commits = 0
    await interact(app, () => jobs.emit([completed("j1", "s/three")]))
    await interact(app, () => {})

    expect(commits).toBe(1)
    await interact(app, () => app.mockInput.pressKey("d"))
    expect(app.captureCharFrame()).toContain('delete "p/two"')
  })
})

describe("App re-indexing repos in an old index format", () => {
  const outdated = (owner: string, name: string): RepoConfig => ({ ...repo(owner, name), indexFormat: 1 })
  // Rows: the Effect-TS header, effect, website, then sindresorhus/ky
  const repos = [outdated("Effect-TS", "effect"), outdated("Effect-TS", "website"), repo("sindresorhus", "ky")]

  const escape = (s: TestRendererSetup) =>
    interact(s, async () => {
      s.mockInput.pressEscape()
      await new Promise((resolve) => setTimeout(resolve, 100))
    })

  it("doesn't ask when every repo is current", async () => {
    const app = await show([repo("sindresorhus", "ky")])
    await interact(app, () => {})

    expect(app.captureCharFrame()).not.toContain("Search index update")
    expect(app.captureCharFrame()).not.toContain("searchable until re-indexed")
  })

  it("asks at launch, and re-indexes every outdated repo on Enter", async () => {
    const onReindexRepos = vi.fn(async (ids: ReadonlyArray<string>) => ids.length)
    const app = await show(repos, () => {}, { onReindexRepos })
    await interact(app, () => {})
    let frame = app.captureCharFrame()
    expect(frame).toContain("Search index update")
    expect(frame).toContain("2 of 3 repos need re-indexing")
    // The whole message fits, above the keys
    expect(frame).toContain("keep using repobase")
    expect(frame).toContain("[Enter] Re-index now  [Esc] Later")

    await interact(app, () => app.mockInput.pressEnter())

    expect(onReindexRepos.mock.calls).toEqual([[["Effect-TS/effect", "Effect-TS/website"]]])
    frame = app.captureCharFrame()
    expect(frame).not.toContain("Search index update")
    expect(frame).toContain("Re-indexing 2 repos in the background")
  })

  it("after Later, marks them, warns, and re-indexes with [r] and [R]", async () => {
    const onReindexRepos = vi.fn(async (ids: ReadonlyArray<string>) => ids.length)
    const app = await show(repos, () => {}, { onReindexRepos })
    await interact(app, () => {})
    await escape(app)

    let frame = app.captureCharFrame()
    expect(frame).not.toContain("Search index update")
    expect(frame).toContain("2 repos aren't searchable until re-indexed · [r] Re-index  [R] All")
    expect(frame.match(/! re-index/g)).toHaveLength(2)
    expect(onReindexRepos).not.toHaveBeenCalled()

    // sindresorhus/ky is current: [r] there does nothing
    for (let i = 0; i < 3; i++) await interact(app, () => app.mockInput.pressKey("j"))
    await interact(app, () => app.mockInput.pressKey("r"))
    expect(app.captureCharFrame()).toContain("sindresorhus/ky doesn't need re-indexing")
    expect(onReindexRepos).not.toHaveBeenCalled()

    // Effect-TS/effect, then every outdated repo
    for (let i = 0; i < 2; i++) await interact(app, () => app.mockInput.pressKey("k"))
    await interact(app, () => app.mockInput.pressKey("r"))
    expect(onReindexRepos.mock.calls.at(-1)).toEqual([["Effect-TS/effect"]])
    await interact(app, () => app.mockInput.pressKey("r", { shift: true }))
    expect(onReindexRepos.mock.calls.at(-1)).toEqual([["Effect-TS/effect", "Effect-TS/website"]])

    // [r] on the group header: its outdated repos
    await interact(app, () => app.mockInput.pressKey("k"))
    await interact(app, () => app.mockInput.pressKey("r"))
    expect(onReindexRepos.mock.calls.at(-1)).toEqual([["Effect-TS/effect", "Effect-TS/website"]])
    frame = app.captureCharFrame()
    expect(frame).toContain("Re-indexing 2 repos in the background")
  })

  it("shows a repo as indexing while a job runs on it", async () => {
    const running = runningJob("reindex-1", "Effect-TS/effect", "reindexRepo")
    const app = await show(repos, () => {}, {
      onJobsChange: (listener) => {
        listener([running])
        return () => {}
      }
    })
    await interact(app, () => {})
    await escape(app)

    const frame = app.captureCharFrame()
    expect(frame).toContain("~ indexing")
    expect(frame.match(/! re-index/g)).toHaveLength(1)
    expect(frame).toContain("1 repo isn't searchable until re-indexed")
  })

  it("warns in the results when the search covered an outdated repo", async () => {
    const app = await show(repos)
    await interact(app, () => {})
    await escape(app)

    // The Effect-TS header is highlighted, so the search covers its two repos
    await interact(app, () => app.mockInput.pressKey("/"))
    await interact(app, () => app.mockInput.pasteBracketedText("duration"))
    await interact(app, () => app.mockInput.pressEnter())

    expect(app.captureCharFrame()).toContain("⚠ 2 of these repos aren't searchable until re-indexed; press [r] in the list")
  })
})
