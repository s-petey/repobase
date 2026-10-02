// No shebang: it makes Bun.build mark the bundle `// @bun`, which Bun then
// decodes as Latin-1. dist/bin/repobase-mcp.js carries the shebang.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { DateTime, Effect, Layer, ManagedRuntime, Option } from "effect"
import { BunServices } from "@effect/platform-bun"
import {
  RepobaseEngine,
  RepobaseEngineLayer,
  GitClientLayer,
  RepoStoreLayer,
  IndexerLayer,
  Indexer,
  type SearchMode
} from "@repobase/engine"
import { serverInstructions } from "./instructions.js"

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
  Layer.provide(BunServices.layer)
)

// Create a managed runtime with the engine layer
const runtime = ManagedRuntime.make(MainLayer)

// The instructions name the repos indexed right now; each client session
// starts its own server, so they're current for that session
const repos = await runtime.runPromise(
  RepobaseEngine.use((engine) => engine.listRepos()).pipe(Effect.orElseSucceed(() => []))
)

// Create MCP server
const server = new McpServer(
  {
    name: "repobase-mcp",
    version: "0.1.0"
  },
  { instructions: serverInstructions(repos) }
)

// Register list_repos tool
server.registerTool(
  "list_repos",
  {
    description: "List the repositories indexed locally in repobase, with when each was last synced. Check it when you're unsure whether a library or repo is available here.",
  },
  async () => {
    const program = Effect.gen(function* () {
      const engine = yield* RepobaseEngine
      const repos = yield* engine.listRepos()
      
      return repos.map((repo) => ({
        id: repo.id,
        url: repo.url,
        localPath: repo.localPath,
        lastSyncedAt: Option.match(repo.lastSyncedAt, { onNone: () => null, onSome: DateTime.formatIso }),
        addedAt: DateTime.formatIso(repo.addedAt)
      }))
    })

    const result = await runtime.runPromise(program)
    
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  }
)

// Register search tool
server.registerTool(
  "search",
  {
    description: "Search across all locally indexed repositories (keyword, semantic or hybrid). Use it first for questions about any of those repos: it's faster and more exact than web search.",
    inputSchema: {
      query: z.string().describe("The search query"),
      mode: z.enum(["keyword", "semantic", "hybrid"]).default("hybrid").describe("Search mode: keyword (fast text search), semantic (meaning-based), or hybrid (combines both)"),
      limit: z.number().optional().default(20).describe("Maximum number of results to return"),
      repo: z.string().optional().describe("Optional: limit search to a specific repository ID"),
      path: z.string().optional().describe("Optional: limit search to this file, or the files under this directory (e.g., 'crates/editor')")
    }
  },
  async ({ query, mode, limit, repo, path }) => {
    const program = Effect.gen(function* () {
      const engine = yield* RepobaseEngine
      const results = yield* engine.search(query, mode as SearchMode, {
        limit: limit ?? 20,
        repo,
        path
      })
      
      return results.map((result) => ({
        repo: result.repo,
        path: result.path,
        filename: result.filename,
        score: result.score,
        snippet: result.snippet
      }))
    })

    const results = await runtime.runPromise(program)
    
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(results, null, 2)
        }
      ]
    }
  }
)

// Register list_files tool
server.registerTool(
  "list_files",
  {
    description: "List files and directories of a locally indexed repository, or of a directory in it",
    inputSchema: {
      repo: z.string().optional().describe("Repository ID to list files from (omit to list all repos)"),
      path: z.string().optional().describe("Directory path within the repository (e.g., 'src' or 'src/components')")
    }
  },
  async ({ repo, path }) => {
    const program = Effect.gen(function* () {
      const indexer = yield* Indexer
      const files = yield* indexer.listFiles({ repo, path })
      
      return files.map((file) => ({
        repo: file.repo,
        path: file.path,
        filename: file.filename,
        isDirectory: file.isDirectory,
        size: file.size ?? null,
        mtime: file.mtime ? DateTime.formatIso(file.mtime) : null
      }))
    })

    const result = await runtime.runPromise(program)

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  }
)

// Register glob_files tool
server.registerTool(
  "glob_files",
  {
    description: "Find files matching a glob pattern in the locally indexed repositories",
    inputSchema: {
      pattern: z.string().describe("Glob pattern (e.g., '*.ts', '**/test/**', 'src/**/*.tsx')"),
      repo: z.string().optional().describe("Optional: limit search to a specific repository ID"),
      limit: z.number().optional().default(50).describe("Maximum number of results to return")
    }
  },
  async ({ pattern, repo, limit }) => {
    const program = Effect.gen(function* () {
      const indexer = yield* Indexer
      const files = yield* indexer.globFiles(pattern, {
        repo,
        limit: limit ?? 50
      })
      
      return files.map((file) => ({
        repo: file.repo,
        path: file.path,
        filename: file.filename,
        isDirectory: file.isDirectory,
        size: file.size ?? null,
        mtime: file.mtime ? DateTime.formatIso(file.mtime) : null
      }))
    })

    const result = await runtime.runPromise(program)
    
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  }
)

