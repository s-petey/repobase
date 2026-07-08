import * as path from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^vitest$/,
        replacement: path.resolve(__dirname, "../../node_modules/vitest/dist/index.js")
      }
    ]
  },
  test: {
    include: ["test/**/*.test.ts"],
    deps: {
      inline: ["@effect/vitest"]
    },
    fakeTimers: {
      toFake: undefined
    },
    sequence: {
      concurrent: true
    }
  }
})
