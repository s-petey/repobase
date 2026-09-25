import { afterEach, describe, expect, it, mock } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import type { TestRendererSetup } from "@opentui/core/testing"
import { AddRepoModal, SearchModal } from "../src/components/index.js"
import { interact, teardown } from "./helpers.js"

const URL = "https://github.com/Effect-TS/effect"

let setup: TestRendererSetup | undefined

afterEach(async () => {
  await teardown(setup)
  setup = undefined
})

describe("AddRepoModal", () => {
  it("inserts pasted text exactly once", async () => {
    const onInput = mock((_value: string) => {})
    setup = await testRender(
      <AddRepoModal onSubmit={() => {}} onCancel={() => {}} onInput={onInput} value="" />,
      { width: 100, height: 20 }
    )
    await setup.renderOnce()

    await interact(setup, () => setup!.mockInput.pasteBracketedText(URL))

    expect(onInput.mock.calls.at(-1)?.[0]).toBe(URL)
    expect(setup.captureCharFrame()).toContain(URL)
    expect(setup.captureCharFrame()).not.toContain(URL + URL)
  })

  it("calls onSubmit with the input's string value on Enter", async () => {
    const onSubmit = mock((_url: string) => {})
    setup = await testRender(
      <AddRepoModal onSubmit={onSubmit} onCancel={() => {}} onInput={() => {}} value="" />,
      { width: 100, height: 20 }
    )
    await setup.renderOnce()

    await interact(setup, () => setup!.mockInput.pasteBracketedText(URL))
    await interact(setup, () => setup!.mockInput.pressEnter())

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0]?.[0]).toBe(URL)
  })
})

describe("SearchModal", () => {
  it("inserts pasted text exactly once", async () => {
    const onInput = mock((_value: string) => {})
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
    const onSubmit = mock((_query: string, _mode: string) => {})
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
