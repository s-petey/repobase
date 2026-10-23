import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import type { RepoConfig, SearchMode, SearchResult, AddRepoProgress, FileProgress, Job } from "@repobase/engine"
import { initialProgress, needsReindex, repoNames } from "@repobase/engine"
import { Array as Arr, DateTime, Order } from "effect"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Header, RepoList, StatusBar, AddRepoModal, SearchModal, SearchResults, ProgressModal, ConfirmDialog, TasksView } from "./components/index.js"
import type { FlatRow } from "./components/RepoList.js"
import { colors } from "./theme/index.js"
import { featureFlags } from "./config.js"
import { jobCounts, syncActivityText, type SyncActivity } from "./jobView.js"
import type { SearchFilter, SearchScope } from "./searchView.js"

type AppMode = "list" | "add" | "syncing" | "search" | "results" | "adding" | "confirmDelete" | "confirmReindex" | "jobs"

type ExitStage = "idle" | "confirming" | "quitting"

// How long a first Ctrl+C waits for the second one
const EXIT_CONFIRM_MS = 3000

const exitNotice = (stage: ExitStage, running: number): string | undefined => {
  if (stage === "quitting") return "Exiting... press Ctrl+C again to force quit"
  if (stage === "idle") return undefined
  if (running === 0) return "Press Ctrl+C again to exit"
  const tasks = running === 1 ? "1 running task" : `${running} running tasks`
  return `Press Ctrl+C again to exit · ${tasks} will stop; resume or retry from [t] Tasks`
}

interface AppProps {
  initialRepos: RepoConfig[]
  onAddRepo: (url: string, onProgress: (progress: AddRepoProgress) => void) => Promise<RepoConfig>
  onRemoveRepo: (id: string) => Promise<void>
  onSyncRepo: (id: string) => Promise<{ updated: boolean; resumedFrom?: string }>
  onSyncAll: () => Promise<Array<{ id: string; updated: boolean; resumed?: boolean }>>
  onRefreshRepos: () => Promise<RepoConfig[]>
  onReindexRepos: (repoIds: ReadonlyArray<string>) => Promise<number>
  onSearch: (
    query: string,
    mode: SearchMode,
    filter: SearchFilter | undefined,
    repos: ReadonlyArray<string> | undefined
  ) => Promise<SearchResult[]>
  onJobsChange: (listener: (jobs: ReadonlyArray<Job>) => void) => () => void
  onProgressChange: (listener: (progress: ReadonlyMap<string, FileProgress>) => void) => () => void
  onRetryJob: (jobId: string) => Promise<void>
  onDiscardJob: (jobId: string) => Promise<void>
  onQuit: () => void
  cloudConfigured?: boolean
  workerLimit?: number
}

interface ParsedRepo {
  readonly repo: RepoConfig
  readonly owner: string
  readonly name: string
}

const lowercaseCompare = Order.mapInput(Order.String, (s: string) => s.toLowerCase())
const byOwnerThenName = Order.Struct({ owner: lowercaseCompare, name: lowercaseCompare })

// Group repos by owner; owners with a single repo stay as flat rows
function buildFlatRows(repos: RepoConfig[], collapsed: Set<string>): FlatRow[] {
  const parsed = Arr.map(repos, (repo): ParsedRepo => ({ repo, ...repoNames(repo) }))
  if (!Arr.isReadonlyArrayNonEmpty(parsed)) return []

  // Sorted by owner, so groupWith collects each owner's repos into one adjacent group
  const groups = Arr.groupWith(Arr.sort(parsed, byOwnerThenName), (a, b) => a.owner === b.owner)

  return Arr.flatMap(groups, (group): FlatRow[] => {
    const { owner, repo } = Arr.headNonEmpty(group)
    if (group.length === 1) {
      return [{ kind: "repo", repo, label: repo.id, indented: false }]
    }

    const isCollapsed = collapsed.has(owner)
    const header: FlatRow = { kind: "header", owner, repoCount: group.length, collapsed: isCollapsed }
    if (isCollapsed) return [header]

    return [header, ...Arr.map(group, ({ repo, name }): FlatRow => ({ kind: "repo", repo, label: name, indented: true }))]
  })
}

