import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/react/test-utils"
import type { SearchResult } from "@repobase/engine"
import { useState } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { interact, teardown } from "../test/helpers.js"
import { SearchResults } from "./SearchResults.js"

const results: SearchResult[] = Array.from({ length: 30 }, (_, i) => ({
  repo: "acme-widgets",
  path: `src/file-${String(i).padStart(2, "0")}.ts`,
  filename: `file-${String(i).padStart(2, "0")}.ts`,
  score: i === 0 ? 1 : 0.5,
  snippet: `export const value${i} = ${i}`
}))

const longResult: SearchResult = {
  repo: "acme-widgets",
  path: "packages/core/src/some/deeply/nested/directory/structure/component.tsx",
  filename: "component.tsx",
  score: 0.05,
  snippet: "export const Component = () => null"
}

const renderResults = (list: SearchResult[], selectedIndex = 0, width = 120) =>
  testRender(
    <SearchResults
      query="value"
      mode="hybrid"
      results={list}
      selectedIndex={selectedIndex}
      onSelectIndex={() => {}}
      onClose={() => {}}
    />,
    { width, height: 20 }
  )

// Holds the selection like App does, so key presses move it
const Navigable = () => {
  const [selectedIndex, setSelectedIndex] = useState(0)
  return (
    <SearchResults
      query="value"
      mode="hybrid"
      results={results}
      selectedIndex={selectedIndex}
      onSelectIndex={setSelectedIndex}
      onClose={() => {}}
    />
  )
}

let setup: TestRendererSetup | undefined

afterEach(async () => {
  await teardown(setup)
  setup = undefined
})

describe("SearchResults", () => {
  it("keeps the selected result in view while moving down the list", async () => {
    setup = await testRender(<Navigable />, { width: 120, height: 20 })
    await interact(setup, () => {})

    // Partway down: a scrollbox that also scrolls on the arrow keys runs ahead
    // of the selection here, leaving the selected row off screen
    for (let i = 0; i < 12; i++) {
      await interact(setup, () => setup!.mockInput.pressArrow("down"))
    }
    expect(setup.captureCharFrame()).toContain("> acme-widgets/src/file-12.ts")

    for (let i = 0; i < 12; i++) {
      await interact(setup, () => setup!.mockInput.pressArrow("up"))
    }
    expect(setup.captureCharFrame()).toContain("> acme-widgets/src/file-00.ts")
  })

  it("shows the selected result's full path and snippet on the right, following the selection", async () => {
    setup = await testRender(<Navigable />, { width: 120, height: 20 })
    await interact(setup, () => {})
    let frame = setup.captureCharFrame()
    expect(frame).toContain("export const value0 = 0")
    expect(frame).not.toContain("export const value1 = 1")

    await interact(setup, () => setup!.mockInput.pressArrow("down"))
    frame = setup.captureCharFrame()
    expect(frame).toContain("export const value1 = 1")
    expect(frame).not.toContain("export const value0 = 0")
  })

  it("shortens long paths in the list but shows the full path on the right", async () => {
    // Wide enough that the right pane fits the full path on one line; the list
    // is still too narrow for it
    setup = await renderResults([longResult, ...results.slice(0, 3)], 0, 180)
    await interact(setup, () => {})
    const frame = setup.captureCharFrame()

    expect(frame).toContain("> acme-widgets/…/component.tsx")
    expect(frame).toContain(`acme-widgets/${longResult.path}`)
  })

  it("shows the lines the selected result's match covers next to its path", async () => {
    setup = await renderResults([{ ...results[0]!, startLine: 210, endLine: 260 }, results[1]!])
    await interact(setup, () => {})

    expect(setup.captureCharFrame()).toContain("acme-widgets/src/file-00.ts · lines 210–260")
  })

  it("lines up the scores in one column", async () => {
    setup = await renderResults([results[0]!, longResult, results[1]!])
    await interact(setup, () => {})
    const lines = setup.captureCharFrame().split("\n")
    const scoreColumn = (score: string) => {
      const line = lines.find((l) => l.includes(score))!
      return line.indexOf(score) + score.length
    }

    expect(scoreColumn("100%")).toBe(scoreColumn("  5%"))
    expect(scoreColumn("  5%")).toBe(scoreColumn(" 50%"))
  })

  it("draws the key help inside the footer's border", async () => {
    setup = await renderResults(results)
    await interact(setup, () => {})

    expect(setup.captureCharFrame()).toContain("│[Up/k] Up  [Down/j] Down  [Esc/q] Back to list")
  })
})
