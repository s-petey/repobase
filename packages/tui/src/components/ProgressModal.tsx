import { TextAttributes } from "@opentui/core"
import type { AddRepoProgress } from "@repobase/engine"
import { colors } from "../theme/index.js"

interface ProgressModalProps {
  activeAdds: Record<string, AddRepoProgress>
}

const getLatestProgress = (adds: Record<string, AddRepoProgress>): AddRepoProgress | null => {
  const keys = Object.keys(adds)
  if (keys.length === 0) return null
  const latestKey = keys.sort().reverse()[0]
  return adds[latestKey]
}

/**
 * Creates a progress bar string using ASCII-safe characters
 * Uses characters that render correctly on all terminals
 */
const createProgressBar = (progress: number, width: number): string => {
  const filledWidth = Math.floor((progress / 100) * width)
  const emptyWidth = width - filledWidth
  
  // Use ASCII characters for universal terminal compatibility
  const filled = "=".repeat(filledWidth)
  const empty = "-".repeat(emptyWidth)
  
  return `[${filled}${empty}]`
}

/**
 * Get color based on stage
 */
const getStageColor = (stage: AddRepoProgress["stage"]): string => {
  switch (stage) {
    case "cloning":
      return colors.progress.cloning
    case "indexing":
      return colors.progress.indexing
    case "complete":
      return colors.progress.complete
    case "error":
      return colors.progress.error
    default:
      return colors.text.primary
  }
}

/**
 * Get stage icon - uses ASCII-safe characters for terminal compatibility
 */
const getStageIcon = (stage: AddRepoProgress["stage"]): string => {
  switch (stage) {
    case "cloning":
      return ">"
    case "indexing":
      return "*"
    case "complete":
      return "+"
    case "error":
      return "x"
    default:
      return "-"
  }
}

export const ProgressModal = ({ activeAdds }: ProgressModalProps) => {
  const progress = getLatestProgress(activeAdds)
  if (!progress) return null

  const barWidth = 40
  const progressBar = createProgressBar(progress.progress, barWidth)
  const stageColor = getStageColor(progress.stage)
  const stageIcon = getStageIcon(progress.stage)

  const activeCount = Object.keys(activeAdds).length
  const titleSuffix = activeCount > 1 ? ` (${activeCount} in progress)` : ""

  return (
    <box
      style={{
        position: "absolute",
        top: "30%",
        left: "10%",
        width: "80%",
        height: 10,
        backgroundColor: colors.bg.elevated,
        borderStyle: "double",
        borderColor: stageColor,
        border: true,
        flexDirection: "column",
        padding: 1,
      }}
    >
      <text
        content={`${stageIcon} Adding Repository${titleSuffix}`}
        style={{
          fg: stageColor,
          attributes: TextAttributes.BOLD,
          marginBottom: 1,
        }}
      />
      
      <text
        content={progress.message}
        style={{
          fg: colors.interactive.default,
          marginBottom: 1,
        }}
      />
      
      <box
        style={{
          flexDirection: "row",
          height: 1,
        }}
      >
        <text
          content={progressBar}
          style={{
            fg: stageColor,
          }}
        />
        <text
          content={` ${progress.progress}%`}
          style={{
            fg: colors.text.secondary,
            marginLeft: 1,
          }}
        />
      </box>
      
      {progress.filesIndexed !== undefined && (
        <text
          content={`Files indexed: ${progress.filesIndexed}`}
          style={{
            fg: colors.text.tertiary,
            marginTop: 1,
          }}
        />
      )}
      
      <text
        content={progress.stage === "complete" ? "[Enter] Continue" : progress.stage === "error" ? "[Esc] Dismiss" : "Please wait...  [Esc] Dismiss"}
        style={{
          fg: colors.text.tertiary,
          marginTop: 1,
        }}
      />
    </box>
  )
}
