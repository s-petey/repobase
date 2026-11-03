import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/react/test-utils"
import { afterEach, describe, expect, it, vi } from "vitest"
import { interact, teardown } from "../test/helpers.js"
import { AddRepoModal, } from "./AddRepoModal"

const URL = "https://github.com/Effect-TS/effect"

let setup: TestRendererSetup | undefined

afterEach(async () => {
  await teardown(setup)
  setup = undefined
})

describe("AddRepoModal", () => {
  it("inserts pasted text exactly once", async () => {
    const onInput = vi.fn((_value: string) => {})
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
    const onSubmit = vi.fn((_url: string) => {})
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