const rowKey = (row: FlatRow) => `${row.kind}:${row.kind === "header" ? row.owner : row.repo.id}`

export const App = ({
  initialRepos,
  onAddRepo,
  onRemoveRepo,
  onSyncRepo,
  onSyncAll,
  onRefreshRepos,
  onReindexRepos,
  onSearch,
  onJobsChange,
  onProgressChange,
  onRetryJob,
  onDiscardJob,
  onQuit,
  cloudConfigured = false,
  workerLimit,
}: AppProps) => {
  const [repos, setRepos] = useState<RepoConfig[]>(initialRepos)
  const [selection, setSelection] = useState<{ readonly key?: string; readonly index: number }>({ index: 0 })
  const [mode, setMode] = useState<AppMode>(() => (initialRepos.some(needsReindex) ? "confirmReindex" : "list"))
  const [message, setMessage] = useState<string | undefined>()
  const [inputValue, setInputValue] = useState("")
  const [addProgress, setAddProgress] = useState<AddRepoProgress>(initialProgress)
  const [searchQuery, setSearchQuery] = useState("")
  const [searchMode, setSearchMode] = useState<SearchMode>("hybrid")
  const [searchFilter, setSearchFilter] = useState<SearchFilter | undefined>()
  const [searchAll, setSearchAll] = useState(false)
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searchResultIndex, setSearchResultIndex] = useState(0)
  const [repoToDelete, setRepoToDelete] = useState<RepoConfig | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [jobs, setJobs] = useState<ReadonlyArray<Job>>([])
  const [syncActivity, setSyncActivity] = useState<SyncActivity | undefined>()
  const [exitStage, setExitStage] = useState<ExitStage>("idle")

  const exitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const messageTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(
    () => () => {
      clearTimeout(exitTimer.current)
      clearTimeout(messageTimer.current)
    },
    []
  )

  useEffect(() => {
    let previouslyCompleted: ReadonlySet<string> | undefined
    return onJobsChange((next) => {
      setJobs(next)
      const completed = new Set(next.filter((j) => j.status === "completed").map((j) => j.id))
      const previous = previouslyCompleted
      previouslyCompleted = completed
      if (previous && [...completed].some((id) => !previous.has(id))) void onRefreshRepos().then(setRepos)
    })
  }, [onJobsChange, onRefreshRepos])

  const flatRows = useMemo(() => buildFlatRows(repos, collapsedGroups), [repos, collapsedGroups])
  const lastRow = Math.max(0, flatRows.length - 1)
  const foundRow = flatRows.findIndex((row) => rowKey(row) === selection.key)
  const selectedIndex = foundRow >= 0 ? foundRow : Math.min(selection.index, lastRow)
  const selectedRow = flatRows[selectedIndex]
  if (selectedRow && (rowKey(selectedRow) !== selection.key || selectedIndex !== selection.index)) {
    setSelection({ key: rowKey(selectedRow), index: selectedIndex })
  }
  const selectRow = (index: number) => {
    const row = flatRows[index]
    setSelection({ key: row ? rowKey(row) : undefined, index })
  }

  const highlightedScope = useMemo((): SearchScope | undefined => {
    const row = flatRows[selectedIndex]
    if (!row) return undefined
    if (row.kind === "repo") return { label: row.repo.id, repos: [row.repo.id] }
    const ids = repos.filter((r) => repoNames(r).owner === row.owner).map((r) => r.id)
    return { label: `${row.owner} (${ids.length} repos)`, repos: ids }
  }, [flatRows, selectedIndex, repos])

  const outdated = useMemo(() => repos.filter(needsReindex).map((r) => r.id), [repos])
  const reindexing = useMemo(
    () => new Set(jobs.filter((j) => j.status === "running" && outdated.includes(j.repoId)).map((j) => j.repoId)),
    [jobs, outdated]
  )

  const showMessage = useCallback((msg: string, duration = 3000) => {
    clearTimeout(messageTimer.current)
    setMessage(msg)
    messageTimer.current = setTimeout(() => setMessage(undefined), duration)
  }, [])

  const leave = useCallback((from: AppMode) => setMode((current) => (current === from ? "list" : current)), [])

  const handleAddRepo = useCallback(async (url: string) => {
    if (!url.trim()) {
      setMode("list")
      return
    }

    // Reset progress and show progress modal
    setAddProgress(initialProgress)
    setMode("adding")

    try {
      await onAddRepo(url, (progress) => {
        setAddProgress(progress)
      })
      const updatedRepos = await onRefreshRepos()
      setRepos(updatedRepos)
      // Keep showing progress modal with complete state for a moment
      setTimeout(() => {
        showMessage(`[OK] Added repository`)
        leave("adding")
      }, 500)
    } catch (error) {
      setAddProgress({
        stage: "error",
        progress: 0,
        message: error instanceof Error ? error.message : "Failed to add"
      })
      // Show error state briefly then return to list
      setTimeout(() => {
        showMessage(`Error: ${error instanceof Error ? error.message : "Failed to add"}`)
        leave("adding")
      }, 2000)
    }

    setInputValue("")
  }, [onAddRepo, onRefreshRepos, showMessage, leave])

  const handleConfirmDelete = useCallback(async () => {
    if (!repoToDelete) return

    setMode("syncing")
    setMessage(`Removing ${repoToDelete.id}...`)

    try {
      await onRemoveRepo(repoToDelete.id)
      const updatedRepos = await onRefreshRepos()
      setRepos(updatedRepos)
      showMessage(`[OK] Removed ${repoToDelete.id}`)
    } catch (error) {
      showMessage(`Error: ${error instanceof Error ? error.message : "Failed to remove"}`)
    }

    setRepoToDelete(null)
    setMode("list")
  }, [repoToDelete, onRemoveRepo, onRefreshRepos, showMessage])

  const handleCancelDelete = useCallback(() => {
    setRepoToDelete(null)
    setMode("list")
  }, [])

  const handleSyncRepo = useCallback(async (repo: RepoConfig) => {
    const activity: SyncActivity = { kind: "one", repoId: repo.id }
    setSyncActivity(activity)

    try {
      const result = await onSyncRepo(repo.id)
      const updatedRepos = await onRefreshRepos()
      setRepos(updatedRepos)
      const resumed = result.resumedFrom ? ` (resumed at ${result.resumedFrom})` : ""
      showMessage(result.updated ? `[OK] ${repo.id} updated${resumed}` : `${repo.id} already up to date${resumed}`)
    } catch (error) {
      showMessage(`Error: ${error instanceof Error ? error.message : "Failed to sync"}`)
    }

    setSyncActivity((current) => (current === activity ? undefined : current))
  }, [onSyncRepo, onRefreshRepos, showMessage])

  const handleSyncAll = useCallback(async () => {
    const activity: SyncActivity = { kind: "all", since: DateTime.nowUnsafe(), total: repos.length }
    setSyncActivity(activity)

    try {
      const results = await onSyncAll()
      const updatedRepos = await onRefreshRepos()
      setRepos(updatedRepos)
      const updatedCount = results.filter(r => r.updated).length
      const resumedCount = results.filter(r => r.resumed).length
      showMessage(
        `[OK] Synced ${results.length} repos (${updatedCount} updated${resumedCount > 0 ? `, ${resumedCount} resumed` : ""})`
      )
    } catch (error) {
      showMessage(`Error: ${error instanceof Error ? error.message : "Failed to sync"}`)
    }

    setSyncActivity((current) => (current === activity ? undefined : current))
  }, [onSyncAll, onRefreshRepos, showMessage, repos.length])

  const handleSearch = useCallback(async (
    query: string,
    searchModeParam: SearchMode,
    filter: SearchFilter | undefined,
    scopeRepos: ReadonlyArray<string> | undefined
  ) => {
    if (!query.trim()) {
      setMode("list")
      return
    }

    setMode("syncing")
    setMessage(`Searching: "${query}"...`)
    setSearchQuery(query)
    setSearchMode(searchModeParam)
    setSearchFilter(filter)
    setSearchAll(scopeRepos === undefined)

    try {
      const results = await onSearch(query, searchModeParam, filter, scopeRepos)
      setSearchResults(results)
      setSearchResultIndex(0)
      setMessage(undefined)
      setMode("results")
    } catch (error) {
      showMessage(`Error: ${error instanceof Error ? error.message : "Search failed"}`)
      setMode("list")
      setInputValue("")
      setSearchFilter(undefined)
      setSearchAll(false)
    }
  }, [onSearch, showMessage])

  const handleReindex = useCallback(async (repoIds: ReadonlyArray<string>) => {
    try {
      const started = await onReindexRepos(repoIds)
      // Repos with an id from before owner/name ids were renamed
      setRepos(await onRefreshRepos())
      showMessage(
        started === 0
          ? "Already re-indexing; see [t] Tasks"
          : `Re-indexing ${started === 1 ? "1 repo" : `${started} repos`} in the background; see [t] Tasks`
      )
    } catch (error) {
      showMessage(`Error: ${error instanceof Error ? error.message : "Failed to start re-indexing"}`)
    }
  }, [onReindexRepos, onRefreshRepos, showMessage])

  // Back to the search box with the last query, mode, filter and scope, to refine the search
  const handleCloseResults = useCallback(() => {
    setInputValue(searchQuery)
    setMode("search")
    setSearchResults([])
    setSearchResultIndex(0)
  }, [searchQuery])

  const handleCopyMcpConfig = useCallback(async () => {
    const mcpConfig = `{
  "mcpServers": {
    "repobase": {
      "command": "repobase-mcp"
    }
  }
}`

    try {
      // Use platform-specific clipboard command
      const platform = process.platform
      let command: string
      let args: string[]

      if (platform === "darwin") {
        // macOS
        command = "pbcopy"
        args = []
      } else if (platform === "linux") {
        // Linux - try xclip first, fallback to xsel
        command = "xclip"
        args = ["-selection", "clipboard"]
      } else if (platform === "win32") {
        // Windows
        command = "clip"
        args = []
      } else {
        throw new Error("Unsupported platform for clipboard")
      }

      const proc = Bun.spawn([command, ...args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })

      await proc.stdin.write(mcpConfig)
      proc.stdin.end()

      await proc.exited

      if (proc.exitCode !== 0) {
        // Try xsel on Linux if xclip failed
        if (platform === "linux") {
          const proc2 = Bun.spawn(["xsel", "--clipboard", "--input"], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          })
          await proc2.stdin.write(mcpConfig)
          proc2.stdin.end()
          await proc2.exited

          if (proc2.exitCode !== 0) {
            throw new Error("Failed to copy to clipboard")
          }
        } else {
          throw new Error("Failed to copy to clipboard")
        }
      }

      showMessage("[OK] MCP configuration copied to clipboard")
    } catch (error) {
      showMessage(`Error: ${error instanceof Error ? error.message : "Failed to copy to clipboard"}`)
    }
  }, [showMessage])

  const toggleGroup = useCallback((owner: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(owner)) next.delete(owner)
      else next.add(owner)
      return next
    })
  }, [])

  useKeyboard((key) => {
    // Ctrl+C works in every mode, so the app can always be exited. This handler is
    // registered before any modal's, so stopping propagation keeps the key from
    // modals and focused inputs.
    if (key.ctrl && key.name === "c") {
      key.stopPropagation()
      clearTimeout(exitTimer.current)
      if (exitStage === "idle") {
        setExitStage("confirming")
        exitTimer.current = setTimeout(() => setExitStage("idle"), EXIT_CONFIRM_MS)
      } else {
        // Once quitting, every further press calls onQuit again to force the exit
        setExitStage("quitting")
        onQuit()
      }
      return
    }

    // Handle escape/quit in any mode
    if (key.name === "escape" || (key.name === "q" && mode === "list")) {
      if (mode === "add" || mode === "search") {
        setMode("list")
        setInputValue("")
        setSearchFilter(undefined)
        setSearchAll(false)
      } else if (mode === "results") {
        handleCloseResults()
      } else if (mode === "confirmDelete") {
        handleCancelDelete()
      } else if (mode === "confirmReindex") {
        setMode("list")
      } else if (mode === "adding") {
        setMode("list")
        showMessage("Adding in the background; see [t] Tasks")
      } else if (mode === "list") {
        onQuit()
      }
      return
    }

    // Only handle navigation in list mode
    if (mode !== "list") return

    const row = flatRows[selectedIndex]

    switch (key.name) {
      case "up":
      case "k":
        selectRow(Math.max(0, selectedIndex - 1))
        break
      case "down":
      case "j":
        selectRow(Math.min(lastRow, selectedIndex + 1))
        break
      case "enter":
      case "return":
        if (row?.kind === "header") {
          toggleGroup(row.owner)
        }
        break
      case "left":
        if (row?.kind === "header" && !row.collapsed) {
          toggleGroup(row.owner)
        }
        break
      case "right":
        if (row?.kind === "header" && row.collapsed) {
          toggleGroup(row.owner)
        }
        break
      case "a":
        setMode("add")
        break
      case "d":
        if (row?.kind !== "repo") break
        if (jobs.some((j) => j.repoId === row.repo.id && j.status === "running")) {
          showMessage(`${row.repo.id} has a task running; wait for it or discard it in [t] Tasks`)
          break
        }
        setRepoToDelete(row.repo)
        setMode("confirmDelete")
        break
      case "s":
        if (key.shift) {
          if (syncActivity?.kind === "all") {
            showMessage("Sync All is already running; see [t] Tasks")
          } else {
            handleSyncAll()
          }
        } else if (row?.kind === "repo") {
          handleSyncRepo(row.repo)
        }
        break
      case "r": {
        // [R] every outdated repo, [r] those in the highlighted repo or group. Only
        // outdated ones: a full re-index of a current repo is expensive and changes nothing
        if (outdated.length === 0) {
          showMessage("Every repo is up to date; nothing to re-index")
          break
        }
        const scope = key.shift ? outdated : (highlightedScope?.repos ?? []).filter((id) => outdated.includes(id))
        if (scope.length === 0) {
          showMessage(`${highlightedScope?.label ?? "This repo"} doesn't need re-indexing · [R] re-indexes all ${outdated.length}`)
          break
        }
        handleReindex(scope)
        break
      }
      case "/":
        setMode("search")
        break
      case "t":
        setMode("jobs")
        break
      case "c":
        handleCopyMcpConfig()
        break
    }
  })

  const exitMessage = exitNotice(exitStage, jobCounts(jobs).running)
  // The results and tasks views have no status bar, so they show the exit notice on its own line
  const exitLine = exitMessage && (
    <text content={exitMessage} style={{ fg: colors.status.warning.default, attributes: TextAttributes.BOLD, paddingLeft: 1, height: 1 }} />
  )

  // Render search results view
  if (mode === "results") {
    const searched = searchAll ? repos.map((r) => r.id) : (highlightedScope?.repos ?? [])
    const unsearchable = searched.filter((id) => outdated.includes(id))
    const warning =
      unsearchable.length === 0
        ? undefined
        : `${unsearchable.length === 1 ? `${unsearchable[0]} isn't` : `${unsearchable.length} of these repos aren't`} searchable until re-indexed; press [r] in the list`
    return (
      <box
        style={{
          flexDirection: "column",
          width: "100%",
          height: "100%",
          backgroundColor: colors.bg.base,
        }}
      >
        <Header version="1.0.3" />
        <SearchResults
          query={searchQuery}
          mode={searchMode}
          filter={searchFilter}
          scope={searchAll ? undefined : highlightedScope}
          warning={warning}
          results={searchResults}
          selectedIndex={searchResultIndex}
          onSelectIndex={setSearchResultIndex}
          onClose={handleCloseResults}
        />
        {exitLine}
      </box>
    )
  }

  // Render the tasks view
  if (mode === "jobs") {
    return (
      <box
        style={{
          flexDirection: "column",
          width: "100%",
          height: "100%",
          backgroundColor: colors.bg.base,
        }}
      >
        <Header version="1.0.3" />
        <TasksView
          jobs={jobs}
          onProgressChange={onProgressChange}
          now={DateTime.nowUnsafe()}
          onRetry={onRetryJob}
          onDiscard={onDiscardJob}
          onClose={() => setMode("list")}
        />
        {exitLine}
      </box>
    )
  }

  return (
    <box
      style={{
        flexDirection: "column",
        width: "100%",
        height: "100%",
        backgroundColor: colors.bg.base,
      }}
    >
      <Header version="1.0.3" />
      <RepoList flatRows={flatRows} totalRepos={repos.length} selectedIndex={selectedIndex} reindexing={reindexing} />
      <StatusBar
        mode={mode}
        message={exitMessage ?? message}
        outdated={outdated.length - reindexing.size}
        grouped={flatRows.some(r => r.kind === "header")}
        jobCounts={jobCounts(jobs)}
        activity={syncActivity ? syncActivityText(syncActivity, jobs, workerLimit) : undefined}
        mcpServerRunning={false}
        cloudConfigured={featureFlags.cloudSync ? cloudConfigured : false}
        cloudPendingCount={featureFlags.cloudSync ? repos.filter(r => {
          if (!r.cloudEnabled) return false
          const localCommit = r.lastSyncedCommit ? r.lastSyncedCommit : null
          const cloudCommit = r.lastPushedCommit ? r.lastPushedCommit : null
          // Pending if cloud enabled but commits don't match
          if (localCommit === null) return false
          if (cloudCommit === null) return true
          return localCommit !== cloudCommit
        }).length : 0}
      />

      {mode === "add" && (
        <AddRepoModal
          onSubmit={handleAddRepo}
          onCancel={() => {
            setMode("list")
            setInputValue("")
          }}
          onInput={setInputValue}
          value={inputValue}
        />
      )}

      {mode === "search" && (
        <SearchModal
          onSubmit={handleSearch}
          onCancel={() => {
            setMode("list")
            setInputValue("")
            setSearchFilter(undefined)
            setSearchAll(false)
          }}
          onInput={setInputValue}
          value={inputValue}
          initialMode={searchMode}
          initialFilter={searchFilter}
          scope={highlightedScope}
          initialSearchAll={searchAll}
        />
      )}

      {mode === "adding" && (
        <ProgressModal progress={addProgress} />
      )}


      {mode === "confirmDelete" && repoToDelete && (
        <ConfirmDialog
          message={`Are you sure you want to delete "${repoToDelete.id}"? This action cannot be undone.`}
          onConfirm={handleConfirmDelete}
          onCancel={handleCancelDelete}
        />
      )}

      {mode === "confirmReindex" && (
        <ConfirmDialog
          title="Search index update"
          color={colors.status.warning.default}
          message={`repobase now indexes whole files. ${outdated.length} of ${repos.length} repos need re-indexing before search can find anything in them. It runs in the background, so you can keep using repobase.`}
          hints="[Enter] Re-index now  [Esc] Later"
          onConfirm={() => {
            setMode("list")
            handleReindex(outdated)
          }}
          onCancel={() => setMode("list")}
        />
      )}
    </box>
  )
}
