import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import type { Job, StepStatus } from "@repobase/engine"
import { DateTime } from "effect"
import { useEffect, useState } from "react"
import { formatAge, kindLabel, retryState, stepIcon, stepLines } from "../jobView.js"
import { colors } from "../theme/index.js"

interface JobsModalProps {
  jobs: ReadonlyArray<Job>
  now: DateTime.Utc
  onRetry: (jobId: string) => Promise<void>
  onDiscard: (jobId: string) => Promise<void>
  onClose: () => void
}

const statusColor = (status: StepStatus | Job["status"]): string => {
  switch (status) {
    case "done":
    case "completed":
      return colors.status.success.default
    case "failed":
    case "interrupted":
      return colors.status.error.default
    case "running":
      return colors.status.warning.default
    default:
      return colors.text.secondary
  }
}

export const JobsModal = ({ jobs, now, onRetry, onDiscard, onClose }: JobsModalProps) => {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [notice, setNotice] = useState<string | undefined>()

  useEffect(() => {
    const max = Math.max(0, jobs.length - 1)
    if (selectedIndex > max) setSelectedIndex(max)
  }, [jobs.length, selectedIndex])

  const selected = jobs[selectedIndex]
  const retry = selected ? retryState(selected) : undefined

  const run = async (action: (jobId: string) => Promise<void>, jobId: string) => {
    setNotice(undefined)
    try {
      await action(jobId)
    } catch (error) {
      setNotice(`Error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  useKeyboard((key) => {
    switch (key.name) {
      case "escape":
      case "q":
        onClose()
        break
      case "up":
      case "k":
        setSelectedIndex((i) => Math.max(0, i - 1))
        break
      case "down":
      case "j":
        setSelectedIndex((i) => Math.min(Math.max(0, jobs.length - 1), i + 1))
        break
      case "r":
        if (!selected || !retry) break
        if (retry.canRetry) void run(onRetry, selected.id)
        else setNotice(retry.reason)
        break
      case "x":
        if (selected) void run(onDiscard, selected.id)
        break
    }
  })

  return (
    <box
      style={{
        position: "absolute",
        top: "10%",
        left: "5%",
        width: "90%",
        height: "80%",
        backgroundColor: colors.bg.elevated,
        borderStyle: "double",
        borderColor: colors.accent.default,
        border: true,
        flexDirection: "column",
        padding: 1,
      }}
    >
      <text
        content={`Tasks (${jobs.length})`}
        style={{ fg: colors.accent.default, attributes: TextAttributes.BOLD, marginBottom: 1 }}
      />

      {jobs.length === 0 && <text content="No tasks yet." style={{ fg: colors.text.secondary }} />}

      {jobs.map((job, index) => {
        const isSelected = index === selectedIndex
        return (
          <text
            key={job.id}
            content={`${isSelected ? "> " : "  "}${kindLabel[job.kind].padEnd(5)} ${job.repoId.padEnd(32)} ${job.status.padEnd(12)} ${formatAge(job.updatedAt, now)}`}
            style={{
              fg: isSelected ? colors.text.primary : statusColor(job.status),
              attributes: isSelected ? TextAttributes.BOLD : undefined,
            }}
          />
        )
      })}

      {selected && (
        <box style={{ flexDirection: "column", marginTop: 1 }}>
          {stepLines(selected).map((line) => (
            <box key={line.key} style={{ flexDirection: "column" }}>
              <text content={`  ${stepIcon[line.status]} ${line.label}`} style={{ fg: statusColor(line.status) }} />
              {line.error && (
                <>
                  <text content={`      ${line.error.title}`} style={{ fg: colors.status.error.default }} />
                  <text content={`      ${line.error.detail}`} style={{ fg: colors.text.secondary }} />
                  {line.error.hint && (
                    <text content={`      Hint: ${line.error.hint}`} style={{ fg: colors.text.tertiary }} />
                  )}
                </>
              )}
            </box>
          ))}
        </box>
      )}

      {notice && (
        <text
          content={notice}
          style={{
            fg: notice.startsWith("Error") ? colors.status.error.default : colors.status.warning.default,
            marginTop: 1,
          }}
        />
      )}

      <text
        content={`${retry?.canRetry ? "[r] Retry" : "[r] Retry (unavailable)"}  [x] Discard  [j/k] Select  [Esc/q] Close`}
        style={{ fg: colors.text.tertiary, marginTop: 1 }}
      />
    </box>
  )
}
