import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import { useEffect, useRef } from "react"
import { needsReindex, type RepoConfig } from "@repobase/engine"
import { DateTime, Option } from "effect"
import { fit, isNarrow } from "../layout.js"
import { colors } from "../theme/index.js"

export type FlatRow =
  | { kind: "header"; owner: string; repoCount: number; collapsed: boolean }
  | { kind: "repo"; repo: RepoConfig; label: string; indented: boolean }

interface RepoListProps {
  flatRows: FlatRow[]
  totalRepos: number
  selectedIndex: number
  reindexing?: ReadonlySet<string>
}

const formatMode = (repo: RepoConfig): string => {
  if (repo.mode._tag === "tracking") {
    return `tracking: ${repo.mode.branch}`
  }
  return `pinned: ${repo.mode.ref}`
}

const formatStatus = (repo: RepoConfig, reindexing: boolean): { text: string; color: string } => {
  if (needsReindex(repo)) {
    return reindexing
      ? { text: "~ indexing", color: colors.status.info.default }
      : { text: "! re-index", color: colors.status.warning.default }
  }
  if (repo.mode._tag === "pinned") {
    return { text: "o pinned", color: colors.text.secondary }
  }
  return Option.isSome(repo.lastSyncedCommit)
    ? { text: "+ synced", color: colors.status.success.default }
    : { text: "o pending", color: colors.status.warning.default }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

const formatCommitDate = (repo: RepoConfig): string => {
  if (!repo.lastSyncedCommitAt) return ""
  const date = DateTime.toDate(repo.lastSyncedCommitAt)
  return `${String(date.getDate()).padStart(2, "0")} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`
}

const formatCloudStatus =(repo: RepoConfig): string => {
  if (!repo.cloudEnabled) return ""

  // Check if cloud is in sync with local
  const localCommit = Option.getOrNull(repo.lastSyncedCommit)
  const cloudCommit = repo.lastPushedCommit ? Option.getOrNull(repo.lastPushedCommit) : null

  if (localCommit && cloudCommit && localCommit === cloudCommit) {
    return "[C]"
  } else if (repo.cloudEnabled) {
    return "[C^]"
  }
  return ""
}

const repoCountLabel = (count: number): string => {
  return `${count} repo${count !== 1 ? "s" : ""}`
}

const rowId = (index: number) => `repo-row-${index}`

const LIST_PADDING = 1
const MARKER_WIDTH = 2
const SCROLLBAR_WIDTH = 1
const SCROLLBAR_GAP = 1
const MIN_NAME_WIDTH = 8
const MODE_WIDTH = 18
const STATUS_WIDTH = 12
const DATE_WIDTH = 11 // "02 Sep 2026"

const nameWidthFor = (width: number, showMode: boolean) =>
  Math.max(
    MIN_NAME_WIDTH,
    width -
      2 * LIST_PADDING -
      MARKER_WIDTH -
      SCROLLBAR_WIDTH -
      SCROLLBAR_GAP -
      (showMode ? 1 + MODE_WIDTH : 0) -
      (1 + STATUS_WIDTH) -
      (1 + DATE_WIDTH)
  )

export const RepoList = ({ flatRows, totalRepos, selectedIndex, reindexing = new Set() }: RepoListProps) => {
  const { width } = useTerminalDimensions()
  const narrow = isNarrow(width)
  const nameWidth = nameWidthFor(width, !narrow)
  const listRef = useRef<ScrollBoxRenderable | null>(null)

  useEffect(() => {
    listRef.current?.scrollChildIntoView(rowId(selectedIndex))
  }, [selectedIndex])

  if (totalRepos === 0) {
    return (
      <box
        style={{
          flexGrow: 1,
          padding: 1,
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <text
          content="No repositories configured."
          style={{ fg: colors.text.secondary }}
        />
        <text
          content="Press [a] to add one."
          style={{ fg: colors.text.tertiary, marginTop: 1 }}
        />
      </box>
    )
  }

  return (
    <box
      style={{
        flexGrow: 1,
        flexDirection: "column",
        padding: 1,
      }}
    >
      <text
        content={`Repositories (${totalRepos})`}
        style={{
          fg: colors.text.primary,
          attributes: TextAttributes.BOLD,
          marginBottom: 1,
        }}
      />
      <scrollbox
        ref={listRef}
        style={{
          flexGrow: 1,
        }}
      >
        {flatRows.map((row, index) => {
          const isSelected = index === selectedIndex
          const prefix = isSelected ? "> " : "  "

          if (row.kind === "header") {
            const icon = row.collapsed ? "▶" : "▼"
            return (
              <box
                id={rowId(index)}
                key={`header-${row.owner}`}
                style={{
                  flexDirection: "row",
                  backgroundColor: isSelected ? colors.bg.selected : undefined,
                  padding: 0,
                }}
              >
                <text
                  content={`${prefix}${icon} ${row.owner} (${repoCountLabel(row.repoCount)})`}
                  style={{
                    fg: isSelected ? colors.text.primary : colors.accent.default,
                    attributes: isSelected ? TextAttributes.BOLD : TextAttributes.DIM,
                  }}
                />
              </box>
            )
          }

          const repo = row.repo
          const status = formatStatus(repo, reindexing.has(repo.id))
          const mode = formatMode(repo)
          const commitDate = formatCommitDate(repo)
          const cloudStatus = formatCloudStatus(repo)
          const indent = row.indented ? "  " : ""
          const name = fit(`${indent}${row.label}`, nameWidth)
          const columns = narrow
            ? [name, status.text.padEnd(STATUS_WIDTH), commitDate.padEnd(DATE_WIDTH), cloudStatus]
            : [name, mode.padEnd(MODE_WIDTH), status.text.padEnd(STATUS_WIDTH), commitDate.padEnd(DATE_WIDTH), cloudStatus]

          return (
            <box
              id={rowId(index)}
              key={repo.id}
              style={{
                flexDirection: "row",
                backgroundColor: isSelected ? colors.bg.selected : undefined,
                padding: 0,
              }}
            >
              <text
                content={`${prefix}${columns.join(" ")}`}
                style={{
                  fg: isSelected ? colors.text.primary : colors.interactive.default,
                  attributes: isSelected ? TextAttributes.BOLD : undefined,
                }}
              />
            </box>
          )
        })}
      </scrollbox>
    </box>
  )
}
