import { TextAttributes } from "@opentui/core"
import type { AddRepoProgress } from "@repobase/engine"
import { colors } from "../theme/index.js"
import { featureFlags } from "../config.js"

const createMiniProgressBar = (progress: number, width: number): string => {
  const filledWidth = Math.round((progress / 100) * width)
  const emptyWidth = width - filledWidth
  return `[${"=".repeat(filledWidth)}${"-".repeat(emptyWidth)}]`
}

interface StatusBarProps {
  mode: "list" | "add" | "syncing" | "search" | "results" | "adding" | "confirmDelete" | "status"
  message?: string
  activeAdds?: Record<string, AddRepoProgress>
  completedAddCount?: number
  mcpServerRunning?: boolean
  cloudConfigured?: boolean
  cloudPendingCount?: number
}

export const StatusBar = ({ mode, message, activeAdds, completedAddCount, mcpServerRunning, cloudConfigured, cloudPendingCount }: StatusBarProps) => {
  const getHelpText = () => {
    if (mode === "add" || mode === "search" || mode === "confirmDelete") {
      return "" // Help text shown in modal
    }
    if (mode === "results") {
      return "[Esc] Back"
    }
    return "[?] Status  [a] Add  [d] Delete  [s] Sync  [S] Sync All  [/] Search  [c] Copy MCP Config  [q] Quit"
  }

  const getMessageColor = () => {
    if (!message) return colors.text.secondary
    if (message.startsWith("Error")) return colors.status.error.default
    if (message.startsWith("[OK]")) return colors.status.success.default
    return colors.status.warning.default
  }

  const helpText = getHelpText()

  // MCP server status (only shown if feature flag enabled)
  const mcpStatus = mcpServerRunning ? "MCP: *" : "MCP: o"
  const mcpColor = mcpServerRunning ? colors.status.success.default : colors.text.secondary

  // Cloud sync status (only shown if feature flag enabled)
  const getCloudStatus = () => {
    if (!cloudConfigured) return "Cloud: o"
    if (cloudPendingCount && cloudPendingCount > 0) return `Cloud: ${cloudPendingCount}^`
    return "Cloud: ok"
  }
  const cloudStatus = getCloudStatus()
  const cloudColor = !cloudConfigured
    ? colors.text.secondary
    : (cloudPendingCount && cloudPendingCount > 0)
      ? colors.status.warning.default
      : colors.status.success.default

  const activeEntries = activeAdds ? Object.values(activeAdds) : []
  const activeCount = activeEntries.length
  const totalCount = activeCount + (completedAddCount || 0)
  const getActiveAddsText = (): string | null => {
    if (activeCount === 0 && !completedAddCount) return null
    if (activeCount === 1) {
      const p = activeEntries[0]
      const bar = createMiniProgressBar(p.progress, 10)
      return `> Adding: ${p.message} ${bar} ${p.progress}%`
    }
    return `Adding repos: ${completedAddCount || 0} of ${totalCount} complete`
  }
  const activeAddsText = getActiveAddsText()

  return (
    <box
      style={{
        padding: 1,
        borderStyle: "single",
        borderColor: colors.border.default,
        border: true,
        flexDirection: "row",
        justifyContent: "space-between",
        height: 3,
      }}
    >
      <box style={{ flexDirection: "row", gap: 2 }}>
        {activeAddsText && !message ? (
          <text
            content={activeAddsText}
            style={{
              fg: colors.progress.cloning,
              attributes: TextAttributes.BOLD,
            }}
          />
        ) : null}
        <text
          content={message || ""}
          style={{
            fg: getMessageColor(),
            attributes: message ? TextAttributes.BOLD : undefined,
          }}
        />
        {featureFlags.mcpServerToggle && (
          <text
            content={mcpStatus}
            style={{
              fg: mcpColor,
            }}
          />
        )}
        {featureFlags.cloudSync && (
          <text
            content={cloudStatus}
            style={{
              fg: cloudColor,
            }}
          />
        )}
      </box>
      <text
        content={helpText}
        style={{
          fg: colors.text.secondary,
        }}
      />
    </box>
  )
}
