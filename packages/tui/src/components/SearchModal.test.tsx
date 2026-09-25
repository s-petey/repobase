import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/react/test-utils"
import { afterEach, describe, expect, it, vi } from "vitest"
import { interact, teardown } from "../test/helpers.js"
import { SearchModal } from "./SearchModal.js"

let setup: TestRendererSetup | undefined

afterEach(async () => {
  await teardown(setup)
  setup = undefined
})

describe("SearchModal", () => {
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
    expect(onSubmit.mock.calls[0]).toEqual(["group repos", "hybrid"])
  })
})
