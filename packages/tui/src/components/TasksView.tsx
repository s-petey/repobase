import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import {
  kindLabel,
  retryState,
  runningElsewhere,
  stepIcon,
  stepLines,
  superseded,
  type FileProgress,
  type Job,
  type StepErrorDisplay,
  type StepLine,
  type StepStatus
} from "@repobase/engine"
import { DateTime } from "effect"
import { useEffect, useRef, useState } from "react"
import { formatAge } from "../jobView.js"
import { colors } from "../theme/index.js"
import { KeyHints } from "./KeyHints.js"

interface TasksViewProps {
  jobs: ReadonlyArray<Job>
  onProgressChange?: (listener: (progress: ReadonlyMap<string, FileProgress>) => void) => () => void
  now?: DateTime.Utc
  onRetry: (jobId: string) => Promise<void>
  onDiscard: (jobId: string) => Promise<void>
  onClose: () => void
}

type JobStatusShown = Job["status"] | "superseded"

const shownStatus = (job: Job): JobStatusShown => (superseded(job) ? "superseded" : job.status)

const statusColor = (status: StepStatus | JobStatusShown): string => {
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
const lineId = (key: string) => `line-${key}`

// The list takes 40% of the width (at least 40 columns); each row is the
// selection marker, then the repo, status and age columns
const listWidth = (terminalWidth: number) => Math.max(40, Math.floor(terminalWidth * 0.4))
const NARROW_WIDTH = 80
const PAGE_PADDING = 1
const AGE_TICK_MS = 30_000
const MARKER_WIDTH = 2
const STATUS_WIDTH = 11 // "interrupted"
const MIN_AGE_WIDTH = 7 // "59m ago"
const SCROLLBAR_WIDTH = 1
const BORDER_WIDTH = 2
const DETAIL_PAGE = 10

const TASKS = 0
const STEPS = 1
const DETAILS = 2
const BATCH_ERROR = 3

const fit = (text: string, width: number) =>
  text.length <= width ? text.padEnd(width) : `${text.slice(0, Math.max(0, width - 1))}…`

const useClock = (fixed: DateTime.Utc | undefined) => {
  const [ticking, setTicking] = useState(() => DateTime.nowUnsafe())
  useEffect(() => {
    if (fixed) return
    const timer = setInterval(() => setTicking(DateTime.nowUnsafe()), AGE_TICK_MS)
    return () => clearInterval(timer)
  }, [fixed])
  return fixed ?? ticking
}

const cursorIndex = (lines: ReadonlyArray<StepLine>, key: string | undefined) =>
  Math.max(0, lines.findIndex((line) => line.key === key))

const LineRow = ({ line, isCursor }: { line: StepLine; isCursor: boolean }) => (
  <box
    id={lineId(line.key)}
    style={{ flexDirection: "column", backgroundColor: isCursor ? colors.accent.muted : undefined }}
  >
    <box style={{ flexDirection: "row" }}>
      <text
        content={`${isCursor ? "> " : "  "}${stepIcon[line.status]} ${line.label}`}
        style={{ fg: statusColor(line.status), attributes: isCursor ? TextAttributes.BOLD : undefined }}
      />
      {(line.error || (line.children?.length ?? 0) > 0) && (
        <text content=" ›" style={{ fg: colors.text.tertiary }} />
      )}
    </box>
    {line.error && <text content={`    ${line.error.title}`} style={{ fg: colors.status.error.default }} />}
  </box>
)

function getDeepestLevel(
  selected: Job | undefined,
  step: StepLine | undefined,
  batches: ReadonlyArray<StepLine>,
  batch: StepLine | undefined
) {
  if (!selected) {
    return TASKS
  }

  if (batches.length > 0) {
    return batch?.error ? BATCH_ERROR : DETAILS
  }

  return step?.error ? DETAILS : STEPS
}

function getLevelKeysText(level: number, shownError: boolean, showingBatches: boolean, canOpen: boolean) {
  if (level === TASKS) {
    return "[j/k] Select  [l] Steps"
  }

  if (shownError) {
    return "[j/k] Scroll  [g/G] Top/Bottom  [PgUp/PgDn] Page  [h] Back"
  }

  if (showingBatches) {
    return `[j/k] Batch  ${canOpen ? "[l] Error  " : ""}[h] Steps`
  }

  return `[j/k] Step  ${canOpen ? "[l] Details  " : ""}[h] Tasks`
}

export const TasksView = ({ jobs, onProgressChange, now: fixedNow, onRetry, onDiscard, onClose }: TasksViewProps) => {
  const { width } = useTerminalDimensions()
  const now = useClock(fixedNow)
  const narrow = width < NARROW_WIDTH
  const [selection, setSelection] = useState(() => ({ id: jobs[0]?.id, index: 0 }))
  const [levelState, setLevel] = useState(TASKS)
  const [stepKey, setStepKey] = useState<string | undefined>()
  const [batchKey, setBatchKey] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  const [progress, setProgress] = useState<ReadonlyMap<string, FileProgress>>(new Map())
  useEffect(() => onProgressChange?.(setProgress), [onProgressChange])
  const listRef = useRef<ScrollBoxRenderable | null>(null)
  const detailRef = useRef<ScrollBoxRenderable | null>(null)
  const errorRef = useRef<ScrollBoxRenderable | null>(null)

  const ages = jobs.map((job) => formatAge(job.updatedAt, now))
  const ageWidth = Math.max(MIN_AGE_WIDTH, ...ages.map((age) => age.length))
  const leftWidth = narrow ? width - 2 * PAGE_PADDING : listWidth(width)
  const repoWidth = Math.max(
    8,
    leftWidth - BORDER_WIDTH - MARKER_WIDTH - 1 - STATUS_WIDTH - 1 - ageWidth - SCROLLBAR_WIDTH
  )

  const lastIndex = Math.max(0, jobs.length - 1)
  const foundIndex = jobs.findIndex((job) => job.id === selection.id)
  const selectedIndex = foundIndex >= 0 ? foundIndex : Math.min(selection.index, lastIndex)
  const selected = jobs[selectedIndex]

  if (selected && (selected.id !== selection.id || selectedIndex !== selection.index)) {
    setSelection({ id: selected.id, index: selectedIndex })
  }

  const retry = selected ? retryState(selected) : undefined
  const live = selected?.status === "running" ? progress.get(selected.id) : undefined

  const steps = selected ? stepLines(selected) : []
  const stepIndex = cursorIndex(steps, stepKey)
  const step = steps[stepIndex]
  const batches = step?.children ?? []
  const batchIndex =
    batchKey === undefined
      ? Math.max(0, batches.findIndex((b) => b.status === "failed" || b.status === "interrupted"))
      : cursorIndex(batches, batchKey)
  const batchTotal = selected?.steps.filter((s) => s.key !== s.name && s.name === "indexBatch").length ?? 0
  const batch = batches[batchIndex]

  const deepestLevel = getDeepestLevel(selected, step, batches, batch)
  const level = Math.min(levelState, deepestLevel)

  const shownError: StepErrorDisplay | undefined =
    level === BATCH_ERROR ? batch?.error : level === DETAILS && batches.length === 0 ? step?.error : undefined
  const showingBatches = level === DETAILS && batches.length > 0

  useEffect(() => {
    listRef.current?.scrollChildIntoView(rowId(selectedIndex))
    detailRef.current?.scrollTo(0)
  }, [selectedIndex])

  useEffect(() => {
    const key = showingBatches ? batch?.key : level === STEPS ? step?.key : undefined
    if (key) detailRef.current?.scrollChildIntoView(lineId(key))
  }, [level, showingBatches, step?.key, batch?.key])

  const run = async (action: (jobId: string) => Promise<void>, jobId: string) => {
    setNotice(undefined)
    try {
      await action(jobId)
    } catch (error) {
      setNotice(`Error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const selectTask = (index: number) => {
    setSelection({ id: jobs[index]?.id, index })
    setStepKey(undefined)
    setBatchKey(undefined)
  }

  const moveCursor = (to: (index: number, last: number) => number) => {
    if (level === TASKS) return selectTask(to(selectedIndex, lastIndex))
    if (level === STEPS) {
      setBatchKey(undefined)
      return setStepKey(steps[to(stepIndex, steps.length - 1)]?.key)
    }
    if (showingBatches) return setBatchKey(batches[to(batchIndex, batches.length - 1)]?.key)
  }

  const scrollTarget = () => (shownError ? errorRef.current : detailRef.current)

  useKeyboard((key) => {
    switch (key.name) {
      case "escape":
      case "q":
        onClose()
        break
      case "left":
      case "h":
        setLevel(Math.max(TASKS, level - 1))
        break
      case "right":
      case "l":
        setLevel(Math.min(deepestLevel, level + 1))
        break
      case "up":
      case "k":
        if (shownError) errorRef.current?.scrollBy(-1)
        else moveCursor((i) => Math.max(0, i - 1))
        break
      case "down":
      case "j":
        if (shownError) errorRef.current?.scrollBy(1)
        else moveCursor((i, last) => Math.min(last, i + 1))
        break
      case "g":
        if (shownError) errorRef.current?.scrollTo(key.shift ? errorRef.current.scrollHeight : 0)
        else moveCursor((_, last) => (key.shift ? last : 0))
        break
      case "pageup":
        scrollTarget()?.scrollBy(-DETAIL_PAGE)
        break
      case "pagedown":
        scrollTarget()?.scrollBy(DETAIL_PAGE)
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

  const canOpen = deepestLevel > level
  const levelKeys = getLevelKeysText(
    level,
    shownError !== undefined,
    showingBatches,
    canOpen,
  )

  return (
    <box style={{ flexGrow: 1, flexDirection: "column", padding: PAGE_PADDING }}>
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
          <scrollbox
            ref={listRef}
            visible={!narrow || level === TASKS}
            style={{
              width: leftWidth,
              flexShrink: 0,
              border: true,
              borderStyle: "single",
              borderColor: level === TASKS ? colors.status.info.default : colors.border.muted,
            }}
          >
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
                  <text content={`${fit(shownStatus(job), STATUS_WIDTH)} `} style={{ fg: statusColor(shownStatus(job)) }} />
                  <text content={ages[index].padStart(ageWidth)} style={{ fg: colors.text.tertiary }} />
                </box>
              )
            })}
          </scrollbox>

          {selected && (!narrow || level > TASKS) && (
            <box
              style={{
                flexGrow: 1,
                flexDirection: "column",
                borderStyle: "single",
                borderColor: level > TASKS ? colors.status.info.default : colors.border.muted,
                border: true,
                paddingLeft: 1,
                paddingRight: 1,
              }}
            >
              <text
                content={`${kindLabel[selected.kind]} ${selected.repoId} · ${shownStatus(selected)}${runningElsewhere(selected) ? ` in ${selected.owner?.name}` : ""}`}
                style={{ fg: statusColor(shownStatus(selected)), attributes: TextAttributes.BOLD, marginBottom: 1 }}
              />
              {live && (
                <box style={{ flexDirection: "column", marginBottom: 1, flexShrink: 0 }}>
                  <text
                    content={`Indexing ${live.filesStarted.toLocaleString()} / ${live.totalFiles.toLocaleString()} files`}
                    style={{ fg: colors.status.info.default }}
                  />
                  {[...live.batches]
                    .sort(([a], [b]) => a - b)
                    .map(([batchNumber, path]) => (
                      <text
                        key={batchNumber}
                        content={`  ${`batch ${batchNumber + 1}/${batchTotal}`.padEnd(14)} ${path}`}
                        style={{ fg: colors.text.secondary }}
                      />
                    ))}
                </box>
              )}

              {level >= DETAILS && step && (
                <text
                  content={[step.label, level === BATCH_ERROR ? batch?.label : undefined].filter(Boolean).join(" › ")}
                  style={{ fg: colors.text.secondary, marginBottom: 1, flexShrink: 0 }}
                />
              )}

              {shownError ? (
                <scrollbox ref={errorRef} style={{ flexGrow: 1 }}>
                  <text content={shownError.title} style={{ fg: colors.status.error.default, marginBottom: 1 }} />
                  <text content={shownError.detail} style={{ fg: colors.text.secondary }} />
                  {shownError.hint && (
                    <text content={`Hint: ${shownError.hint}`} style={{ fg: colors.text.tertiary, marginTop: 1 }} />
                  )}
                </scrollbox>
              ) : (
                <scrollbox ref={detailRef} style={{ flexGrow: 1 }}>
                  {showingBatches ? (
                    // The rows have no position until laid out, so the initial scroll waits for that
                    <box
                      key="batches"
                      style={{ flexDirection: "column" }}
                      onSizeChange={() => batch && detailRef.current?.scrollChildIntoView(lineId(batch.key))}
                    >
                      {batches.map((line, index) => (
                        <LineRow key={line.key} line={line} isCursor={index === batchIndex} />
                      ))}
                    </box>
                  ) : (
                    steps.map((line, index) => (
                      <LineRow key={line.key} line={line} isCursor={level === STEPS && index === stepIndex} />
                    ))
                  )}
                </scrollbox>
              )}
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

      <box
        style={{
          borderStyle: "single",
          borderColor: colors.border.muted,
          border: true,
          padding: 0,
          marginTop: 1,
          flexShrink: 0,
        }}
      >
        <KeyHints
          text={`${retry?.canRetry ? "[r] Retry" : "[r] Retry (unavailable)"}  [x] Discard  ${levelKeys}  [Esc/q] Close`}
          color={colors.text.tertiary}
        />
      </box>
    </box>
  )
}
