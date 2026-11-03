import { defineConfig } from "vitest/config"

// Monorepo test runner: every workspace package is a Vitest project and
// uses its own vitest.config.ts when it has one.
// Run with `bun --bun vitest` (see package.json): the TUI's opentui renderer
// needs Bun's FFI, and all projects share the runner's runtime.
export default defineConfig({
  test: {
    projects: ["packages/*"],
    passWithNoTests: true
  }
})
