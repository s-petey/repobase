import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/react/test-utils"
import { afterEach, describe, expect, it } from "vitest"
import { interact, teardown } from "../test/helpers.js"
import { Header } from "./Header.js"

let setup: TestRendererSetup | undefined

afterEach(async () => {
  await teardown(setup)
  setup = undefined
})

const usedLines = async (width: number) => {
  const app = await testRender(<Header version="1.3.0" />, { width, height: 8 })
  setup = app
  await interact(app, () => {})
  return app
    .captureCharFrame()
    .split("\n")
    .filter((line) => line.trim() !== "")
}

describe("Header", () => {
  it("takes one line in a narrow terminal", async () => {
    const lines = await usedLines(60)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("repobase")
    expect(lines[0]).toContain("v1.3.0")
  })

  it("keeps its bordered box when wide", async () => {
    expect((await usedLines(160)).length).toBeGreaterThan(1)
  })
})
