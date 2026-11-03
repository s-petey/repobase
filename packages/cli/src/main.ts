#!/usr/bin/env -S LANCEDB_LOG=error bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Layer, Option, Ref } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import {
  RepobaseEngine,
  RepobaseEngineLayer,
  GitClientLayer,
  RepoStoreLayer,
  IndexerLayer,
  CloudSync,
  CloudSyncLayer,
  Indexer,
  JobProgressLayer,
  JobRunnerLayer,
  JobStoreLayer,
  defaultDefinitionsConfig,
  fileLoggerLayer,
  layerInProcessWorkers,
  logPath,
  makeJobDefinitions,
  needsReindex,
  telemetryLayer,
  splitRepoPath,
  type RepoConfig,
  type FileInfo,
  type GrepResult
} from "@repobase/engine"
import {
  CliExit,
  formatDate,
  handleAdd,
  handleReindex,
  handleRemove,
  handleSync,
  outdatedRepoIds,
  printError,
  reportError,
  shortCommit
} from "./commands.js"

// ============================================================================
// Formatters
// ============================================================================
const formatRepo = (repo: RepoConfig): string => {
  const mode =
    repo.mode._tag === "tracking"
      ? `tracking: ${repo.mode.branch}`
      : `pinned: ${repo.mode.ref}`
  const lastSync = Option.match(repo.lastSyncedAt, {
    onNone: () => "never",
    onSome: formatDate
  })
  const commit = shortCommit(repo)
  const cloudStatus = repo.cloudEnabled ? "☁️ enabled" : "local only"
  const lastPush = repo.lastPushedAt
    ? Option.match(repo.lastPushedAt, {
        onNone: () => "never",
        onSome: formatDate
      })
    : "never"
  const index = needsReindex(repo)
    ? `\n    Index: old format, unavailable until re-indexed (run 'repobase reindex ${repo.id}')`
    : ""
  return `  ${repo.id}
    URL: ${repo.url}
    Mode: ${mode}
    Last sync: ${lastSync}
    Commit: ${commit}
    Cloud: ${cloudStatus}${repo.cloudEnabled ? ` (last push: ${lastPush})` : ""}${index}`
}

const noteUnavailable = (repo?: string) =>
  outdatedRepoIds.pipe(
    Effect.map((ids) => ids.filter((id) => !repo || id === repo)),
    Effect.flatMap((ids) =>
      ids.length === 0
        ? Effect.void
        : Console.error(
            `Note: ${ids.length === 1 ? `${ids[0]} is` : `${ids.length} repositories are`} unavailable until re-indexed; run 'repobase reindex'\n`
          )
    )
  )

// ============================================================================
// Commands
// ============================================================================

// --- ADD COMMAND ---
const urlArg = Argument.String("url").pipe(
  Argument.withDescription("GitHub repository URL")
)

const branchOption = Flag.String("branch").pipe(
  Flag.withAlias("b"),
  Flag.withDescription("Branch to track (default: the repository's default branch)"),
  Flag.optional
)

const pinOption = Flag.String("pin").pipe(
  Flag.withAlias("p"),
  Flag.withDescription("Pin to specific tag or commit SHA"),
  Flag.optional
)

const addCommand = Command.make(
  "add",
  { url: urlArg, branch: branchOption, pin: pinOption },
  handleAdd
).pipe(Command.withDescription("Add a GitHub repository"))

// --- LIST COMMAND ---
const listCommand = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const engine = yield* RepobaseEngine
    const repos = yield* engine.listRepos()
    if (repos.length === 0) {
      yield* Console.log("No repositories configured.")
      yield* Console.log("Use 'repobase add <url>' to add one.")
      return
    }
    yield* Console.log(`Repositories (${repos.length}):\n`)
    for (const repo of repos) {
      yield* Console.log(formatRepo(repo))
      yield* Console.log("")
    }
  }).pipe(
    Effect.catch((error) =>
      reportError(error)
    )
  )
).pipe(Command.withDescription("List all repositories"))

// --- SYNC COMMAND ---
const repoIdArg = Argument.String("id").pipe(
  Argument.withDescription("Repository ID to sync"),
  Argument.optional
)

const syncCommand = Command.make("sync", { id: repoIdArg }, ({ id }) => handleSync(id)).pipe(
  Command.withDescription("Sync repositories (all if no ID specified)")
)

