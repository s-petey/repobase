import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import { useState } from "react"
import type { SearchMode } from "@repobase/engine"
import type { SearchFilter } from "../searchView.js"
import { colors } from "../theme/index.js"

interface SearchModalProps {
  onSubmit: (query: string, mode: SearchMode, filter: SearchFilter | undefined) => void
  onCancel: () => void
  onInput: (value: string) => void
  value: string
  initialMode?: SearchMode
  initialFilter?: SearchFilter
}

const SEARCH_MODES: { mode: SearchMode; label: string; description: string }[] = [
  { mode: "keyword", label: "Keyword", description: "Full-text search (BM25)" },
  { mode: "semantic", label: "Semantic", description: "AI-powered meaning search" },
  { mode: "hybrid", label: "Hybrid", description: "Combined keyword + semantic" },
]

const FILTER_KINDS: { kind: SearchFilter["kind"]; label: string; placeholder: string }[] = [
  { kind: "path", label: "Path", placeholder: "Part of a path, e.g. editor or src/components" },
  { kind: "glob", label: "Glob", placeholder: "A glob, e.g. crates/*/src/**/*.rs or *.md" },
]

// Tab moves through these in order
const FOCUS_ORDER = ["query", "filter", "filterKind", "mode"] as const
type Focus = (typeof FOCUS_ORDER)[number]

// Paste is handled natively by the focused <input> (opentui >= 0.5)
export const SearchModal = ({
  onSubmit,
  onCancel,
  onInput,
  value,
  initialMode = "hybrid",
  initialFilter,
}: SearchModalProps) => {
  const [selectedModeIndex, setSelectedModeIndex] = useState(() =>
    Math.max(0, SEARCH_MODES.findIndex((m) => m.mode === initialMode))
  )
  const [filterKindIndex, setFilterKindIndex] = useState(() =>
    Math.max(0, FILTER_KINDS.findIndex((k) => k.kind === initialFilter?.kind))
  )
  const [focus, setFocus] = useState<Focus>("query")
  // The inputs' starting text (e.g. the last search when reopened from results);
  // captured once, so re-renders while typing don't reset them
  const [initialValue] = useState(value)
  const [startFilterText] = useState(initialFilter?.text ?? "")
  const [query, setQuery] = useState(value)
  const [filterText, setFilterText] = useState(initialFilter?.text ?? "")

  const handleQueryInput = (text: string) => {
    setQuery(text)
    onInput(text)
  }

  const submit = () => {
    if (!query.trim()) return
    const text = filterText.trim()
    const filter = text ? { kind: FILTER_KINDS[filterKindIndex].kind, text } : undefined
    onSubmit(query, SEARCH_MODES[selectedModeIndex].mode, filter)
  }

  // h/l and the arrows move along a row of options
  const step = (key: string, index: number, count: number): number => {
    if (key === "left" || key === "h") return Math.max(0, index - 1)
    if (key === "right" || key === "l") return Math.min(count - 1, index + 1)
    return index
  }

  useKeyboard((key) => {
    if (key.name === "escape") {
      onCancel()
      return
    }

    if (key.name === "tab") {
      setFocus(FOCUS_ORDER[(FOCUS_ORDER.indexOf(focus) + 1) % FOCUS_ORDER.length])
      return
    }

    // The inputs handle their own keys, including Enter
    if (focus !== "mode" && focus !== "filterKind") return

    if (key.name === "return") {
      submit()
    } else if (focus === "mode") {
      setSelectedModeIndex(step(key.name, selectedModeIndex, SEARCH_MODES.length))
    } else {
      setFilterKindIndex(step(key.name, filterKindIndex, FILTER_KINDS.length))
    }
  })

  const focusColor = (area: Focus, otherwise: string) => (focus === area ? colors.status.info.default : otherwise)

  // A row of options, like `Mode: [*] Keyword  [o] Semantic`
  const optionRow = (area: Focus, label: string, options: string[], selected: number) => (
    <box style={{ flexDirection: "row", gap: 2 }}>
      <text content={label} style={{ fg: focusColor(area, colors.text.secondary) }} />
      {options.map((option, index) => {
        const isSelected = index === selected
        return (
          <text
            key={option}
            content={`[${isSelected ? "*" : "o"}] ${option}`}
            style={{
              fg: isSelected ? focusColor(area, colors.text.primary) : colors.text.tertiary,
              attributes: isSelected ? TextAttributes.BOLD : undefined,
            }}
          />
        )
      })}
    </box>
  )

  return (
    <box
      style={{
        position: "absolute",
        top: "20%",
        left: "10%",
        width: "80%",
        height: 18,
        backgroundColor: colors.bg.elevated,
        borderStyle: "double",
        borderColor: colors.status.info.default,
        border: true,
        flexDirection: "column",
        padding: 1,
      }}
    >
      <text
        content="Search Repositories"
        style={{
          fg: colors.status.info.default,
          attributes: TextAttributes.BOLD,
          marginBottom: 1,
        }}
      />
      <box
        title="Search Query"
        style={{
          border: true,
          borderColor: focusColor("query", colors.border.default),
          height: 3,
        }}
      >
        <input
          placeholder="Enter search query..."
          value={initialValue}
          onInput={handleQueryInput}
          onSubmit={submit}
          focused={focus === "query"}
          style={{
            focusedBackgroundColor: colors.bg.muted,
          }}
        />
      </box>

      <box
        title={`Filter by ${FILTER_KINDS[filterKindIndex].label.toLowerCase()} (optional)`}
        style={{
          border: true,
          borderColor: focusColor("filter", colors.border.default),
          height: 3,
        }}
      >
        <input
          placeholder={FILTER_KINDS[filterKindIndex].placeholder}
          value={startFilterText}
          onInput={setFilterText}
          onSubmit={submit}
          focused={focus === "filter"}
          style={{
            focusedBackgroundColor: colors.bg.muted,
          }}
        />
      </box>

      {optionRow("filterKind", "Filter: ", FILTER_KINDS.map((k) => k.label), filterKindIndex)}

      <box style={{ marginTop: 1 }}>
        {optionRow("mode", "Mode: ", SEARCH_MODES.map((m) => m.label), selectedModeIndex)}
      </box>

      <text
        content={SEARCH_MODES[selectedModeIndex].description}
        style={{
          fg: colors.text.muted,
          marginTop: 0,
        }}
      />

      <text
        content="[Enter] Search  [Tab] Switch focus  [h/l] Change option  [Esc] Cancel"
        style={{
          fg: colors.text.tertiary,
          marginTop: 1,
        }}
      />
    </box>
  )
}
