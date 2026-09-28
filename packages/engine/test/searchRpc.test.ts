import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { SearchMode } from "../src/schemas.js"
import { Indexer } from "../src/services/Indexer.js"
import { WorkerClient } from "../src/worker/client.js"
import { addRepo, makeSourceRepo, testEnv } from "./fixtures/jobEnv.js"

describe("Search RPC", () => {
  const modes: ReadonlyArray<SearchMode> = ["keyword", "semantic", "hybrid"]

  for (const mode of modes) {
    it.effect(`returns the same ${mode} results as the Indexer`, () =>
      Effect.gen(function* () {
        const source = makeSourceRepo(10)
        yield* addRepo(source.dir)

        const client = yield* WorkerClient
        const indexer = yield* Indexer
        const options = { repo: "acme-widgets", limit: 5 }

        const viaRpc = yield* client.Search({ query: "value3", mode, ...options })
        const direct =
          mode === "keyword"
            ? yield* indexer.searchKeyword("value3", options)
            : mode === "semantic"
              ? yield* indexer.searchSemantic("value3", options)
              : yield* indexer.searchHybrid("value3", options)

        expect(viaRpc.length).toBeGreaterThan(0)
        expect(viaRpc).toEqual(direct)
      }).pipe(Effect.provide(testEnv().layer)), 30_000)
  }
})
