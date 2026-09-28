import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import type { Job, StepStatus } from "@repobase/engine"
import { DateTime } from "effect"
import { useEffect, useRef, useState } from "react"
import { formatAge, kindLabel, retryState, stepIcon, stepLines } from "../jobView.js"
import { colors } from "../theme/index.js"

interface TasksViewProps {
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

const rowId = (index: number) => `task-${index}`

// The list takes 40% of the width (at least 40 columns); each row is the
// selection marker, then the repo, status and age columns
const listWidth = (terminalWidth: number) => Math.max(40, Math.floor(terminalWidth * 0.4))
const MARKER_WIDTH = 2
const STATUS_WIDTH = 11 // "interrupted"
const AGE_WIDTH = 7 // "59m ago"
const SCROLLBAR_WIDTH = 1
const DETAIL_PAGE = 10

const fit = (text: string, width: number) =>
  text.length <= width ? text.padEnd(width) : `${text.slice(0, Math.max(0, width - 1))}…`

export const TasksView = ({ jobs, now, onRetry, onDiscard, onClose }: TasksViewProps) => {
  const { width } = useTerminalDimensions()
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [notice, setNotice] = useState<string | undefined>()
  const listRef = useRef<ScrollBoxRenderable | null>(null)
  const detailRef = useRef<ScrollBoxRenderable | null>(null)

  const leftWidth = listWidth(width)
  const repoWidth = Math.max(8, leftWidth - MARKER_WIDTH - 1 - STATUS_WIDTH - 1 - AGE_WIDTH - SCROLLBAR_WIDTH)

  useEffect(() => {
    const max = Math.max(0, jobs.length - 1)
    if (selectedIndex > max) setSelectedIndex(max)
  }, [jobs.length, selectedIndex])

  useEffect(() => {
    listRef.current?.scrollChildIntoView(rowId(selectedIndex))
    detailRef.current?.scrollTo(0)
  }, [selectedIndex])

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
      case "pageup":
        detailRef.current?.scrollBy(-DETAIL_PAGE)
        break
      case "pagedown":
        detailRef.current?.scrollBy(DETAIL_PAGE)
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
    <box style={{ flexGrow: 1, flexDirection: "column", padding: 1 }}>
      {/* Header */}
      <box style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 1 }}>
        <text content="Tasks" style={{ fg: colors.accent.default, attributes: TextAttributes.BOLD }} />
        <text content={`${jobs.length} task${jobs.length !== 1 ? "s" : ""}`} style={{ fg: colors.text.secondary }} />
      </box>

      {jobs.length === 0 ? (
        <box style={{ flexGrow: 1, justifyContent: "center", alignItems: "center" }}>
          <text content="No tasks yet." style={{ fg: colors.text.secondary }} />
          <text content="Adding or syncing a repository starts one." style={{ fg: colors.text.tertiary, marginTop: 1 }} />
        </box>
      ) : (
        <box style={{ flexGrow: 1, flexDirection: "row", gap: 1 }}>
          {/* Not focused: the effect above scrolls the selection into view */}
          <scrollbox ref={listRef} style={{ width: leftWidth, flexShrink: 0 }}>
            {jobs.map((job, index) => {
              const isSelected = index === selectedIndex
              return (
                <box
                  id={rowId(index)}
                  key={job.id}
                  style={{ flexDirection: "row", backgroundColor: isSelected ? colors.accent.muted : undefined }}
                >
                  <text
                    content={`${isSelected ? "> " : "  "}${fit(job.repoId, repoWidth)} `}
                    style={{
                      fg: isSelected ? colors.text.primary : colors.interactive.default,
                      attributes: isSelected ? TextAttributes.BOLD : undefined,
                    }}
                  />
                  <text content={`${fit(job.status, STATUS_WIDTH)} `} style={{ fg: statusColor(job.status) }} />
                  <text content={formatAge(job.updatedAt, now).padStart(AGE_WIDTH)} style={{ fg: colors.text.tertiary }} />
                </box>
              )
            })}
          </scrollbox>

          {/* The selected task: its steps, with each failure's full error */}
          {selected && (
            <box
              style={{
                flexGrow: 1,
                flexDirection: "column",
                borderStyle: "single",
                borderColor: colors.border.muted,
                border: true,
                paddingLeft: 1,
                paddingRight: 1,
              }}
            >
              <text
                content={`${kindLabel[selected.kind]} ${selected.repoId} · ${selected.status}`}
                style={{ fg: statusColor(selected.status), attributes: TextAttributes.BOLD, marginBottom: 1 }}
              />
              <scrollbox ref={detailRef} style={{ flexGrow: 1 }}>
                {stepLines(selected).map((line) => (
                  <box key={line.key} style={{ flexDirection: "column" }}>
                    <text content={`${stepIcon[line.status]} ${line.label}`} style={{ fg: statusColor(line.status) }} />
                    {line.error && (
                      <box style={{ flexDirection: "column", paddingLeft: 2, marginBottom: 1 }}>
                        <text content={line.error.title} style={{ fg: colors.status.error.default }} />
                        <text content={line.error.detail} style={{ fg: colors.text.secondary }} />
                        {line.error.hint && (
                          <text content={`Hint: ${line.error.hint}`} style={{ fg: colors.text.tertiary }} />
                        )}
                      </box>
                    )}
                  </box>
                ))}
              </scrollbox>
            </box>
          )}
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

      {/* Footer help */}
      <box
        style={{
          borderStyle: "single",
          borderColor: colors.border.muted,
          border: true,
          padding: 0,
          marginTop: 1,
          height: 3,
          flexShrink: 0,
        }}
      >
        <text
          content={`${retry?.canRetry ? "[r] Retry" : "[r] Retry (unavailable)"}  [x] Discard  [Up/k] [Down/j] Select  [PgUp/PgDn] Scroll details  [Esc/q] Back`}
          style={{ fg: colors.text.tertiary }}
        />
      </box>
    </box>
  )
}
