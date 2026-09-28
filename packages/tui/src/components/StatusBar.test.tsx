import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/react/test-utils"
import { afterEach, describe, expect, it } from "vitest"
import { interact, teardown } from "../test/helpers.js"
import { StatusBar } from "./StatusBar.js"

let setup: TestRendererSetup | undefined

afterEach(async () => {
  await teardown(setup)
  setup = undefined
})

const colorOf = (setup: TestRendererSetup, text: string) => {
  for (const line of setup.captureSpans().lines) {
    const span = line.spans.find((s) => s.text.includes(text))
    if (span) return `${span.fg.r},${span.fg.g},${span.fg.b}`
  }
  throw new Error(`"${text}" isn't on screen`)
}

describe("StatusBar", () => {
  it("colours each task count on its own: only the failed count is red", async () => {
    setup = await testRender(<StatusBar mode="list" jobCounts={{ running: 6, failed: 1 }} />, { width: 160, height: 5 })
    await interact(setup, () => {})

    expect(setup.captureCharFrame()).toContain("Tasks: 6 running, 1 failed")
    const failed = colorOf(setup, "1 failed")
    expect(colorOf(setup, "6 running")).not.toBe(failed)
    expect(colorOf(setup, "Tasks:")).not.toBe(failed)
  })

  it("puts the status and the key help on separate lines, so they never overlap", async () => {
    // Narrow enough that the status and the key help couldn't share one line
    setup = await testRender(
      <StatusBar
        mode="list"
        message="[OK] Effect-TS-effect updated"
        activity="Syncing Effect-TS-language-service · up to 3 workers"
        jobCounts={{ running: 6, failed: 1 }}
      />,
      { width: 120, height: 6 }
    )
    await interact(setup, () => {})
    const lines = setup.captureCharFrame().split("\n")
    const lineOf = (text: string) => lines.findIndex((l) => l.includes(text))

    const status = lineOf("Syncing Effect-TS-language-service · up to 3 workers")
    expect(status).toBeGreaterThan(-1)
    expect(lineOf("[OK] Effect-TS-effect updated")).toBe(status)
    expect(lineOf("Tasks: 6 running, 1 failed")).toBe(status)
    expect(lineOf("[a] Add  [d] Delete  [s] Sync")).toBe(status + 1)
  })
})
