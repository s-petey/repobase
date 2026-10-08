// No shebang: it makes Bun.build mark the bundle `// @bun`, which Bun then
// decodes as Latin-1. dist/bin/repobase-mcp.js carries the shebang.
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { Layer, ManagedRuntime } from "effect"
import { BunServices } from "@effect/platform-bun"
import {
  RepobaseEngineLayer,
  GitClientLayer,
  RepoStoreLayer,
  IndexerLayer,
  telemetryLayer
} from "@repobase/engine"
import { makeServer } from "./server.js"

// Layer composition - same pattern as TUI
const EngineLive = RepobaseEngineLayer.pipe(
  Layer.provide(GitClientLayer),
  Layer.provide(RepoStoreLayer),
  Layer.provide(IndexerLayer)
)

const MainLayer = Layer.mergeAll(
  EngineLive,
  IndexerLayer
).pipe(
  Layer.provideMerge(telemetryLayer("repobase-mcp")),
  Layer.provide(BunServices.layer)
)

const runtime = ManagedRuntime.make(MainLayer)
const server = await makeServer(runtime)

await server.connect(new StdioServerTransport())

// Handle graceful shutdown
const shutdown = async () => {
  await server.close()
  await runtime.dispose()
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
