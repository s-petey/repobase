import { useKeyboard } from "@opentui/react"
import type { RepoConfig, SearchMode, SearchResult, AddRepoProgress } from "@repobase/engine"
import { initialProgress } from "@repobase/engine"
import { useCallback, useState, useRef, useMemo, useEffect } from "react"
import { Header, RepoList, StatusBar, AddRepoModal, SearchModal, SearchResults, ProgressModal, ConfirmDialog, StatusModal } from "./components/index.js"
import type { FlatRow } from "./components/RepoList.js"
import type { StatusInfo } from "./components/StatusModal.js"
import { colors } from "./theme/index.js"
import { featureFlags } from "./config.js"


type AppMode = "list" | "add" | "syncing" | "search" | "results" | "adding" | "confirmDelete" | "status"

interface AppProps {
  initialRepos: RepoConfig[]
  onAddRepo: (url: string, onProgress: (progress: AddRepoProgress) => void) => Promise<RepoConfig>
  onRemoveRepo: (id: string) => Promise<void>
  onSyncRepo: (id: string) => Promise<{ updated: boolean }>
  onSyncAll: () => Promise<Array<{ id: string; updated: boolean }>>
  onRefreshRepos: () => Promise<RepoConfig[]>
  onSearch: (query: string, mode: SearchMode) => Promise<SearchResult[]>
  onQuit: () => void
  cloudConfigured?: boolean
}

function buildFlatRows(repos: RepoConfig[], collapsed: Set<string>): FlatRow[] {
  if (repos.length <= 1) {
    return repos.map(r => ({ kind: "repo" as const, repo: r }))
  }

  const groups = new Map<string, RepoConfig[]>()
  for (const repo of repos) {
    const list = groups.get(repo.owner) ?? []
    list.push(repo)
    groups.set(repo.owner, list)
  }

  const rows: FlatRow[] = []
  const sortedOwners = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
  for (const [owner, groupRepos] of sortedOwners) {
    const sortedRepos = [...groupRepos].sort((a, b) => a.id.localeCompare(b.id))
    rows.push({ kind: "header", owner, repoCount: sortedRepos.length, collapsed: collapsed.has(owner) })
    if (!collapsed.has(owner)) {
      for (const repo of sortedRepos) {
        rows.push({ kind: "repo", repo })
      }
    }
  }
  return rows
}

