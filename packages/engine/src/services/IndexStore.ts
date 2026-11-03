import { Context, Effect, FileSystem, Layer, Semaphore } from "effect"
import type { Connection, Table } from "@lancedb/lancedb"
import { IndexError } from "../errors.js"

// One row per chunk of a file
const CHUNKS_TABLE = "chunks"
const EMBEDDING_DIMENSION = 384

/**
 * Where the search index is stored: its database connection and the chunks
 * table. Both open on first use and close when the layer shuts down.
 */
export interface IndexStoreService {
  readonly connection: Effect.Effect<Connection, IndexError>
  readonly table: Effect.Effect<Table, IndexError>
}

export class IndexStore extends Context.Service<IndexStore, IndexStoreService>()(
  "@repobase/engine/IndexStore"
) {}

export const make = (indexDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    let db: Connection | null = null
    let table: Table | null = null

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        table?.close()
        db?.close()
      })
    )

    const connection = Effect.gen(function* () {
      if (db) return db
      yield* fs.makeDirectory(indexDir, { recursive: true }).pipe(Effect.ignore)

      const lancedb = yield* Effect.tryPromise({
        try: () => import("@lancedb/lancedb"),
        catch: (e) => new IndexError({ operation: "init", message: `Failed to import lancedb: ${e}` })
      })

      // Every worker thread has its own long-lived connection to the same index.
      // Without a consistency check each one keeps reading the table as it was
      // when it opened it: searches miss newly indexed files, and compaction
      // plans from stale fragments and hits a commit conflict on every retry.
      db = yield* Effect.tryPromise({
        try: () => lancedb.connect(indexDir, { readConsistencyInterval: 0 }),
        catch: (e) => new IndexError({ operation: "init", message: `Failed to connect to LanceDB: ${e}` })
      })
      return db
    })

    // One opener at a time, so concurrent first calls don't all try to create the table
    const tableLock = yield* Semaphore.make(1)

    const openTable = (database: Connection) =>
      Effect.tryPromise({
        try: () => database.openTable(CHUNKS_TABLE),
        catch: (e) => new IndexError({ operation: "init", message: `Failed to open table: ${e}` })
      })

    const getTable = tableLock.withPermit(Effect.gen(function* () {
      if (table) return table

      const database = yield* connection
      const tableNames = yield* Effect.tryPromise({
        try: () => database.tableNames(),
        catch: (e) => new IndexError({ operation: "init", message: `Failed to list tables: ${e}` })
      })

      if (tableNames.includes(CHUNKS_TABLE)) {
        table = yield* openTable(database)
      } else {
        // Create with schema using a template record
        table = yield* Effect.tryPromise({
          try: async () => {
            const newTable = await database.createTable(CHUNKS_TABLE, [
              {
                id: "__template__",
                repo: "",
                path: "",
                filename: "",
                chunk: 0,
                start_line: 0,
                end_line: 0,
                text: "",
                mtime_ms: 0,
                size_bytes: 0,
                hash: "",
                vector: Array(EMBEDDING_DIMENSION).fill(0)
              }
            ])
            await newTable.delete("id = '__template__'")
            return newTable
          },
          catch: (e) => new IndexError({ operation: "init", message: `Failed to create table: ${e}` })
        }).pipe(
          // Another process (a worker thread or the MCP server) created it first
          Effect.catchIf(
            (e) => /already exists/i.test(e.message),
            () => openTable(database)
          )
        )
      }
      return table
    }))

    return IndexStore.of({ connection, table: getTable })
  })

export const layer = (indexDir: string) => Layer.effect(IndexStore, make(indexDir))
