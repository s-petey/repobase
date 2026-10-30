import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useState } from "react"
import { keyLabel, type ListAction, matchesKey } from "../actions.js"
import { fit } from "../layout.js"
import { colors } from "../theme/index.js"

export interface MenuLine {
  readonly text: string
  readonly color: string
}

interface ActionsMenuProps {
  title: string
  lines: ReadonlyArray<MenuLine>
  actions: ReadonlyArray<ListAction>
  onRun: (action: ListAction) => void
  onClose: () => void
}

const FILTER_KEY = "/"
const CLOSE_KEY = "q"
const MENU_KEYS = "[↑↓/jk] choose  [Enter] run  [/] filter  [q/Esc] close"
const MENU_WIDTH = 0.8
const MENU_CHROME = 4 // border and padding on each side

const isEnterOnly = (action: ListAction) =>
  action.key.names.some((name) => name === FILTER_KEY || name === CLOSE_KEY)

const matchesFilter = (action: ListAction, filter: string) =>
  `${action.label} ${action.description}`.toLowerCase().includes(filter.toLowerCase())

export const ActionsMenu = ({ title, lines, actions, onRun, onClose }: ActionsMenuProps) => {
  const { width } = useTerminalDimensions()
  const [filter, setFilter] = useState<string | undefined>()
  const [cursor, setCursor] = useState(0)

  const shown = filter === undefined ? actions : actions.filter((action) => matchesFilter(action, filter))
  const selected = Math.min(cursor, Math.max(0, shown.length - 1))
  const rowWidth = Math.floor(width * MENU_WIDTH) - MENU_CHROME
  const keyWidth = Math.max(...actions.map((action) => `[${keyLabel(action.key)}] ${action.label}`.length))

  const typeFilter = (next: string) => {
    setFilter(next)
    setCursor(0)
  }

  useKeyboard((key) => {
    if (key.name === "escape") {
      if (filter === undefined) return onClose()
      setFilter(undefined)
      return setCursor(0)
    }
    const moveUp = () => setCursor(Math.max(0, selected - 1))
    const moveDown = () => setCursor(Math.min(shown.length - 1, selected + 1))
    if (key.name === "up") return moveUp()
    if (key.name === "down") return moveDown()
    if (key.name === "return" || key.name === "enter") {
      const action = shown[selected]
      if (action) onRun(action)
      return
    }
    if (filter !== undefined) {
      if (key.name === "backspace") return typeFilter(filter.slice(0, -1))
      if (key.sequence.length === 1 && !key.ctrl && !key.meta) typeFilter(filter + key.sequence)
      return
    }
    if (key.name === "k") return moveUp()
    if (key.name === "j") return moveDown()
    if (key.name === CLOSE_KEY) return onClose()
    if (key.name === FILTER_KEY) return typeFilter("")
    const direct = actions.find((action) => !isEnterOnly(action) && matchesKey(action.key, key))
    if (direct) onRun(direct)
  })

  const firstGeneral = shown.findIndex((action) => action.scope === "general")

  return (
    <box
      style={{
        position: "absolute",
        top: 2,
        left: "10%",
        width: "80%",
        backgroundColor: colors.bg.elevated,
        borderStyle: "double",
        borderColor: colors.accent.default,
        border: true,
        flexDirection: "column",
        padding: 1,
      }}
    >
      <text content={title} style={{ fg: colors.accent.default, attributes: TextAttributes.BOLD }} />
      {lines.map((line) => (
        <text key={line.text} content={line.text} style={{ fg: line.color }} />
      ))}
      <box style={{ marginTop: 1, flexDirection: "column" }}>
        {filter !== undefined && <text content={`Filter: ${filter}▌`} style={{ fg: colors.text.primary }} />}
        {shown.length === 0 && <text content="No actions match" style={{ fg: colors.text.tertiary }} />}
        {shown.map((action, index) => {
          const isSelected = index === selected
          const row = `${isSelected ? "> " : "  "}${`[${keyLabel(action.key)}] ${action.label}`.padEnd(keyWidth)}  ${action.description}`
          return (
            <box key={`${keyLabel(action.key)}-${action.label}`} style={{ flexDirection: "column" }}>
              {index === firstGeneral && index > 0 && (
                <text content={"─".repeat(Math.max(0, rowWidth))} style={{ fg: colors.border.muted }} />
              )}
              <text
                content={fit(row, rowWidth).trimEnd()}
                style={{
                  fg: isEnterOnly(action) ? colors.status.info.default : colors.text.primary,
                  bg: isSelected ? colors.bg.selected : undefined,
                  attributes: isSelected ? TextAttributes.BOLD : undefined,
                }}
              />
            </box>
          )
        })}
      </box>
      <text content={MENU_KEYS} style={{ fg: colors.text.tertiary, marginTop: 1 }} />
    </box>
  )
}
