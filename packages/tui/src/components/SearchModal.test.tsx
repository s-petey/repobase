import { RGBA } from "@opentui/core"
import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/react/test-utils"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { SearchFilter } from "../searchView.js"
import { interact, teardown } from "../test/helpers.js"
import { colors } from "../theme/index.js"
import { SearchModal } from "./SearchModal.js"

let setup: TestRendererSetup | undefined

afterEach(async () => {
  await teardown(setup)
  setup = undefined
})

describe("SearchModal", () => {
  it("fits the mode picker, its description and the key help without overlapping", async () => {
    setup = await testRender(
      <SearchModal onSubmit={() => {}} onCancel={() => {}} onInput={() => {}} value="" />,
      { width: 100, height: 30 }
    )
    await interact(setup, () => {})
    const lines = setup.captureCharFrame().split("\n")
    const lineOf = (text: string) => lines.findIndex((l) => l.includes(text))

    const mode = lineOf("[*] Hybrid")
    const description = lineOf("Combined keyword + semantic")
    const help = lineOf("[Enter] Search  [Tab] Switch focus  [h/l] Change option  [Esc] Cancel")
    expect(mode).toBeGreaterThan(-1)
    expect(description).toBeGreaterThan(mode)
    expect(help).toBeGreaterThan(description)
  })

  it("inserts pasted text exactly once", async () => {
    const onInput = vi.fn((_value: string) => {})
    setup = await testRender(
      <SearchModal onSubmit={() => {}} onCancel={() => {}} onInput={onInput} value="" />,
      { width: 100, height: 30 }
    )
    await setup.renderOnce()

    await interact(setup, () => setup!.mockInput.pasteBracketedText("group repos"))

    expect(onInput.mock.calls.at(-1)?.[0]).toBe("group repos")
    expect(setup.captureCharFrame()).not.toContain("group reposgroup repos")
  })

  it("submits the query with the default hybrid mode", async () => {
    const onSubmit = vi.fn((_query: string, _mode: string) => {})
    setup = await testRender(
      <SearchModal onSubmit={onSubmit} onCancel={() => {}} onInput={() => {}} value="" />,
      { width: 100, height: 30 }
    )
    await setup.renderOnce()

    await interact(setup, () => setup!.mockInput.pasteBracketedText("group repos"))
    await interact(setup, () => setup!.mockInput.pressEnter())

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0]).toEqual(["group repos", "hybrid", undefined])
  })

  it("submits a path filter typed after Tab", async () => {
    const onSubmit = vi.fn((_query: string, _mode: string, _filter: SearchFilter | undefined) => {})
    setup = await testRender(
      <SearchModal onSubmit={onSubmit} onCancel={() => {}} onInput={() => {}} value="" />,
      { width: 100, height: 30 }
    )
    await setup.renderOnce()

    await interact(setup, () => setup!.mockInput.pasteBracketedText("group repos"))
    await interact(setup, () => setup!.mockInput.pressTab())
    await interact(setup, () => setup!.mockInput.pasteBracketedText(" src/components "))
    await interact(setup, () => setup!.mockInput.pressEnter())

    expect(onSubmit.mock.calls).toEqual([["group repos", "hybrid", { kind: "path", text: "src/components" }]])
  })

  it("switches the filter to a glob with the toggle", async () => {
    const onSubmit = vi.fn((_query: string, _mode: string, _filter: SearchFilter | undefined) => {})
    setup = await testRender(
      <SearchModal onSubmit={onSubmit} onCancel={() => {}} onInput={() => {}} value="" />,
      { width: 100, height: 30 }
    )
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Filter by path (optional)")

    await interact(setup, () => setup!.mockInput.pasteBracketedText("group repos"))
    await interact(setup, () => setup!.mockInput.pressTab())
    await interact(setup, () => setup!.mockInput.pasteBracketedText("*.md"))
    await interact(setup, () => setup!.mockInput.pressTab())
    await interact(setup, () => setup!.mockInput.pressKey("l"))
    expect(setup.captureCharFrame()).toContain("Filter by glob (optional)")
    await interact(setup, () => setup!.mockInput.pressEnter())

    expect(onSubmit.mock.calls).toEqual([["group repos", "hybrid", { kind: "glob", text: "*.md" }]])
  })

  it("starts from the filter it's given", async () => {
    setup = await testRender(
      <SearchModal
        onSubmit={() => {}}
        onCancel={() => {}}
        onInput={() => {}}
        value="group repos"
        initialFilter={{ kind: "glob", text: "crates/**" }}
      />,
      { width: 100, height: 30 }
    )
    await interact(setup, () => {})
    const frame = setup.captureCharFrame()

    expect(frame).toContain("Filter by glob (optional)")
    expect(frame).toContain("crates/**")
    expect(frame).toContain("[*] Glob")
  })

  it("uses the focus color only on the focused area", async () => {
    setup = await testRender(
      <SearchModal onSubmit={() => {}} onCancel={() => {}} onInput={() => {}} value="" />,
      { width: 100, height: 30 }
    )
    await interact(setup, () => {})
    const focusColor = RGBA.fromHex(colors.status.info.default)
    const isFocused = (text: string) => {
      const spans = setup!.captureSpans().lines.flatMap((line) => line.spans)
      const span = spans.find((s) => s.text.includes(text))
      expect(span).toBeDefined()
      return focusColor.equals(span!.fg)
    }
    const focused = () => ({ filterKind: isFocused("[*] Path"), mode: isFocused("[*] Hybrid") })

    // The query box, then the filter box, has focus
    expect(focused()).toEqual({ filterKind: false, mode: false })
    await interact(setup, () => setup!.mockInput.pressTab())
    expect(focused()).toEqual({ filterKind: false, mode: false })

    // Then the filter toggle, then the mode row
    await interact(setup, () => setup!.mockInput.pressTab())
    expect(focused()).toEqual({ filterKind: true, mode: false })
    await interact(setup, () => setup!.mockInput.pressTab())
    expect(focused()).toEqual({ filterKind: false, mode: true })
  })
})
