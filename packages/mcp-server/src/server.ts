import { McpServer } from "@modelcontextprotocol/server"
import { DateTime, Effect, type ManagedRuntime, Option, Schema } from "effect"
import { Indexer, needsReindex, RepobaseEngine, type SearchMode } from "@repobase/engine"
import { reindexNotice, serverInstructions } from "./instructions.js"

export type Services = RepobaseEngine | Indexer

// Validation for the SDK and JSON Schema (with descriptions) for clients
const toolInput = <A, I>(schema: Schema.Codec<A, I>) =>
  Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(schema))

const SearchInput = toolInput(
  Schema.Struct({
    query: Schema.String.annotate({ description: "The search query" }),
    mode: Schema.optionalKey(
      Schema.Literals(["keyword", "semantic", "hybrid"]).annotate({
        description: "Search mode: keyword (fast text search), semantic (meaning-based), or hybrid (combines both)",
        default: "hybrid"
      })
    ),
    limit: Schema.optionalKey(Schema.Int.annotate({ description: "Maximum number of results to return", default: 20 })),
    repo: Schema.optionalKey(Schema.String.annotate({ description: "Optional: limit search to a specific repository ID" })),
    path: Schema.optionalKey(
      Schema.String.annotate({
        description: "Optional: limit search to this file, or the files under this directory (e.g., 'crates/editor')"
      })
    ),
    glob: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "Optional: limit search to files whose path or filename matches this glob (e.g., 'crates/*/src/**/*.rs' or '*.md')"
      })
    )
  })
)

const ListFilesInput = toolInput(
  Schema.Struct({
    repo: Schema.optionalKey(
      Schema.String.annotate({ description: "Repository ID to list files from (omit to list all repos)" })
    ),
    path: Schema.optionalKey(
      Schema.String.annotate({ description: "Directory path within the repository (e.g., 'src' or 'src/components')" })
    )
  })
)

const GlobFilesInput = toolInput(
  Schema.Struct({
    pattern: Schema.String.annotate({ description: "Glob pattern (e.g., '*.ts', '**/test/**', 'src/**/*.tsx')" }),
    repo: Schema.optionalKey(Schema.String.annotate({ description: "Optional: limit search to a specific repository ID" })),
    limit: Schema.optionalKey(Schema.Int.annotate({ description: "Maximum number of results to return", default: 50 }))
  })
)

const ReadFileInput = toolInput(
  Schema.Struct({
    repo: Schema.String.annotate({ description: "Repository ID" }),
    path: Schema.String.annotate({ description: "File path within the repository (e.g., 'src/main.ts')" }),
    offset: Schema.optionalKey(
      Schema.Int.annotate({ description: "Start line number (1-based, default: 1)", default: 1 })
    ),
    limit: Schema.optionalKey(
      Schema.Int.annotate({ description: "Number of lines to read (omit to read entire file)" })
    ),
    lineNumbers: Schema.optionalKey(
      Schema.Boolean.annotate({ description: "Include line numbers in output", default: true })
    )
  })
)

const GrepInput = toolInput(
  Schema.Struct({
    pattern: Schema.String.annotate({ description: "Regular expression pattern to search for" }),
    repo: Schema.optionalKey(Schema.String.annotate({ description: "Optional: limit search to a specific repository ID" })),
    ignoreCase: Schema.optionalKey(Schema.Boolean.annotate({ description: "Case insensitive search", default: false })),
    contextBefore: Schema.optionalKey(
      Schema.Int.annotate({ description: "Number of lines to show before each match", default: 0 })
    ),
    contextAfter: Schema.optionalKey(
      Schema.Int.annotate({ description: "Number of lines to show after each match", default: 0 })
    ),
    context: Schema.optionalKey(
      Schema.Int.annotate({
        description:
          "Number of lines to show before and after each match (overrides contextBefore and contextAfter)"
      })
    ),
    filesWithMatches: Schema.optionalKey(
      Schema.Boolean.annotate({ description: "Only return filenames that contain matches", default: false })
    ),
    count: Schema.optionalKey(
      Schema.Boolean.annotate({ description: "Only return match counts per file", default: false })
    ),
    fileType: Schema.optionalKey(
      Schema.String.annotate({ description: "Filter by file extension (e.g., 'ts' for TypeScript files)" })
    ),
    path: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "Only search this file, or the files under this directory (e.g., 'crates/editor/src/code_context_menus.rs' or 'crates/editor')"
      })
    ),
    glob: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "Only search files whose path or filename matches this glob (e.g., 'crates/editor/**/*.rs' or '*.md')"
      })
    ),
    exclude: Schema.optionalKey(
      Schema.String.annotate({
        description: "Skip files whose path or filename matches this glob (e.g., '**/*.test.ts')"
      })
    ),
    limit: Schema.optionalKey(Schema.Int.annotate({ description: "Maximum number of output lines", default: 100 }))
  })
)

