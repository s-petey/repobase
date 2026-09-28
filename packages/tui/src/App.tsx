import { useKeyboard } from "@opentui/react"
import type { RepoConfig, SearchMode, SearchResult, AddRepoProgress, Job } from "@repobase/engine"
import { extractRepoParts, initialProgress } from "@repobase/engine"
import { Array as Arr, DateTime, Order } from "effect"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Header, RepoList, StatusBar, AddRepoModal, SearchModal, SearchResults, ProgressModal, ConfirmDialog, TasksView } from "./components/index.js"
import type { FlatRow } from "./components/RepoList.js"
import { colors } from "./theme/index.js"
import { featureFlags } from "./config.js"
import { jobCounts, syncActivityText, type SyncActivity } from "./jobView.js"

type AppMode = "list" | "add" | "syncing" | "search" | "results" | "adding" | "confirmDelete" | "jobs"

interface AppProps {
  initialRepos: RepoConfig[]
  onAddRepo: (url: string, onProgress: (progress: AddRepoProgress) => void) => Promise<RepoConfig>
  onRemoveRepo: (id: string) => Promise<void>
  onSyncRepo: (id: string) => Promise<{ updated: boolean }>
  onSyncAll: () => Promise<Array<{ id: string; updated: boolean }>>
  onRefreshRepos: () => Promise<RepoConfig[]>
  onSearch: (query: string, mode: SearchMode) => Promise<SearchResult[]>
  onJobsChange: (listener: (jobs: ReadonlyArray<Job>) => void) => () => void
  onRetryJob: (jobId: string) => Promise<void>
  onDiscardJob: (jobId: string) => Promise<void>
  onQuit: () => void
  cloudConfigured?: boolean
  workerLimit?: number
}

const repoParts = (repo: RepoConfig): { owner: string; name: string } => {
  try {
    return extractRepoParts(repo.url)
  } catch {
    return { owner: repo.id, name: repo.id }
  }
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
  const parsed = Arr.map(repos, (repo): ParsedRepo => ({ repo, ...repoParts(repo) }))
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

export const App = ({
  initialRepos,
  onAddRepo,
  onRemoveRepo,
  onSyncRepo,
  onSyncAll,
  onRefreshRepos,
  onSearch,
  onJobsChange,
  onRetryJob,
  onDiscardJob,
  onQuit,
  cloudConfigured = false,
  workerLimit,
}: AppProps) => {
  const [repos, setRepos] = useState<RepoConfig[]>(initialRepos)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [mode, setMode] = useState<AppMode>("list")
  const [message, setMessage] = useState<string | undefined>()
  const [inputValue, setInputValue] = useState("")

  // Progress state for adding repos
  const [addProgress, setAddProgress] = useState<AddRepoProgress>(initialProgress)

  // Search state
  const [searchQuery, setSearchQuery] = useState("")
  const [searchMode, setSearchMode] = useState<SearchMode>("hybrid")
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searchResultIndex, setSearchResultIndex] = useState(0)

  // Delete confirmation state
  const [repoToDelete, setRepoToDelete] = useState<RepoConfig | null>(null)

  // Owner groups the user has collapsed
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  const [jobs, setJobs] = useState<ReadonlyArray<Job>>([])
  const completedJobIds = useRef<ReadonlySet<string> | undefined>(undefined)
  const [syncActivity, setSyncActivity] = useState<SyncActivity | undefined>()

  useEffect(() => onJobsChange(setJobs), [onJobsChange])

  useEffect(() => {
    const completed = new Set(jobs.filter((j) => j.status === "completed").map((j) => j.id))
    const previous = completedJobIds.current
    completedJobIds.current = completed
    if (previous && [...completed].some((id) => !previous.has(id))) {
      void onRefreshRepos().then(setRepos)
    }
  }, [jobs, onRefreshRepos])

  const flatRows = useMemo(() => buildFlatRows(repos, collapsedGroups), [repos, collapsedGroups])

  // Clamp selectedIndex when flatRows shrinks (deletion, collapsing)
  useEffect(() => {
    const max = Math.max(0, flatRows.length - 1)
    if (selectedIndex > max) {
      setSelectedIndex(max)
    }
  }, [flatRows.length, selectedIndex])

  const showMessage = useCallback((msg: string, duration = 3000) => {
    setMessage(msg)
    setTimeout(() => setMessage(undefined), duration)
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
      showMessage(result.updated ? `[OK] ${repo.id} updated` : `${repo.id} already up to date`)
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
      showMessage(`[OK] Synced ${results.length} repos (${updatedCount} updated)`)
    } catch (error) {
      showMessage(`Error: ${error instanceof Error ? error.message : "Failed to sync"}`)
    }

    setSyncActivity((current) => (current === activity ? undefined : current))
  }, [onSyncAll, onRefreshRepos, showMessage, repos.length])

  const handleSearch = useCallback(async (query: string, searchModeParam: SearchMode) => {
    if (!query.trim()) {
      setMode("list")
      return
    }

    setMode("syncing")
    setMessage(`Searching: "${query}"...`)
    setSearchQuery(query)
    setSearchMode(searchModeParam)

    try {
      const results = await onSearch(query, searchModeParam)
      setSearchResults(results)
      setSearchResultIndex(0)
      setMessage(undefined)
      setMode("results")
    } catch (error) {
      showMessage(`Error: ${error instanceof Error ? error.message : "Search failed"}`)
      setMode("list")
      setInputValue("")
    }
  }, [onSearch, showMessage])

  // Back to the search box with the last query and mode, to refine the search
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
    // Handle escape/quit in any mode
    if (key.name === "escape" || (key.name === "q" && mode === "list")) {
      if (mode === "add" || mode === "search") {
        setMode("list")
        setInputValue("")
      } else if (mode === "results") {
        handleCloseResults()
      } else if (mode === "confirmDelete") {
        handleCancelDelete()
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
        setSelectedIndex(Math.max(0, selectedIndex - 1))
        break
      case "down":
      case "j":
        setSelectedIndex(Math.min(flatRows.length - 1, selectedIndex + 1))
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

  // Render search results view
  if (mode === "results") {
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
          results={searchResults}
          selectedIndex={searchResultIndex}
          onSelectIndex={setSearchResultIndex}
          onClose={handleCloseResults}
        />
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
          now={DateTime.nowUnsafe()}
          onRetry={onRetryJob}
          onDiscard={onDiscardJob}
          onClose={() => setMode("list")}
        />
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
      <RepoList flatRows={flatRows} totalRepos={repos.length} selectedIndex={selectedIndex} />
      <StatusBar
        mode={mode}
        message={message}
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
          }}
          onInput={setInputValue}
          value={inputValue}
          initialMode={searchMode}
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
    </box>
  )
}