// Register read_file tool
server.registerTool(
  "read_file",
  {
    description: "Read a file from a locally indexed repository",
    inputSchema: {
      repo: z.string().describe("Repository ID"),
      path: z.string().describe("File path within the repository (e.g., 'src/main.ts')"),
      offset: z.number().optional().default(1).describe("Start line number (1-based, default: 1)"),
      limit: z.number().optional().describe("Number of lines to read (omit to read entire file)"),
      lineNumbers: z.boolean().optional().default(true).describe("Include line numbers in output")
    }
  },
  async ({ repo, path, offset, limit, lineNumbers }) => {
    const program = Effect.gen(function* () {
      const indexer = yield* Indexer
      const content = yield* indexer.readFile(repo, path, {
        offset: offset ?? 1,
        limit,
        lineNumbers: lineNumbers ?? true
      })
      
      return {
        repo: content.repo,
        path: content.path,
        content: content.content,
        totalLines: content.totalLines,
        startLine: content.startLine,
        endLine: content.endLine
      }
    })

    const result = await runtime.runPromise(program)
    
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  }
)

// Register grep tool
server.registerTool(
  "grep",
  {
    description: "Find a regex pattern, such as a symbol, type or error message, in the files of the locally indexed repositories. Use it for exact matches; use search to find files by meaning. In a large repository, narrow it with path (one file or directory) or glob instead of reading a file in chunks.",
    inputSchema: {
      pattern: z.string().describe("Regular expression pattern to search for"),
      repo: z.string().optional().describe("Optional: limit search to a specific repository ID"),
      ignoreCase: z.boolean().optional().default(false).describe("Case insensitive search"),
      contextBefore: z.number().optional().default(0).describe("Number of lines to show before each match"),
      contextAfter: z.number().optional().default(0).describe("Number of lines to show after each match"),
      context: z.number().optional().describe("Number of lines to show before and after each match (overrides contextBefore and contextAfter)"),
      filesWithMatches: z.boolean().optional().default(false).describe("Only return filenames that contain matches"),
      count: z.boolean().optional().default(false).describe("Only return match counts per file"),
      fileType: z.string().optional().describe("Filter by file extension (e.g., 'ts' for TypeScript files)"),
      path: z.string().optional().describe("Only search this file, or the files under this directory (e.g., 'crates/editor/src/code_context_menus.rs' or 'crates/editor')"),
      glob: z.string().optional().describe("Only search files whose path or filename matches this glob (e.g., 'crates/editor/**/*.rs' or '*.md')"),
      exclude: z.string().optional().describe("Skip files whose path or filename matches this glob (e.g., '**/*.test.ts')"),
      limit: z.number().optional().default(100).describe("Maximum number of output lines")
    }
  },
  async ({
    pattern,
    repo,
    ignoreCase,
    contextBefore,
    contextAfter,
    context,
    filesWithMatches,
    count,
    fileType,
    path,
    glob,
    exclude,
    limit
  }) => {
    const program = Effect.gen(function* () {
      const indexer = yield* Indexer
      
      // If context is provided, use it for both before and after
      const contextVal = context ?? undefined
      const before = contextVal ?? (contextBefore ?? 0)
      const after = contextVal ?? (contextAfter ?? 0)
      
      const results = yield* indexer.grepPattern(pattern, {
        repo,
        ignoreCase: ignoreCase ?? false,
        contextBefore: before,
        contextAfter: after,
        filesWithMatches: filesWithMatches ?? false,
        count: count ?? false,
        fileType,
        path,
        glob,
        exclude,
        limit: limit ?? 100
      })
      
      return results.map((result) => ({
        repo: result.repo,
        path: result.path,
        matchCount: result.matchCount,
        matches: result.matches.map((match) => ({
          lineNumber: match.lineNumber,
          content: match.content,
          isMatch: match.isMatch
        }))
      }))
    })

    const result = await runtime.runPromise(program)
    
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  }
)

// Connect to stdio transport
const transport = new StdioServerTransport()
await server.connect(transport)

// Handle graceful shutdown
const shutdown = async () => {
  await server.close()
  await runtime.dispose()
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