// --- REINDEX COMMAND ---
const reindexIdArg = Argument.String("id").pipe(
  Argument.withDescription("Repository ID to re-index (default: every repository in an old index format)"),
  Argument.optional
)

const reindexCommand = Command.make("reindex", { id: reindexIdArg }, ({ id }) => handleReindex(id)).pipe(
  Command.withDescription("Re-index repositories in the current index format (every outdated one if no ID specified)")
)

// --- REMOVE COMMAND ---
const removeIdArg = Argument.String("id").pipe(
  Argument.withDescription("Repository ID to remove")
)

const removeCommand = Command.make("remove", { id: removeIdArg }, ({ id }) => handleRemove(id)).pipe(
  Command.withDescription("Remove a repository")
)

// ============================================================================
// Cloud Commands
// ============================================================================

// --- CLOUD LOGIN COMMAND ---
const endpointOption = Flag.String("endpoint").pipe(
  Flag.withAlias("e"),
  Flag.withDescription("Cloud API endpoint"),
  Flag.withDefault("https://repobase-api.workers.dev")
)

const userIdOption = Flag.String("user").pipe(
  Flag.withAlias("u"),
  Flag.withDescription("User ID")
)

const apiKeyOption = Flag.String("key").pipe(
  Flag.withAlias("k"),
  Flag.withDescription("API key")
)

const cloudLoginCommand = Command.make(
  "login",
  { endpoint: endpointOption, userId: userIdOption, apiKey: apiKeyOption },
  ({ endpoint, userId, apiKey }) =>
    Effect.gen(function* () {
      const cloud = yield* CloudSync
      yield* cloud.configure({ userId, apiKey, endpoint })
      yield* Console.log(`✓ Cloud sync configured`)
      yield* Console.log(`  User: ${userId}`)
      yield* Console.log(`  Endpoint: ${endpoint}`)
    }).pipe(
      Effect.catch((error) =>
        reportError(error)
      )
    )
).pipe(Command.withDescription("Configure cloud sync credentials"))

// --- CLOUD LOGOUT COMMAND ---
const cloudLogoutCommand = Command.make("logout", {}, () =>
  Effect.gen(function* () {
    const cloud = yield* CloudSync
    yield* cloud.clearConfig()
    yield* Console.log(`✓ Cloud sync configuration cleared`)
  }).pipe(
    Effect.catch((error) =>
      reportError(error)
    )
  )
).pipe(Command.withDescription("Clear cloud sync configuration"))

// --- CLOUD STATUS COMMAND ---
const cloudStatusCommand = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const cloud = yield* CloudSync
    const configured = yield* cloud.isConfigured()

    if (!configured) {
      yield* Console.log("Cloud sync is not configured.")
      yield* Console.log("Run 'repobase cloud login' to configure.")
      return
    }

    const config = yield* cloud.getConfig()
    yield* Console.log(`Cloud sync configured:`)
    yield* Console.log(`  User: ${config.userId}`)
    yield* Console.log(`  Endpoint: ${config.endpoint}`)
    yield* Console.log("")

    const enabledRepos = yield* cloud.listCloudEnabled()
    if (enabledRepos.length === 0) {
      yield* Console.log("No repos have cloud sync enabled.")
      yield* Console.log("Use 'repobase cloud enable <repo-id>' to enable.")
    } else {
      yield* Console.log(`Cloud-enabled repos (${enabledRepos.length}):`)
      for (const repo of enabledRepos) {
        const status = yield* cloud.getStatus(repo.id)
        const syncIcon = status.inSync ? "✓" : "⏳"
        yield* Console.log(`  ${syncIcon} ${repo.id}`)
      }
    }
  }).pipe(
    Effect.catch((error) =>
      reportError(error)
    )
  )
).pipe(Command.withDescription("Show cloud sync status"))

// --- CLOUD ENABLE COMMAND ---
const cloudEnableIdArg = Argument.String("id").pipe(
  Argument.withDescription("Repository ID to enable cloud sync for")
)

const cloudEnableCommand = Command.make(
  "enable",
  { id: cloudEnableIdArg },
  ({ id }) =>
    Effect.gen(function* () {
      const cloud = yield* CloudSync
      yield* cloud.enableRepo(id)
      yield* Console.log(`✓ Cloud sync enabled for: ${id}`)
    }).pipe(
      Effect.catch((error) =>
        reportError(error)
      )
    )
).pipe(Command.withDescription("Enable cloud sync for a repository"))

