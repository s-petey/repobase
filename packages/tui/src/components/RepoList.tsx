import { TextAttributes } from "@opentui/core"
import { needsReindex, type RepoConfig } from "@repobase/engine"
import { Option } from "effect"
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

const formatCloudStatus = (repo: RepoConfig): string => {
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

export const RepoList = ({ flatRows, totalRepos, selectedIndex, reindexing = new Set() }: RepoListProps) => {
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
        focused
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
          const cloudStatus = formatCloudStatus(repo)
          const indent = row.indented ? "  " : ""

          return (
            <box
              key={repo.id}
              style={{
                flexDirection: "row",
                backgroundColor: isSelected ? colors.bg.selected : undefined,
                padding: 0,
              }}
            >
              <text
                content={`${prefix}${indent}${row.label.padEnd(24 - indent.length)} ${mode.padEnd(18)} ${status.text.padEnd(12)} ${cloudStatus}`}
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
