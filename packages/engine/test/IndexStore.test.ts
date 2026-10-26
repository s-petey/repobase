import { describe, it, expect } from "@effect/vitest"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import * as nodeFs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { make } from "../src/services/IndexStore.js"

const tempDir = () => nodeFs.mkdtempSync(path.join(os.tmpdir(), "repobase-index-store-"))

describe("IndexStore", () => {
  it.effect("closes its connection when its scope closes", () =>
    Effect.gen(function* () {
      const connection = yield* Effect.gen(function* () {
        const store = yield* make(tempDir())
        yield* store.table
        const opened = yield* store.connection
        expect(opened.isOpen()).toBe(true)
        return opened
      }).pipe(Effect.scoped)

      expect(connection.isOpen()).toBe(false)
    }).pipe(Effect.provide(BunServices.layer))
  )
})