// --- CLOUD DISABLE COMMAND ---
const cloudDisableIdArg = Argument.String("id").pipe(
  Argument.withDescription("Repository ID to disable cloud sync for")
)

const cloudDisableCommand = Command.make(
  "disable",
  { id: cloudDisableIdArg },
  ({ id }) =>
    Effect.gen(function* () {
      const cloud = yield* CloudSync
      yield* cloud.disableRepo(id)
      yield* Console.log(`✓ Cloud sync disabled for: ${id}`)
    }).pipe(
      Effect.catch((error) =>
        reportError(error)
      )
    )
).pipe(Command.withDescription("Disable cloud sync for a repository"))

// --- CLOUD PUSH COMMAND ---
const cloudPushIdArg = Argument.String("id").pipe(
  Argument.withDescription("Repository ID to push (omit for all enabled repos)"),
  Argument.optional
)

const cloudPushCommand = Command.make(
  "push",
  { id: cloudPushIdArg },
  ({ id }) =>
    Effect.gen(function* () {
      const cloud = yield* CloudSync
      const results = yield* Option.match(id, {
        onSome: (repoId) => cloud.push(repoId).pipe(Effect.map((r) => [r])),
        onNone: () => cloud.pushAll()
      })

      if (results.length === 0) {
        yield* Console.log("No repos to push.")
        yield* Console.log("Enable cloud sync for repos with 'repobase cloud enable <id>'")
        return
      }

      for (const result of results) {
        yield* Console.log(
          `✓ ${result.repoId}: pushed ${result.filesUploaded} files (${result.durationMs}ms)`
        )
      }
    }).pipe(
      Effect.catch((error) =>
        reportError(error)
      )
    )
).pipe(Command.withDescription("Push repos to cloud"))

// --- CLOUD PULL COMMAND ---
const cloudPullCommand = Command.make("pull", {}, () =>
  Effect.gen(function* () {
    const cloud = yield* CloudSync
    const result = yield* cloud.pull()
    yield* Console.log(
      `✓ Pulled ${result.filesDownloaded} files (${result.durationMs}ms)`
    )
  }).pipe(
    Effect.catch((error) =>
      reportError(error)
    )
  )
).pipe(Command.withDescription("Pull index from cloud (for new device setup)"))

// --- CLOUD PARENT COMMAND ---
const cloudCommand = Command.make("cloud").pipe(
  Command.withDescription("Manage cloud sync"),
  Command.withSubcommands([
    cloudLoginCommand,
    cloudLogoutCommand,
    cloudStatusCommand,
    cloudEnableCommand,
    cloudDisableCommand,
    cloudPushCommand,
    cloudPullCommand
  ])
)

// ============================================================================
// File Exploration Commands
// ============================================================================

// --- SEARCH COMMAND ---
const searchQueryArg = Argument.String("query").pipe(
  Argument.withDescription("Search query")
)

const searchRepoOption = Flag.String("repo").pipe(
  Flag.withAlias("r"),
  Flag.withDescription("Filter to specific repository"),
  Flag.optional
)

const searchLimitOption = Flag.Int("limit").pipe(
  Flag.withAlias("l"),
  Flag.withDescription("Maximum results (default: 20)"),
  Flag.withDefault(20)
)

const semanticOption = Flag.Boolean("semantic").pipe(
  Flag.withAlias("s"),
  Flag.withDescription("Use semantic search"),
  Flag.withDefault(false)
)

const hybridOption = Flag.Boolean("hybrid").pipe(
  Flag.withAlias("H"),
  Flag.withDescription("Use hybrid search (FTS + semantic)"),
  Flag.withDefault(false)
)

