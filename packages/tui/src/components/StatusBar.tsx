import { TextAttributes } from "@opentui/core"
import { colors } from "../theme/index.js"
import { featureFlags } from "../config.js"

interface StatusBarProps {
  mode: "list" | "add" | "syncing" | "search" | "results" | "adding" | "confirmDelete" | "jobs"
  message?: string
  mcpServerRunning?: boolean
  cloudConfigured?: boolean
  cloudPendingCount?: number
  grouped?: boolean
  jobCounts?: { readonly running: number; readonly failed: number }
}

export const StatusBar = ({ mode, message, mcpServerRunning, cloudConfigured, cloudPendingCount, grouped, jobCounts }: StatusBarProps) => {
  const getHelpText = () => {
    if (mode === "add" || mode === "search" || mode === "confirmDelete" || mode === "jobs") {
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

  const jobParts = [
    jobCounts && jobCounts.running > 0 ? `${jobCounts.running} running` : undefined,
    jobCounts && jobCounts.failed > 0 ? `${jobCounts.failed} failed` : undefined
  ].filter((part) => part !== undefined)
  const jobStatus = jobParts.length > 0 ? `Tasks: ${jobParts.join(", ")}` : undefined
  const jobColor = jobCounts && jobCounts.failed > 0 ? colors.status.error.default : colors.status.warning.default
  const cloudColor = !cloudConfigured 
    ? colors.text.secondary 
    : (cloudPendingCount && cloudPendingCount > 0) 
      ? colors.status.warning.default 
      : colors.status.success.default

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
        <text
          content={message || ""}
          style={{
            fg: getMessageColor(),
            attributes: message ? TextAttributes.BOLD : undefined,
          }}
        />
        {jobStatus && <text content={jobStatus} style={{ fg: jobColor }} />}
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