const text = (value: unknown) => ({ type: "text" as const, text: JSON.stringify(value, null, 2) })

/**
 * The repobase MCP server with its tools, running each tool's work on `runtime`.
 * Connecting it to a transport is up to the caller.
 */
export const makeServer = async (runtime: ManagedRuntime.ManagedRuntime<Services, unknown>) => {
  const runTool = <A, E>(tool: string, program: Effect.Effect<A, E, Services>) =>
    runtime.runPromise(program.pipe(Effect.withSpan(`mcp.${tool}`)))

  // The instructions name the repos indexed right now; each client session
  // starts its own server, so they're current for that session
  const repos = await runtime.runPromise(
    RepobaseEngine.use((engine) => engine.listRepos()).pipe(Effect.orElseSucceed(() => []))
  )

  // A content block to put before a tool's result
  const unavailableNotice = (repo?: string) =>
    RepobaseEngine.use((engine) => engine.listRepos()).pipe(
      Effect.map((all) => all.filter((r) => needsReindex(r) && (!repo || r.id === repo)).map((r) => r.id)),
      Effect.map((ids) => (ids.length > 0 ? [{ type: "text" as const, text: `⚠ ${reindexNotice(ids)}` }] : []))
    )

  const server = new McpServer({ name: "repobase-mcp", version: "0.1.0" }, { instructions: serverInstructions(repos) })

  server.registerTool(
    "list_repos",
    {
      description:
        "List the repositories indexed locally in repobase, with when each was last synced. Check it when you're unsure whether a library or repo is available here."
    },
    async () => {
      const result = await runTool(
        "list_repos",
        RepobaseEngine.use((engine) => engine.listRepos()).pipe(
          Effect.map((all) =>
            all.map((repo) => ({
              id: repo.id,
              url: repo.url,
              localPath: repo.localPath,
              lastSyncedAt: Option.match(repo.lastSyncedAt, { onNone: () => null, onSome: DateTime.formatIso }),
              addedAt: DateTime.formatIso(repo.addedAt),
              // Search finds nothing in it until it's re-indexed in the current index format
              needsReindex: needsReindex(repo)
            }))
          )
        )
      )
      return { content: [text(result)] }
    }
  )

  server.registerTool(
    "search",
    {
      description:
        "Search across all locally indexed repositories (keyword, semantic or hybrid). Use it first for questions about any of those repos: it's faster and more exact than web search. Each result's startLine and endLine are the lines that matched best, so read_file can read just that part (offset: startLine).",
      inputSchema: SearchInput
    },
    async ({ query, mode = "hybrid", limit = 20, repo, path, glob }) => {
      const { notice, results } = await runTool(
        "search",
        Effect.gen(function* () {
          const engine = yield* RepobaseEngine
          const results = yield* engine.search(query, mode as SearchMode, { limit, repo, path, glob })
          return {
            notice: yield* unavailableNotice(repo),
            results: results.map((result) => ({
              repo: result.repo,
              path: result.path,
              filename: result.filename,
              score: result.score,
              snippet: result.snippet,
              startLine: result.startLine,
              endLine: result.endLine
            }))
          }
        })
      )
      return { content: [...notice, text(results)] }
    }
  )

  server.registerTool(
    "list_files",
    {
      description: "List files and directories of a locally indexed repository, or of a directory in it",
      inputSchema: ListFilesInput
    },
    async ({ repo, path }) => {
      const { notice, result } = await runTool(
        "list_files",
        Effect.gen(function* () {
          const indexer = yield* Indexer
          const files = yield* indexer.listFiles({ repo, path })
          return {
            notice: yield* unavailableNotice(repo),
            result: files.map((file) => ({
              repo: file.repo,
              path: file.path,
              filename: file.filename,
              isDirectory: file.isDirectory,
              size: file.size ?? null,
              mtime: file.mtime ? DateTime.formatIso(file.mtime) : null
            }))
          }
        })
      )
      return { content: [...notice, text(result)] }
    }
  )

  server.registerTool(
    "glob_files",
    {
      description: "Find files matching a glob pattern in the locally indexed repositories",
      inputSchema: GlobFilesInput
    },
    async ({ pattern, repo, limit = 50 }) => {
      const { notice, result } = await runTool(
        "glob_files",
        Effect.gen(function* () {
          const indexer = yield* Indexer
          const files = yield* indexer.globFiles(pattern, { repo, limit })
          return {
            notice: yield* unavailableNotice(repo),
            result: files.map((file) => ({
              repo: file.repo,
              path: file.path,
              filename: file.filename,
              isDirectory: file.isDirectory,
              size: file.size ?? null,
              mtime: file.mtime ? DateTime.formatIso(file.mtime) : null
            }))
          }
        })
      )
      return { content: [...notice, text(result)] }
    }
  )

  server.registerTool(
    "read_file",
    {
      description: "Read a file from a locally indexed repository",
      inputSchema: ReadFileInput
    },
    async ({ repo, path, offset = 1, limit, lineNumbers = true }) => {
      // Unavailable until re-indexed: say why, rather than that the file isn't there
      const notice = await runtime.runPromise(unavailableNotice(repo))
      if (notice.length > 0) return { content: notice, isError: true }

      const result = await runTool(
        "read_file",
        Effect.gen(function* () {
          const indexer = yield* Indexer
          const content = yield* indexer.readFile(repo, path, { offset, limit, lineNumbers })
          return {
            repo: content.repo,
            path: content.path,
            content: content.content,
            totalLines: content.totalLines,
            startLine: content.startLine,
            endLine: content.endLine
          }
        })
      )
      return { content: [text(result)] }
    }
  )

  server.registerTool(
    "grep",
    {
      description:
        "Find a regex pattern, such as a symbol, type or error message, in the files of the locally indexed repositories. Use it for exact matches; use search to find files by meaning. In a large repository, narrow it with path (one file or directory) or glob instead of reading a file in chunks.",
      inputSchema: GrepInput
    },
    async ({
      pattern,
      repo,
      ignoreCase = false,
      contextBefore = 0,
      contextAfter = 0,
      context,
      filesWithMatches = false,
      count = false,
      fileType,
      path,
      glob,
      exclude,
      limit = 100
    }) => {
      const { notice, result } = await runTool(
        "grep",
        Effect.gen(function* () {
          const indexer = yield* Indexer
          const results = yield* indexer.grepPattern(pattern, {
            repo,
            ignoreCase,
            // context, when given, sets both
            contextBefore: context ?? contextBefore,
            contextAfter: context ?? contextAfter,
            filesWithMatches,
            count,
            fileType,
            path,
            glob,
            exclude,
            limit
          })
          return {
            notice: yield* unavailableNotice(repo),
            result: results.map((result) => ({
              repo: result.repo,
              path: result.path,
              matchCount: result.matchCount,
              matches: result.matches.map((match) => ({
                lineNumber: match.lineNumber,
                content: match.content,
                isMatch: match.isMatch
              }))
            }))
          }
        })
      )
      return { content: [...notice, text(result)] }
    }
  )

  return server
}