const searchCommand = Command.make(
  "search",
  {
    query: searchQueryArg,
    repo: searchRepoOption,
    limit: searchLimitOption,
    semantic: semanticOption,
    hybrid: hybridOption
  },
  ({ query, repo, limit, semantic, hybrid }) =>
    Effect.gen(function* () {
      const options = {
        repo: Option.getOrUndefined(repo),
        limit
      }

      // Determine search mode
      const indexer = yield* Indexer
      const results = yield* (hybrid
        ? indexer.searchHybrid(query, options)
        : semantic
          ? indexer.searchSemantic(query, options)
          : indexer.searchKeyword(query, options))

      yield* noteUnavailable(options.repo)

      if (results.length === 0) {
        yield* Console.log("No results found.")
        return
      }

      yield* Console.log(`Found ${results.length} result(s):\n`)
      for (const result of results) {
        const lines = result.startLine === undefined ? "" : `:${result.startLine}-${result.endLine}`
        yield* Console.log(`${result.repo}/${result.path}${lines}`)
        yield* Console.log(`  Score: ${result.score.toFixed(3)}`)
        if (result.snippet) {
          const snippet = result.snippet.replace(/\n/g, " ").slice(0, 100)
          yield* Console.log(`  ${snippet}...`)
        }
        yield* Console.log("")
      }
    }).pipe(
      Effect.catch((error) =>
        reportError(error)
      )
    )
).pipe(Command.withDescription("Search across indexed repositories"))

// --- LS COMMAND ---
const lsPathArg = Argument.String("path").pipe(
  Argument.withDescription("Repository or path (e.g., 'owner/name' or 'owner/name/src')"),
  Argument.optional
)

const formatFileInfo = (file: FileInfo): string => {
  const icon = file.isDirectory ? "📁" : "📄"
  const size = file.size ? ` ${formatSize(file.size)}` : ""
  return `${icon} ${file.filename}${size}`
}

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

const lsCommand = Command.make("ls", { path: lsPathArg }, ({ path }) =>
  Effect.gen(function* () {
    const engine = yield* RepobaseEngine
    let repo: string | undefined
    let subPath: string | undefined
    if (Option.isSome(path)) {
      const ids = (yield* engine.listRepos()).map((r) => r.id)
      const split = splitRepoPath(ids, path.value)
      if (split === undefined) {
        return yield* printError(`No indexed repository matches ${path.value}; 'repobase list' shows them`)
      }
      repo = split.repo
      subPath = split.path || undefined
    }

    const indexer = yield* Indexer
    const files = yield* indexer.listFiles({ repo, path: subPath })
    yield* noteUnavailable(repo)

    if (files.length === 0) {
      yield* Console.log("No files found.")
      return
    }

    if (!repo) {
      yield* Console.log(`Repositories (${files.length}):\n`)
    } else {
      const displayPath = subPath ? `${repo}/${subPath}` : repo
      yield* Console.log(`${displayPath} (${files.length} items):\n`)
    }

    for (const file of files) {
      yield* Console.log(formatFileInfo(file))
    }
  }).pipe(
    Effect.catch((error) =>
      reportError(error)
    )
  )
).pipe(Command.withDescription("List files and directories"))

// --- GLOB COMMAND ---
const globPatternArg = Argument.String("pattern").pipe(
  Argument.withDescription("Glob pattern (e.g., '*.ts', '**/test/**')")
)

const globRepoOption = Flag.String("repo").pipe(
  Flag.withAlias("r"),
  Flag.withDescription("Filter to specific repository"),
  Flag.optional
)

const globLimitOption = Flag.Int("limit").pipe(
  Flag.withAlias("l"),
  Flag.withDescription("Maximum results (default: 50)"),
  Flag.withDefault(50)
)

const globCommand = Command.make(
  "glob",
  { pattern: globPatternArg, repo: globRepoOption, limit: globLimitOption },
  ({ pattern, repo, limit }) =>
    Effect.gen(function* () {
      const indexer = yield* Indexer
      const files = yield* indexer.globFiles(pattern, {
        repo: Option.getOrUndefined(repo),
        limit
      })
      yield* noteUnavailable(Option.getOrUndefined(repo))

      if (files.length === 0) {
        yield* Console.log("No files matched.")
        return
      }

      yield* Console.log(`Found ${files.length} file(s):\n`)
      for (const file of files) {
        yield* Console.log(`${file.repo}/${file.path}`)
      }
    }).pipe(
      Effect.catch((error) =>
        reportError(error)
      )
    )
).pipe(Command.withDescription("Find files matching a glob pattern"))

// --- READ COMMAND ---
const readPathArg = Argument.String("path").pipe(
  Argument.withDescription("File path (e.g., 'owner/name/src/main.ts')")
)

const readOffsetOption = Flag.Int("offset").pipe(
  Flag.withAlias("o"),
  Flag.withDescription("Start line (1-based)"),
  Flag.withDefault(1)
)

const readLimitOption = Flag.Int("lines").pipe(
  Flag.withAlias("L"),
  Flag.withDescription("Number of lines to read"),
  Flag.optional
)

