import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import type { SearchResult, SearchMode } from "@repobase/engine"
import { useEffect, useRef } from "react"
import { describeFilter, formatLines, formatScore, shortenPath, type SearchFilter, type SearchScope } from "../searchView.js"
import { colors } from "../theme/index.js"

interface SearchResultsProps {
  query: string
  mode: SearchMode
  filter?: SearchFilter
  // Undefined when the search covered every repository
  scope?: SearchScope
  // E.g. that some repos in the scope can't be searched until they're re-indexed
  warning?: string
  results: SearchResult[]
  selectedIndex: number
  onSelectIndex: (index: number) => void
  onClose: () => void
}

const getModeLabel = (mode: SearchMode): string => {
  switch (mode) {
    case "keyword": return "Keyword"
    case "semantic": return "Semantic"
    case "hybrid": return "Hybrid"
  }
}

const getScoreColor = (score: number): string => {
  const scorePercent = score * 100
  if (scorePercent > 80) return colors.score.high
  if (scorePercent > 50) return colors.score.medium
  return colors.score.low
}

const rowId = (index: number) => `search-result-${index}`

// The list takes 40% of the width (at least 32 columns); each row is the
// selection marker, the path padded to a fixed width, a space and the score
const listWidth = (terminalWidth: number) => Math.max(32, Math.floor(terminalWidth * 0.4))
const MARKER_WIDTH = 2
const SCORE_WIDTH = 5 // " 100%"
const SCROLLBAR_WIDTH = 1

export const SearchResults = ({
  query,
  mode,
  filter,
  scope,
  warning,
  results,
  selectedIndex,
  onSelectIndex,
  onClose,
}: SearchResultsProps) => {
  const { width } = useTerminalDimensions()
  const scrollRef = useRef<ScrollBoxRenderable | null>(null)

  const leftWidth = listWidth(width)
  const pathWidth = Math.max(8, leftWidth - MARKER_WIDTH - SCORE_WIDTH - SCROLLBAR_WIDTH)
  const selected = results[selectedIndex]

  useEffect(() => {
    scrollRef.current?.scrollChildIntoView(rowId(selectedIndex))
  }, [selectedIndex, results])

  useKeyboard((key) => {
    switch (key.name) {
      case "escape":
      case "q":
        onClose()
        break
      case "up":
      case "k":
        onSelectIndex(Math.max(0, selectedIndex - 1))
        break
      case "down":
      case "j":
        onSelectIndex(Math.min(results.length - 1, selectedIndex + 1))
        break
    }
  })

  return (
    <box
      style={{
        flexGrow: 1,
        flexDirection: "column",
        padding: 1,
      }}
    >
      {/* Header */}
      <box
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          marginBottom: warning ? 0 : 1,
        }}
      >
        <text
          content={`Search Results: "${query}"${scope ? ` in ${scope.label}` : ""}${filter ? ` ${describeFilter(filter)}` : ""} (${getModeLabel(mode)})`}
          style={{
            fg: colors.status.info.default,
            attributes: TextAttributes.BOLD,
          }}
        />
        <text
          content={`${results.length} result${results.length !== 1 ? "s" : ""}`}
          style={{
            fg: colors.text.secondary,
          }}
        />
      </box>
      {warning && (
        <text content={`⚠ ${warning}`} style={{ fg: colors.status.warning.default, marginBottom: 1 }} />
      )}

      {results.length === 0 ? (
        <box
          style={{
            flexGrow: 1,
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <text
            content="No results found."
            style={{ fg: colors.text.secondary }}
          />
          <text
            content="Press [Esc] or [q] to go back."
            style={{ fg: colors.text.tertiary, marginTop: 1 }}
          />
        </box>
      ) : (
        <box style={{ flexGrow: 1, flexDirection: "row", gap: 1 }}>
          {/* Not focused: it would scroll on the arrow keys itself, out of step
              with the selection; the effect above scrolls the selection into view */}
          <scrollbox
            ref={scrollRef}
            style={{
              width: leftWidth,
              flexShrink: 0,
            }}
          >
            {results.map((result, index) => {
              const isSelected = index === selectedIndex
              return (
                <box
                  id={rowId(index)}
                  key={`${result.repo}:${result.path}`}
                  style={{
                    flexDirection: "row",
                    backgroundColor: isSelected ? colors.accent.muted : undefined,
                  }}
                >
                  <text
                    content={`${isSelected ? "> " : "  "}${shortenPath(result.repo, result.path, pathWidth).padEnd(pathWidth)}`}
                    style={{
                      fg: isSelected ? colors.text.primary : colors.interactive.default,
                      attributes: isSelected ? TextAttributes.BOLD : undefined,
                    }}
                  />
                  <text
                    content={` ${formatScore(result.score)}`}
                    style={{
                      fg: getScoreColor(result.score),
                    }}
                  />
                </box>
              )
            })}
          </scrollbox>

          {/* The highlighted result: full path, then its snippet */}
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
                content={[`${selected.repo}/${selected.path}`, formatLines(selected)].filter(Boolean).join(" · ")}
                style={{
                  fg: colors.text.primary,
                  attributes: TextAttributes.BOLD,
                  marginBottom: 1,
                }}
              />
              <text
                content={selected.snippet || "No preview available"}
                style={{
                  fg: selected.snippet ? colors.text.secondary : colors.text.tertiary,
                }}
              />
            </box>
          )}
        </box>
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
          content="[Up/k] Up  [Down/j] Down  [Esc/q] Back to list"
          style={{
            fg: colors.text.tertiary,
          }}
        />
      </box>
    </box>
  )
}
