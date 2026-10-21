import { TextAttributes } from "@opentui/core"
import { colors } from "../theme/index.js"
import { featureFlags } from "../config.js"

interface StatusBarProps {
  mode: "list" | "add" | "syncing" | "search" | "results" | "adding" | "confirmDelete" | "confirmReindex" | "jobs"
  message?: string
  outdated?: number
  mcpServerRunning?: boolean
  cloudConfigured?: boolean
  cloudPendingCount?: number
  grouped?: boolean
  jobCounts?: { readonly running: number; readonly failed: number }
  activity?: string
}

export const StatusBar = ({ mode, message, outdated = 0, mcpServerRunning, cloudConfigured, cloudPendingCount, grouped, jobCounts, activity }: StatusBarProps) => {
  const getHelpText = () => {
    if (mode === "add" || mode === "search" || mode === "confirmDelete" || mode === "confirmReindex" || mode === "jobs") {
      return "" // Help text shown in modal
    }
    if (mode === "syncing" || mode === "adding") {
      return "Processing..."
    }
    if (mode === "results") {
      return "[Esc] Back"
    }
    const base = "[a] Add  [d] Delete  [s] Sync  [S] Sync All  [/] Search  [t] Tasks  [c] Copy MCP Config  [q] Quit"
    if (grouped) {
      return `[Enter] Toggle group  ${base}`
    }
    return base
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

  // Each count in its own colour, so running tasks don't look like failures
  const jobParts = [
    jobCounts && jobCounts.running > 0
      ? { text: `${jobCounts.running} running`, color: colors.status.warning.default }
      : undefined,
    jobCounts && jobCounts.failed > 0
      ? { text: `${jobCounts.failed} failed`, color: colors.status.error.default }
      : undefined
  ].filter((part) => part !== undefined)
  const cloudColor = !cloudConfigured
    ? colors.text.secondary
    : (cloudPendingCount && cloudPendingCount > 0)
      ? colors.status.warning.default
      : colors.status.success.default

  return (
    <box
      style={{
        paddingLeft: 1,
        paddingRight: 1,
        borderStyle: "single",
        borderColor: colors.border.default,
        border: true,
        flexDirection: "column",
        flexShrink: 0,
      }}
    >
      <text
        content={message || ""}
        style={{
          fg: getMessageColor(),
          attributes: message ? TextAttributes.BOLD : undefined,
        }}
      />
      {outdated > 0 && (
        <text
          content={`${outdated === 1 ? "1 repo isn't" : `${outdated} repos aren't`} searchable until re-indexed · [r] Re-index  [R] All`}
          style={{ fg: colors.status.warning.default }}
        />
      )}
      {activity && <text content={activity} style={{ fg: colors.status.info.default }} />}
      {jobParts.length > 0 && (
        <box style={{ flexDirection: "row" }}>
          <text content="Tasks: " style={{ fg: colors.text.secondary }} />
          {jobParts.map((part, index) => (
            <box key={part.text} style={{ flexDirection: "row" }}>
              {index > 0 && <text content=", " style={{ fg: colors.text.secondary }} />}
              <text content={part.text} style={{ fg: part.color }} />
            </box>
          ))}
        </box>
      )}
      {(featureFlags.mcpServerToggle || featureFlags.cloudSync) && (
        <box style={{ flexDirection: "row", gap: 2 }}>
          {featureFlags.mcpServerToggle && <text content={mcpStatus} style={{ fg: mcpColor }} />}
          {featureFlags.cloudSync && <text content={cloudStatus} style={{ fg: cloudColor }} />}
        </box>
      )}
      <text content={helpText} style={{ fg: colors.text.secondary }} />
    </box>
  )
}