const noLineNumbersOption = Flag.Boolean("no-line-numbers").pipe(
  Flag.withAlias("n"),
  Flag.withDescription("Omit line numbers"),
  Flag.withDefault(false)
)

const readCommand = Command.make(
  "read",
  {
    path: readPathArg,
    offset: readOffsetOption,
    lines: readLimitOption,
    noLineNumbers: noLineNumbersOption
  },
  ({ path, offset, lines, noLineNumbers }) =>
    Effect.gen(function* () {
      const engine = yield* RepobaseEngine
      const split = splitRepoPath((yield* engine.listRepos()).map((r) => r.id), path)
      if (split === undefined || split.path === "") {
        return yield* printError("Path must be in format: owner/name/path/to/file, for an indexed repository")
      }
      const { repo, path: filePath } = split

      if ((yield* outdatedRepoIds).includes(repo)) {
        return yield* printError(`${repo} is unavailable until re-indexed; run 'repobase reindex ${repo}'`)
      }

      const indexer = yield* Indexer
      const result = yield* indexer.readFile(repo, filePath, {
        offset,
        limit: Option.getOrUndefined(lines),
        lineNumbers: !noLineNumbers
      })

      yield* Console.log(
        `File: ${result.repo}/${result.path} (lines ${result.startLine}-${result.endLine} of ${result.totalLines})\n`
      )
      yield* Console.log(result.content)
    }).pipe(
      Effect.catch((error) =>
        reportError(error)
      )
    )
).pipe(Command.withDescription("Read file contents"))

// --- GREP COMMAND ---
const grepPatternArg = Argument.String("pattern").pipe(
  Argument.withDescription("Regular expression pattern")
)

const grepRepoOption = Flag.String("repo").pipe(
  Flag.withAlias("r"),
  Flag.withDescription("Filter to specific repository"),
  Flag.optional
)

const grepIgnoreCaseOption = Flag.Boolean("ignore-case").pipe(
  Flag.withAlias("i"),
  Flag.withDescription("Case insensitive search"),
  Flag.withDefault(false)
)

const grepContextBeforeOption = Flag.Int("before").pipe(
  Flag.withAlias("B"),
  Flag.withDescription("Lines before match"),
  Flag.withDefault(0)
)

const grepContextAfterOption = Flag.Int("after").pipe(
  Flag.withAlias("A"),
  Flag.withDescription("Lines after match"),
  Flag.withDefault(0)
)

const grepContextOption = Flag.Int("context").pipe(
  Flag.withAlias("C"),
  Flag.withDescription("Lines before and after match"),
  Flag.optional
)

const grepFilesOnlyOption = Flag.Boolean("files-with-matches").pipe(
  Flag.withAlias("l"),
  Flag.withDescription("Only show filenames"),
  Flag.withDefault(false)
)

const grepCountOption = Flag.Boolean("count").pipe(
  Flag.withAlias("c"),
  Flag.withDescription("Only show match counts"),
  Flag.withDefault(false)
)

const grepTypeOption = Flag.String("type").pipe(
  Flag.withAlias("t"),
  Flag.withDescription("Filter by file extension (e.g., 'ts')"),
  Flag.optional
)

const grepPathOption = Flag.String("path").pipe(
  Flag.withAlias("p"),
  Flag.withDescription("Only search this file, or the files under this directory"),
  Flag.optional
)

const grepGlobOption = Flag.String("glob").pipe(
  Flag.withAlias("g"),
  Flag.withDescription("Only search files matching a glob (e.g., 'src/**/*.ts')"),
  Flag.optional
)

const grepExcludeOption = Flag.String("exclude").pipe(
  Flag.withAlias("X"),
  Flag.withDescription("Skip files matching a glob (e.g., '**/*.test.ts')"),
  Flag.optional
)

const grepLimitOption = Flag.Int("limit").pipe(
  Flag.withDescription("Limit output lines (default: 100)"),
  Flag.withDefault(100)
)

const formatGrepResult = (result: GrepResult): string[] => {
  const lines: string[] = []
  lines.push(`\n${result.repo}/${result.path} (${result.matchCount} matches)`)

  for (const match of result.matches) {
    const prefix = match.isMatch ? ":" : "-"
    lines.push(`${String(match.lineNumber).padStart(4)}${prefix} ${match.content}`)
  }

  return lines
}

