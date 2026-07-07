import { describe, it, expect, vi } from "vitest"
import { defaultLogPath, fileLoggerLayer } from "../src/file-logger.js"

vi.mock("node:os", () => ({
  default: {
    homedir: () => "/fake/home",
  },
  homedir: () => "/fake/home",
}))

vi.mock("node:path", () => ({
  default: {
    join: (...args: string[]) => args.join("/"),
    dirname: (p: string) => p.split("/").slice(0, -1).join("/"),
  },
  join: (...args: string[]) => args.join("/"),
  dirname: (p: string) => p.split("/").slice(0, -1).join("/"),
}))

describe("file-logger", () => {
  it("provides a default log path", () => {
    expect(defaultLogPath).toBe("/fake/home/.repobase/tui.log")
  })

  it("creates a file logger layer", () => {
    const layer = fileLoggerLayer("/custom/path.log")
    expect(layer).toBeDefined()
  })

  it("creates a file logger layer with default path", () => {
    const layer = fileLoggerLayer()
    expect(layer).toBeDefined()
  })
})
