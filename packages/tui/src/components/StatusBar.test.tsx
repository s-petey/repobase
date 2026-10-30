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

  it("gives each status its own line and wraps the key help, so nothing overlaps", async () => {
    setup = await testRender(
      <StatusBar
        mode="list"
        grouped
        message="[OK] Effect-TS-effect updated"
        outdated={3}
        activity="Syncing hi-rasmus/hirasmus"
        workerLimit={3}
        jobCounts={{ running: 1, failed: 6 }}
      />,
      { width: 100, height: 12 }
    )
    await interact(setup, () => {})
    const frame = setup.captureCharFrame()
    const lines = frame.split("\n")
    const lineOf = (text: string) => lines.findIndex((l) => l.includes(text))

    const message = lineOf("[OK] Effect-TS-effect updated")
    expect(message).toBeGreaterThan(-1)
    expect(lineOf("3 repos aren't searchable until re-indexed")).toBe(message + 1)
    expect(lineOf("Syncing hi-rasmus/hirasmus · up to 3 workers")).toBe(message + 2)
    expect(lineOf("Tasks: 1 running, 6 failed")).toBe(message + 3)
    expect(lineOf("[Enter] Toggle group")).toBe(message + 4)
    expect(frame).toContain("[q] Quit")
  })

  it("puts the activity and task counts on one line, without the worker limit, in a narrow terminal", async () => {
    setup = await testRender(
      <StatusBar
        mode="list"
        message="[OK] Effect-TS-effect updated"
        outdated={3}
        activity="Syncing hi-rasmus/hirasmus"
        workerLimit={3}
        jobCounts={{ running: 1, failed: 6 }}
      />,
      { width: 60, height: 12 }
    )
    await interact(setup, () => {})
    const frame = setup.captureCharFrame()

    expect(frame).toContain("Syncing hi-rasmus/hirasmus · Tasks: 1 running, 6 failed")
    expect(frame).not.toContain("workers")
    expect(frame).toContain("! 3 repos need re-indexing · [r] [R] all")
  })

  it("hints at the actions menu with [?]", async () => {
    setup = await testRender(<StatusBar mode="list" />, { width: 160, height: 5 })
    await interact(setup, () => {})
    const frame = setup.captureCharFrame()

    expect(frame).toContain("[q] Quit")
    expect(frame).toContain("[?] Keys")
  })

  it("shows only the main keys and [?] for the rest in a narrow terminal", async () => {
    setup = await testRender(<StatusBar mode="list" grouped />, { width: 60, height: 6 })
    await interact(setup, () => {})
    const frame = setup.captureCharFrame()

    for (const hint of ["[a]dd", "[s]ync", "[/]search", "[t]asks", "[q]uit", "[?] all keys"]) {
      expect(frame).toContain(hint)
    }
    expect(frame).not.toContain("[d] Delete")
    expect(frame).not.toContain("[Enter] Toggle group")
  })

  it("keeps each key hint whole when the hints wrap", async () => {
    setup = await testRender(<StatusBar mode="list" grouped />, { width: 80, height: 8 })
    await interact(setup, () => {})
    const frame = setup.captureCharFrame()

    for (const hint of ["[Enter] Toggle group", "[S] Sync All", "[c] Copy MCP Config", "[q] Quit"]) {
      expect(frame).toContain(hint)
    }
  })
})