const grepCommand = Command.make(
  "grep",
  {
    pattern: grepPatternArg,
    repo: grepRepoOption,
    ignoreCase: grepIgnoreCaseOption,
    before: grepContextBeforeOption,
    after: grepContextAfterOption,
    context: grepContextOption,
    filesOnly: grepFilesOnlyOption,
    count: grepCountOption,
    type: grepTypeOption,
    path: grepPathOption,
    glob: grepGlobOption,
    exclude: grepExcludeOption,
    limit: grepLimitOption
  },
  ({
    pattern,
    repo,
    ignoreCase,
    before,
    after,
    context,
    filesOnly,
    count,
    type,
    path,
    glob,
    exclude,
    limit
  }) =>
    Effect.gen(function* () {
      // If -C is provided, use it for both before and after
      const contextVal = Option.getOrUndefined(context)
      const contextBefore = contextVal ?? before
      const contextAfter = contextVal ?? after

      const indexer = yield* Indexer
      const results = yield* indexer.grepPattern(pattern, {
        repo: Option.getOrUndefined(repo),
        ignoreCase,
        contextBefore,
        contextAfter,
        filesWithMatches: filesOnly,
        count,
        fileType: Option.getOrUndefined(type),
        path: Option.getOrUndefined(path),
        glob: Option.getOrUndefined(glob),
        exclude: Option.getOrUndefined(exclude),
        limit
      })
      yield* noteUnavailable(Option.getOrUndefined(repo))

      if (results.length === 0) {
        yield* Console.log("No matches found.")
        return
      }

      const totalMatches = results.reduce((sum, r) => sum + r.matchCount, 0)
      yield* Console.log(
        `Found ${totalMatches} match(es) in ${results.length} file(s):`
      )

      for (const result of results) {
        if (filesOnly || count) {
          yield* Console.log(`${result.repo}/${result.path}: ${result.matchCount}`)
        } else {
          const lines = formatGrepResult(result)
          for (const line of lines) {
            yield* Console.log(line)
          }
        }
      }
    }).pipe(
      Effect.catch((error) =>
        reportError(error)
      )
    )
).pipe(Command.withDescription("Search for regex pattern in file contents"))

// ============================================================================
// Root Command
// ============================================================================
const rootCommand = Command.make("repobase").pipe(
  Command.withDescription("Manage local GitHub repository cache"),
  Command.withSubcommands([
    addCommand,
    listCommand,
    syncCommand,
    reindexCommand,
    removeCommand,
    cloudCommand,
    searchCommand,
    lsCommand,
    globCommand,
    readCommand,
    grepCommand
  ])
)

// ============================================================================
// CLI Setup and Run
// ============================================================================
const cli = Command.runWith(rootCommand, {
  version: "0.1.0"
})

// Layer composition
// BunServices.layer provides FileSystem, Path, ChildProcessSpawner, Terminal, etc.
const EngineLive = RepobaseEngineLayer.pipe(
  Layer.provide(GitClientLayer),
  Layer.provide(RepoStoreLayer),
  Layer.provide(IndexerLayer)
)

const CloudSyncLive = CloudSyncLayer.pipe(Layer.provide(RepoStoreLayer))

const JobsLive = JobRunnerLayer(makeJobDefinitions({ ...defaultDefinitionsConfig(), indexingConcurrency: 1 }), {
  concurrency: 1,
  processName: "cli"
}).pipe(
  Layer.provideMerge(Layer.mergeAll(layerInProcessWorkers, JobProgressLayer)),
  Layer.provideMerge(Layer.mergeAll(JobStoreLayer, RepoStoreLayer)),
  Layer.provide(Layer.mergeAll(GitClientLayer, IndexerLayer))
)

const AppLayer = Layer.mergeAll(EngineLive, CloudSyncLive, IndexerLayer, JobsLive).pipe(
  Layer.provideMerge(telemetryLayer("repobase-cli")),
  Layer.provideMerge(fileLoggerLayer(logPath("cli")))
)

// Run the CLI - provide AppLayer then BunServices (platform layer)
cli(process.argv.slice(2)).pipe(
  Effect.andThen(CliExit.use(Ref.get)),
  Effect.tap((code) =>
    Effect.sync(() => {
      process.exitCode = code
    })
  ),
  Effect.provide(CliExit.layer),
  Effect.provide(AppLayer),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain
)
