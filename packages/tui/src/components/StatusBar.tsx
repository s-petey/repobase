import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import { workersText } from "../jobView.js"
import { fit, isNarrow } from "../layout.js"
import { colors } from "../theme/index.js"
import { featureFlags } from "../config.js"
import { KeyHints } from "./KeyHints.js"

interface StatusBarProps {
  mode: "list" | "add" | "syncing" | "search" | "results" | "adding" | "confirmDelete" | "confirmReindex" | "jobs" | "actions"
  message?: string
  outdated?: number
  mcpServerRunning?: boolean
  cloudConfigured?: boolean
  cloudPendingCount?: number
  grouped?: boolean
  jobCounts?: { readonly running: number; readonly failed: number }
  activity?: string
  workerLimit?: number
}

const BAR_CHROME = 4 // border and padding on each side
const SEPARATOR = " · "
const TASKS_LABEL = "Tasks: "

export const StatusBar = ({ mode, message, outdated = 0, mcpServerRunning, cloudConfigured, cloudPendingCount, grouped, jobCounts, activity, workerLimit }: StatusBarProps) => {
  const { width } = useTerminalDimensions()
  const narrow = isNarrow(width)
  const getHelpText = () => {
    if (mode === "add" || mode === "search" || mode === "confirmDelete" || mode === "confirmReindex" || mode === "jobs" || mode === "actions") {
      return "" // Help text shown in modal
    }
    if (mode === "syncing" || mode === "adding") {
      return "Processing..."
    }
    if (mode === "results") {
      return "[Esc] Back"
    }
    if (narrow) return "[a]dd  [s]ync  [/]search  [t]asks  [q]uit  [?] all keys"
    const base = "[a] Add  [d] Delete  [s] Sync  [S] Sync All  [/] Search  [t] Tasks  [c] Copy MCP Config  [q] Quit  [?] Keys"
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

  const outdatedText = narrow
    ? `! ${outdated} ${outdated === 1 ? "repo needs" : "repos need"} re-indexing · [r] [R] all`
    : `${outdated === 1 ? "1 repo isn't" : `${outdated} repos aren't`} searchable until re-indexed · [r] Re-index  [R] All`

  const countsText = jobParts.map((part) => part.text).join(", ")
  const activityWidth =
    width - BAR_CHROME - (countsText ? SEPARATOR.length + TASKS_LABEL.length + countsText.length : 0)
  const wideActivity = activity && workerLimit !== undefined ? `${activity}${SEPARATOR}${workersText(workerLimit)}` : activity
  const counts = (
    <box style={{ flexDirection: "row" }}>
      <text content={TASKS_LABEL} style={{ fg: colors.text.secondary }} />
      {jobParts.map((part, index) => (
        <box key={part.text} style={{ flexDirection: "row" }}>
          {index > 0 && <text content=", " style={{ fg: colors.text.secondary }} />}
          <text content={part.text} style={{ fg: part.color }} />
        </box>
      ))}
    </box>
  )

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
      {outdated > 0 && <text content={outdatedText} style={{ fg: colors.status.warning.default }} />}
      {narrow ? (
        (activity || jobParts.length > 0) && (
          <box style={{ flexDirection: "row" }}>
            {activity && (
              <text content={fit(activity, activityWidth).trimEnd()} style={{ fg: colors.status.info.default }} />
            )}
            {activity && jobParts.length > 0 && <text content={SEPARATOR} style={{ fg: colors.text.secondary }} />}
            {jobParts.length > 0 && counts}
          </box>
        )
      ) : (
        <>
          {wideActivity && <text content={wideActivity} style={{ fg: colors.status.info.default }} />}
          {jobParts.length > 0 && counts}
        </>
      )}
      {(featureFlags.mcpServerToggle || featureFlags.cloudSync) && (
        <box style={{ flexDirection: "row", gap: 2 }}>
          {featureFlags.mcpServerToggle && <text content={mcpStatus} style={{ fg: mcpColor }} />}
          {featureFlags.cloudSync && <text content={cloudStatus} style={{ fg: cloudColor }} />}
        </box>
      )}
      <KeyHints text={helpText} />
    </box>
  )
}
