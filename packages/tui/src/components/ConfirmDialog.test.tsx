import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/react/test-utils"
import { afterEach, describe, expect, it } from "vitest"
import { interact, teardown } from "../test/helpers.js"
import { ConfirmDialog } from "./ConfirmDialog.js"

let setup: TestRendererSetup | undefined

afterEach(async () => {
  await teardown(setup)
  setup = undefined
})

const LONG =
  "repobase now indexes whole files. 2 of 3 repos need re-indexing before search can find anything in them. It runs in the background, so you can keep using repobase."

describe("ConfirmDialog", () => {
  it("grows to fit a message that wraps onto several lines", async () => {
    setup = await testRender(
      <ConfirmDialog title="Title" message={LONG} hints="[Enter] Go  [Esc] Later" onConfirm={() => {}} onCancel={() => {}} />,
      { width: 80, height: 30 }
    )
    await interact(setup, () => {})
    const frame = setup.captureCharFrame()

    expect(frame).toContain("Title")
    expect(frame).toContain("repobase now indexes")
    expect(frame).toContain("repobase.")
    expect(frame).toContain("[Enter] Go  [Esc] Later")
  })
})