export const App = ({
  initialRepos,
  onAddRepo,
  onRemoveRepo,
  onSyncRepo,
  onSyncAll,
  onRefreshRepos,
  onSearch,
  onQuit,
  cloudConfigured = false,
}: AppProps) => {
  const [repos, setRepos] = useState<RepoConfig[]>(initialRepos)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [mode, setMode] = useState<AppMode>("list")
  const [message, setMessage] = useState<string | undefined>()
  const [inputValue, setInputValue] = useState("")
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  // Progress state for adding repos (supports multiple concurrent operations)
  const [activeAdds, setActiveAdds] = useState<Record<string, AddRepoProgress>>({})
  const [completedAddCount, setCompletedAddCount] = useState(0)
  const addOpIdRef = useRef(0)
  const completedCountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Search state
  const [searchQuery, setSearchQuery] = useState("")
  const [searchMode, setSearchMode] = useState<SearchMode>("hybrid")
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searchResultIndex, setSearchResultIndex] = useState(0)

  // Delete confirmation state
  const [repoToDelete, setRepoToDelete] = useState<RepoConfig | null>(null)

  // Status modal state
  const [showStatus, setShowStatus] = useState(false)
  const lastProgressRef = useRef<StatusInfo | null>(null)

  const flatRows = useMemo(() => buildFlatRows(repos, collapsedGroups), [repos, collapsedGroups])

  // Clamp selectedIndex when flatRows shrinks (deletion, regrouping)
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

  const scheduleResetCompletedCount = useCallback(() => {
    if (completedCountTimerRef.current) {
      clearTimeout(completedCountTimerRef.current)
    }
    completedCountTimerRef.current = setTimeout(() => {
      setCompletedAddCount(0)
      completedCountTimerRef.current = null
    }, 3000)
  }, [])

  const handleAddRepo = useCallback(async (url: string) => {
    if (!url.trim()) {
      setMode("list")
      return
    }

    const opId = `add-${++addOpIdRef.current}`

    setActiveAdds(prev => ({ ...prev, [opId]: initialProgress }))
    setMode("adding")

    try {
      await onAddRepo(url, (progress) => {
        setActiveAdds(prev => ({ ...prev, [opId]: progress }))
        lastProgressRef.current = {
          stage: progress.stage,
          message: progress.message,
          progress: progress.progress,
          timestamp: new Date().toLocaleTimeString(),
        }
      })
      setActiveAdds(prev => {
        const next = { ...prev }
        delete next[opId]
        if (Object.keys(next).length === 0) {
          setCompletedAddCount(c => c + 1)
          scheduleResetCompletedCount()
        }
        return next
      })
      const updatedRepos = await onRefreshRepos()
      setRepos(updatedRepos)
      showMessage(`[OK] Added repository`)
      setMode(prev => prev === "adding" ? "list" : prev)
    } catch (error) {
      setActiveAdds(prev => {
        const next = { ...prev }
        delete next[opId]
        return next
      })
      showMessage(`Error: ${error instanceof Error ? error.message : "Failed to add"}`)
      setMode(prev => prev === "adding" ? "list" : prev)
    }

    setInputValue("")
  }, [onAddRepo, onRefreshRepos, showMessage, scheduleResetCompletedCount])

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
    setMode("syncing")
    setMessage(`Syncing ${repo.id}...`)

    try {
      const result = await onSyncRepo(repo.id)
      const updatedRepos = await onRefreshRepos()
      setRepos(updatedRepos)
      showMessage(result.updated ? `[OK] ${repo.id} updated` : `${repo.id} already up to date`)
    } catch (error) {
      showMessage(`Error: ${error instanceof Error ? error.message : "Failed to sync"}`)
    }

    setMode("list")
  }, [onSyncRepo, onRefreshRepos, showMessage])

  const handleSyncAll = useCallback(async () => {
    setMode("syncing")
    setMessage("Syncing all repositories...")

    try {
      const results = await onSyncAll()
      const updatedRepos = await onRefreshRepos()
      setRepos(updatedRepos)
      const updatedCount = results.filter(r => r.updated).length
      showMessage(`[OK] Synced ${results.length} repos (${updatedCount} updated)`)
    } catch (error) {
      showMessage(`Error: ${error instanceof Error ? error.message : "Failed to sync"}`)
    }

    setMode("list")
  }, [onSyncAll, onRefreshRepos, showMessage])

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
    }

    setInputValue("")
  }, [onSearch, showMessage])

  const handleCloseResults = useCallback(() => {
    setMode("list")
    setSearchResults([])
    setSearchQuery("")
    setSearchResultIndex(0)
  }, [])

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
      } else if (mode === "adding") {
        setMode("list")
      } else if (mode === "results") {
        handleCloseResults()
      } else if (mode === "confirmDelete") {
        handleCancelDelete()
      } else if (mode === "status") {
        setShowStatus(false)
        setMode('list')
      } else if (mode === "list") {
        onQuit()
      }
      return
    }

    // Handle "?" in any mode to show status
    if (key.name === "?") {
      if (mode === "status") {
        setShowStatus(false)
        setMode("list")
      } else {
        setShowStatus(true)
        setMode("status")
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
        if (row?.kind === "repo") {
          setRepoToDelete(row.repo)
          setMode("confirmDelete")
        }
        break
      case "s":
        if (key.shift) {
          handleSyncAll()
        } else if (row?.kind === "repo") {
          handleSyncRepo(row.repo)
        }
        break
      case "/":
        setMode("search")
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
      <RepoList flatRows={flatRows} selectedIndex={selectedIndex} totalRepoCount={repos.length} />
      <StatusBar
        mode={mode}
        message={message}
        activeAdds={activeAdds}
        completedAddCount={completedAddCount}
        grouped={repos.length > 1}
        mcpServerRunning={false}
        cloudConfigured={featureFlags.cloudSync ? cloudConfigured : false}
        cloudPendingCount={featureFlags.cloudSync ? repos.filter(r => {
          if (!r.cloudEnabled) return false
          const localCommit = r.lastSyncedCommit ? r.lastSyncedCommit : null
          const cloudCommit = r.lastPushedCommit ? r.lastPushedCommit : null
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
        />
      )}

      {mode === "adding" && (
        <ProgressModal activeAdds={activeAdds} />
      )}

      {mode === "confirmDelete" && repoToDelete && (
        <ConfirmDialog
          message={`Are you sure you want to delete "${repoToDelete.id}"? This action cannot be undone.`}
          onConfirm={handleConfirmDelete}
          onCancel={handleCancelDelete}
        />
      )}

      {showStatus && (
        <StatusModal
        status={lastProgressRef.current}
        onClose={() => {
          setShowStatus(false)
          setMode("list")
        }}
        />
      )}
    </box>
  )
}
