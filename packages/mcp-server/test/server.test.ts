import { BunServices } from "@effect/platform-bun"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import {
  CURRENT_INDEX_FORMAT,
  GitClientLayer,
  Indexer,
  IndexerLayerWith,
  RepobaseEngineLayer,
  RepoStore,
  type RepoStoreData,
  trackingMode
} from "@repobase/engine"
import { DateTime, Effect, Layer, ManagedRuntime, Option, Predicate, Ref } from "effect"
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
      removeRepo: (id) => Ref.update(data, (d) => ({ ...d, repos: d.repos.filter((r) => r.id !== id) })),
      modify: (f) => Ref.update(data, f)
    })
  })
)

const fakeEmbed = async () => Array.from({ length: 384 }, (_, i) => (i + 1) / 384)

let close: (() => Promise<void>) | undefined

afterEach(async () => {
  await close?.()
  close = undefined
})

const REPO = "acme/widgets"

const FILES = {
  "src/math.ts": "export const addNumbers = (a: number, b: number) => a + b\n// TODO: handle overflow\n",
  "src/greet.ts": "export const greet = (name: string) => `hello ${name}`\n",
  "README.md": "# Widgets\nA small library of widgets.\n"
}

const indexFixtureRepo = (reposDir: string) =>
  Effect.gen(function* () {
    const localPath = path.join(reposDir, REPO)
    for (const [file, contents] of Object.entries(FILES)) {
      nodeFs.mkdirSync(path.dirname(path.join(localPath, file)), { recursive: true })
      nodeFs.writeFileSync(path.join(localPath, file), contents)
    }
    const addedAt = yield* DateTime.now
    yield* RepoStore.use((store) =>
      store.addRepo({
        id: REPO,
        url: `https://github.com/${REPO}`,
        localPath,
        mode: trackingMode("main"),
        lastSyncedCommit: Option.some("abc123"),
        lastSyncedAt: Option.some(addedAt),
        addedAt,
        cloudEnabled: false,
        lastPushedAt: Option.none(),
        lastPushedCommit: Option.none(),
        indexFormat: CURRENT_INDEX_FORMAT
      })
    )
    yield* Indexer.use((indexer) => indexer.indexRepo(REPO, localPath))
  })

const connect = async (options: { readonly indexed?: boolean } = {}) => {
  const indexDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "repobase-mcp-index-"))
  const reposDir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "repobase-mcp-repos-"))
  const runtime = ManagedRuntime.make(
    RepobaseEngineLayer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(GitClientLayer, MemoryRepoStore, IndexerLayerWith({ indexDir, reposDir, embed: fakeEmbed }))
      ),
      Layer.provide(BunServices.layer)
    )
  )
  if (options.indexed) await runtime.runPromise(indexFixtureRepo(reposDir))
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
    const inputSchemaOf = (name: string) => {
      const tool = tools.find((t) => t.name === name)
      if (!tool) throw new Error(`No ${name} tool`)
      return tool.inputSchema
    }
    const search = inputSchemaOf("search")
    expect(search.required).toEqual(["query"])
    expect(search.properties).toMatchObject({
      query: { type: "string", description: "The search query" },
      mode: { type: "string", enum: ["keyword", "semantic", "hybrid"], default: "hybrid" },
      limit: { type: "integer", default: 20, description: "Maximum number of results to return" },
      repo: { type: "string" }
    })
    const grep = inputSchemaOf("grep")
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

describe("repobase MCP server tools on an indexed repo", () => {
  const call = async (client: Client, name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args })
    expect(result.isError).toBeFalsy()
    const block = Array.isArray(result.content) ? result.content[0] : undefined
    if (!Predicate.hasProperty(block, "text") || !Predicate.isString(block.text)) {
      throw new Error(`${name} returned no text block`)
    }
    return JSON.parse(block.text)
  }

  it("lists the repo as indexed and current", async () => {
    const client = await connect({ indexed: true })

    expect(await call(client, "list_repos", {})).toEqual([
      expect.objectContaining({ id: REPO, lastSyncedCommit: "abc123", needsReindex: false })
    ])
  })

  it("searches the repo, honouring repo, path and limit", async () => {
    const client = await connect({ indexed: true })

    const found = await call(client, "search", { query: "addNumbers", mode: "keyword", repo: REPO })
    expect(found[0]).toMatchObject({ repo: REPO, path: "src/math.ts", startLine: 1 })

    const inPath = await call(client, "search", { query: "export", mode: "keyword", path: "src/greet.ts" })
    expect(inPath.map((r: { path: string }) => r.path)).toEqual(["src/greet.ts"])

    expect(await call(client, "search", { query: "export", mode: "keyword", limit: 1 })).toHaveLength(1)
  })

  it("greps with context, files-with-matches and counts", async () => {
    const client = await connect({ indexed: true })

    expect(await call(client, "grep", { pattern: "TODO", repo: REPO, context: 1 })).toEqual([
      {
        repo: REPO,
        path: "src/math.ts",
        matchCount: 1,
        matches: [
          { lineNumber: 1, content: "export const addNumbers = (a: number, b: number) => a + b", isMatch: false },
          { lineNumber: 2, content: "// TODO: handle overflow", isMatch: true }
        ]
      }
    ])

    const files = await call(client, "grep", { pattern: "export", filesWithMatches: true })
    expect(files.map((r: { path: string }) => r.path).sort()).toEqual(["src/greet.ts", "src/math.ts"])

    const counts = await call(client, "grep", { pattern: "e", count: true, path: "README.md" })
    expect(counts).toEqual([expect.objectContaining({ path: "README.md", matchCount: 2, matches: [] })])
  })

  it("reads part of a file", async () => {
    const client = await connect({ indexed: true })

    expect(await call(client, "read_file", { repo: REPO, path: "src/math.ts", offset: 2, limit: 1, lineNumbers: false })).toMatchObject({
      repo: REPO,
      path: "src/math.ts",
      content: "// TODO: handle overflow",
      startLine: 2,
      endLine: 2
    })
  })

  it("finds files by glob and lists a directory", async () => {
    const client = await connect({ indexed: true })

    const ts = await call(client, "glob_files", { pattern: "**/*.ts", repo: REPO })
    expect(ts.map((f: { path: string }) => f.path).sort()).toEqual(["src/greet.ts", "src/math.ts"])
    expect(await call(client, "glob_files", { pattern: "**/*.ts", limit: 1 })).toHaveLength(1)

    const src = await call(client, "list_files", { repo: REPO, path: "src" })
    expect(src.map((f: { filename: string }) => f.filename).sort()).toEqual(["greet.ts", "math.ts"])
  })
})
