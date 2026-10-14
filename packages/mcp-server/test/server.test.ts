import { BunServices } from "@effect/platform-bun"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import { GitClientLayer, IndexerLayerWith, RepobaseEngineLayer, RepoStore, type RepoStoreData } from "@repobase/engine"
import { Effect, Layer, ManagedRuntime, Option, Ref } from "effect"
import * as nodeFs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { makeServer } from "../src/server.js"

// config.json in memory, so the test never touches ~/.repobase
const MemoryRepoStore = Layer.effect(
  RepoStore,
  Effect.gen(function* () {
    const data = yield* Ref.make<RepoStoreData>({ version: 1, repos: [] })
    const load = () => Ref.get(data)
    return RepoStore.of({
      load,
      save: (next) => Ref.set(data, next),
      getRepo: (id) => load().pipe(Effect.map((d) => Option.fromNullishOr(d.repos.find((r) => r.id === id)))),
      addRepo: (repo) => Ref.update(data, (d) => ({ ...d, repos: [...d.repos, repo] })),
      updateRepo: (id, update) =>
        Ref.update(data, (d) => ({ ...d, repos: d.repos.map((r) => (r.id === id ? { ...r, ...update } : r)) })),
      removeRepo: (id) => Ref.update(data, (d) => ({ ...d, repos: d.repos.filter((r) => r.id !== id) }))
    })
  })
)

const fakeEmbed = async () => Array.from({ length: 384 }, (_, i) => (i + 1) / 384)

let close: (() => Promise<void>) | undefined

afterEach(async () => {
  await close?.()
  close = undefined
})

const connect = async () => {
  const indexDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "repobase-mcp-index-"))
  const runtime = ManagedRuntime.make(
    RepobaseEngineLayer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(GitClientLayer, MemoryRepoStore, IndexerLayerWith({ indexDir, embed: fakeEmbed }))
      ),
      Layer.provide(BunServices.layer)
    )
  )
  const server = await makeServer(runtime)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
  close = async () => {
    await client.close()
    await server.close()
    await runtime.dispose()
  }
  return client
}

describe("repobase MCP server", () => {
  it("lists every tool, with descriptions, types and defaults in each input's JSON Schema", async () => {
    const client = await connect()
    const { tools } = await client.listTools()

    expect(tools.map((t) => t.name).sort()).toEqual([
      "glob_files",
      "grep",
      "list_files",
      "list_repos",
      "read_file",
      "search"
    ])
    const search = tools.find((t) => t.name === "search")!.inputSchema
    expect(search.required).toEqual(["query"])
    expect(search.properties).toMatchObject({
      query: { type: "string", description: "The search query" },
      mode: { type: "string", enum: ["keyword", "semantic", "hybrid"], default: "hybrid" },
      limit: { type: "integer", default: 20, description: "Maximum number of results to return" },
      repo: { type: "string" }
    })
    const grep = tools.find((t) => t.name === "grep")!.inputSchema
    expect(grep.required).toEqual(["pattern"])
    expect(grep.properties).toMatchObject({
      ignoreCase: { type: "boolean", default: false },
      context: { type: "integer" },
      limit: { type: "integer", default: 100 }
    })
  })

  it("rejects invalid arguments with a validation error", async () => {
    const client = await connect()

    const wrongType = await client.callTool({ name: "search", arguments: { query: 42 } })
    expect(wrongType.isError).toBe(true)
    expect(JSON.stringify(wrongType.content)).toContain("query: Expected string")

    const notAnInteger = await client.callTool({ name: "grep", arguments: { pattern: "x", limit: 1.5 } })
    expect(notAnInteger.isError).toBe(true)

    const zero = await client.callTool({ name: "search", arguments: { query: "x", limit: 0 } })
    expect(zero.isError).toBe(true)
    expect(JSON.stringify(zero.content)).not.toContain("k must be positive")
  })

  it("says which repo isn't indexed", async () => {
    const client = await connect()

    for (const [name, args] of [
      ["read_file", { repo: "nobody/nothing", path: "README.md" }],
      ["grep", { pattern: "x", repo: "nobody/nothing" }],
      ["search", { query: "x", repo: "nobody/nothing" }]
    ] as const) {
      const result = await client.callTool({ name, arguments: args })
      expect(result.isError).toBe(true)
      expect(result.content).toEqual([
        {
          type: "text",
          text: expect.stringContaining("Repository nobody/nothing isn't indexed in repobase")
        }
      ])
    }
  })

  it("runs a tool with its defaults", async () => {
    const client = await connect()

    const repos = await client.callTool({ name: "list_repos", arguments: {} })
    expect(repos.content).toEqual([{ type: "text", text: "[]" }])

    const grep = await client.callTool({ name: "grep", arguments: { pattern: "anything" } })
    expect(grep.isError).toBeFalsy()
    expect(grep.content).toEqual([{ type: "text", text: "[]" }])
  })
})
