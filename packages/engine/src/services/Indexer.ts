import { Array as Arr, Clock, Context, DateTime, Duration, Effect, FileSystem, Layer, Option, PlatformError, Schedule, Schema, Semaphore, Stream, SubscriptionRef } from "effect"
import { IndexError, SearchError, FileNotFoundError, InvalidPatternError } from "../errors.js"
import type {
  FileChange,
  IndexBatchResult,
  IndexingProgress,
  IndexPlan,
  IndexPlanFile,
  IndexSummary,
  SearchMode,
  SearchResult
} from "../schemas.js"
import * as os from "os"
import * as crypto from "crypto"
import micromatch from "micromatch"
import { globToRegex } from "../glob.js"
import { chunkLines, splitLines } from "../chunk.js"
import type { Table } from "@lancedb/lancedb"
import { type EmbedderConfig, make as makeEmbedder } from "./Embedder.js"
import { make as makeIndexStore } from "./IndexStore.js"

// Configuration
const INDEX_DIR = `${os.homedir()}/.repobase/index`
// File-level queries read each file's first chunk
const FIRST_CHUNK = "chunk = 0"

/**
 * Searches fetch this many times `limit` chunks, so enough distinct files are
 * left after grouping chunks by file
 */
const CHUNKS_PER_RESULT = 5

// The table of index format 1 (one row per file). Nothing reads it: repos still
// on format 1 are unavailable until re-indexed. dropLegacyIndex removes it once
// no repo is on format 1, so until then the previous version still works.
const LEGACY_FILES_TABLE = "files"

/**
 * Files embedded and written per indexBatch call. Each batch is one LanceDB
 * write, and the unit a failed index job retries.
 */
export const INDEX_BATCH_SIZE = 50

const SLOW_FILE_MS = 5_000

// Max ids per `id IN (...)` delete, to keep the SQL predicate a sane size
const DELETE_CHUNK_SIZE = 500

// Default ignore patterns (node_modules, .git, binaries, etc.)
const DEFAULT_IGNORE_PATTERNS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/coverage/**",
  "**/__pycache__/**",
  "**/.venv/**",
  "**/venv/**",
  "**/target/**",
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.png",
  "**/*.gif",
  "**/*.ico",
  "**/*.svg",
  "**/*.webp",
  "**/*.mp4",
  "**/*.mp3",
  "**/*.wav",
  "**/*.ogg",
  "**/*.zip",
  "**/*.tar",
  "**/*.tar.gz",
  "**/*.rar",
  "**/*.7z",
  "**/*.wasm",
  "**/*.exe",
  "**/*.dll",
  "**/*.so",
  "**/*.dylib",
  "**/*.bin",
  "**/*.pdf",
  "**/*.doc",
  "**/*.docx",
  "**/*.lock",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map"
]

/**
 * Options for search operations
 */
export interface SearchOptions {
  /** Filter to specific repo */
  repo?: string
  /** Filter to any of these repos (ignored when empty) */
  repos?: ReadonlyArray<string>
  /** Max results (default: 20) */
  limit?: number
  /** Only this file, or files under this directory */
  path?: string
  /** Only files whose path matches this glob (or whose filename does, for a glob without `/`) */
  glob?: string
}

/**
 * Initial indexing progress state
 */
export const initialIndexingProgress: IndexingProgress = {
  phase: "scanning",
  filesProcessed: 0,
  totalFiles: 0
}

/**
 * Options for indexing operations
 */
export interface IndexOptions {
  force?: boolean // Force full re-index even if files haven't changed
  progressRef?: SubscriptionRef.SubscriptionRef<IndexingProgress>
}

/**
 * Options for indexing one batch of files
 */
export interface IndexBatchOptions {
  /** Called before each file in the batch is processed */
  readonly onFile?: (path: string) => Effect.Effect<void>
}

/**
 * Where the index lives and, for tests, how text is embedded
 */
export interface IndexerConfig extends EmbedderConfig {
  /** Defaults to ~/.repobase/index */
  readonly indexDir?: string
  /** Where repo clones are read from; defaults to ~/.repobase/repos */
  readonly reposDir?: string
}

/**
 * Information about a file or directory in the index
 */
export interface FileInfo {
  readonly repo: string
  readonly path: string
  readonly filename: string
  readonly isDirectory: boolean
  readonly size?: number
  readonly mtime?: DateTime.Utc
}

/**
 * File content with line range metadata
 */
export interface FileContent {
  readonly repo: string
  readonly path: string
  readonly content: string
  readonly totalLines: number
  readonly startLine: number
  readonly endLine: number
}

/**
 * A single grep match within a file (repo/path are in GrepResult)
 */
export interface GrepMatch {
  readonly lineNumber: number
  readonly content: string
  readonly isMatch: boolean // true for match lines, false for context lines
}

/**
 * Grep results for a single file
 */
export interface GrepResult {
  readonly repo: string
  readonly path: string
  readonly matches: readonly GrepMatch[]
  readonly matchCount: number
}

/**
 * Options for listing files
 */
export interface ListFilesOptions {
  readonly repo?: string
  readonly path?: string
  readonly ignore?: readonly string[]
}

/**
 * Options for glob file search
 */
export interface GlobOptions {
  readonly repo?: string
  readonly limit?: number
}

/**
 * Options for reading files
 */
export interface ReadFileOptions {
  readonly offset?: number // Start line (1-based, default: 1)
  readonly limit?: number // Number of lines to read
  readonly lineNumbers?: boolean // Include line numbers (default: true)
}

/**
 * Options for grep pattern search
 */
export interface GrepOptions {
  readonly repo?: string
  readonly ignoreCase?: boolean
  readonly contextBefore?: number // Lines before match (-B)
  readonly contextAfter?: number // Lines after match (-A)
  readonly filesWithMatches?: boolean // Only show filenames
  readonly count?: boolean // Only show match counts
  readonly fileType?: string // Filter by extension (e.g., "ts")
  readonly path?: string // Only this file, or files under this directory
  readonly glob?: string // Only files whose path or filename matches
  readonly exclude?: string // Skip files whose path or filename matches
  readonly limit?: number // Limit output lines
}

/**
 * Indexer service interface
 */
export interface IndexerService {
  // Indexing
  readonly indexRepo: (
    repoId: string,
    repoPath: string,
    options?: IndexOptions
  ) => Effect.Effect<IndexSummary, IndexError>
  readonly indexChanges: (
    repoId: string,
    repoPath: string,
    changes: ReadonlyArray<FileChange>
  ) => Effect.Effect<IndexSummary, IndexError>
  readonly removeIndex: (repoId: string) => Effect.Effect<void, IndexError>

  // Indexing building blocks: indexRepo/indexChanges are plan → deletePaths →
  // indexBatch per chunk → finalizeIndex. Each is safe to re-run.

  // Scan the whole repo and compare against indexed hashes
  readonly planFullIndex: (
    repoId: string,
    repoPath: string,
    options?: { readonly force?: boolean }
  ) => Effect.Effect<IndexPlan, IndexError>
  // Turn a git diff into a plan without scanning the repo
  readonly planChanges: (
    repoId: string,
    repoPath: string,
    changes: ReadonlyArray<FileChange>
  ) => Effect.Effect<IndexPlan, IndexError>
  // Remove files from the index
  readonly deletePaths: (
    repoId: string,
    paths: ReadonlyArray<string>
  ) => Effect.Effect<void, IndexError>
  // Read, embed and upsert files; writes the whole batch at once
  readonly indexBatch: (
    repoId: string,
    repoPath: string,
    files: ReadonlyArray<IndexPlanFile>,
    options?: IndexBatchOptions
  ) => Effect.Effect<IndexBatchResult, IndexError>
  // Compact the table and rebuild the full-text index
  readonly finalizeIndex: () => Effect.Effect<void, IndexError>
  // Drop the index format 1 table (see LEGACY_FILES_TABLE) once no repo is on it; false if it was already gone
  readonly dropLegacyIndex: () => Effect.Effect<boolean, IndexError>

  // Search
  readonly searchKeyword: (
    query: string,
    options?: SearchOptions
  ) => Effect.Effect<SearchResult[], SearchError>
  readonly searchSemantic: (
    query: string,
    options?: SearchOptions
  ) => Effect.Effect<SearchResult[], SearchError>
  readonly searchHybrid: (
    query: string,
    options?: SearchOptions
  ) => Effect.Effect<SearchResult[], SearchError>

  // File exploration - Discovery (DB queries)
  readonly listFiles: (
    options: ListFilesOptions
  ) => Effect.Effect<readonly FileInfo[], IndexError>

  readonly globFiles: (
    pattern: string,
    options?: GlobOptions
  ) => Effect.Effect<readonly FileInfo[], IndexError | InvalidPatternError>

  // File exploration - Content (DB verify + FS read)
  readonly readFile: (
    repo: string,
    filePath: string,
    options?: ReadFileOptions
  ) => Effect.Effect<FileContent, IndexError | FileNotFoundError>

  readonly grepPattern: (
    pattern: string,
    options?: GrepOptions
  ) => Effect.Effect<readonly GrepResult[], IndexError | InvalidPatternError>
}

/**
 * Indexer service tag
 */
export class Indexer extends Context.Service<Indexer, IndexerService>()(
  "@repobase/engine/Indexer"
) {}

/**
 * Check if a buffer contains binary data
 */
function isBinary(buffer: Uint8Array): boolean {
  const sample = buffer.slice(0, Math.min(buffer.length, 1024))
  let suspicious = 0
  for (const byte of sample) {
    if (byte === 0) return true
    if (byte < 7 || (byte > 13 && byte < 32) || byte === 255) suspicious++
  }
  return suspicious / sample.length > 0.3
}

// Generators mark their output in its header: tree-sitter's parser.c ("@generated"),
// protoc, Go ("Code generated ... DO NOT EDIT")
const GENERATED_MARKER = /@generated\b|\bDO NOT EDIT\b|\b(?:code|auto(?:matically)?)[ -]generated\b/i

/**
 * Whether a file says in its first 1 KB that a tool generated it. It is still
 * text, but large, repetitive and not what anyone searches for.
 */
export function isGenerated(buffer: Uint8Array): boolean {
  const header = new TextDecoder().decode(buffer.subarray(0, 1024))
  return GENERATED_MARKER.test(header)
}

/**
 * Compute SHA-256 hash of a buffer
 */
function hashBuffer(buffer: Uint8Array): string {
  return crypto.createHash("sha256").update(buffer).digest("hex")
}

/**
 * Check if a path should be ignored based on patterns
 */
function shouldIgnore(path: string): boolean {
  // Same patterns and dotfile handling as the fast-glob scan in planFullIndex
  return micromatch.isMatch(path, DEFAULT_IGNORE_PATTERNS, { dot: true })
}

/**
 * Extract a snippet around the query match
 */
function extractSnippet(
  contents: string,
  query: string,
  contextChars = 100
): string {
  const lower = contents.toLowerCase()
  const queryLower = query.toLowerCase()
  const idx = lower.indexOf(queryLower)
  if (idx === -1) return contents.slice(0, contextChars * 2) + "..."
  const start = Math.max(0, idx - contextChars)
  const end = Math.min(contents.length, idx + query.length + contextChars)
  return (
    (start > 0 ? "..." : "") +
    contents.slice(start, end) +
    (end < contents.length ? "..." : "")
  )
}

/**
 * Get the repos directory path
 */
const getReposDir = () => `${os.homedir()}/.repobase/repos`

/**
 * Validate that a file path doesn't escape the repo directory
 */
function validatePath(filePath: string): Effect.Effect<void, IndexError> {
  if (filePath.includes("..") || filePath.startsWith("/")) {
    return Effect.fail(
      new IndexError({
        operation: "validatePath",
        message: `Invalid path: ${filePath}`
      })
    )
  }
  return Effect.void
}

/**
 * Quote a value as an SQL string literal for LanceDB filters
 */
const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`

const decodeRows =
  <S extends Schema.Top>(row: S) =>
  (rows: unknown) =>
    Schema.decodeUnknownEffect(Schema.Array(row))(rows).pipe(
      Effect.mapError((e) => new IndexError({ operation: "decodeRows", message: e.message }))
    )

const asSearchError = (e: IndexError) => new SearchError({ message: e.message })

const PathRow = Schema.Struct({ path: Schema.String })
const HashRow = Schema.Struct({ path: Schema.String, hash: Schema.String })
const RepoRow = Schema.Struct({ repo: Schema.String })
const FileRow = Schema.Struct({ path: Schema.String, filename: Schema.String, size_bytes: Schema.Number, mtime_ms: Schema.Number })
const RepoFileRow = Schema.Struct({ ...RepoRow.fields, ...FileRow.fields })
const GrepRow = Schema.Struct({ repo: Schema.String, path: Schema.String, filename: Schema.String })
const SearchRow = Schema.Struct({
  ...GrepRow.fields,
  text: Schema.String,
  start_line: Schema.Number,
  end_line: Schema.Number
})
const KeywordRow = Schema.Struct({ ...SearchRow.fields, _score: Schema.optional(Schema.Number) })
const SemanticRow = Schema.Struct({ ...SearchRow.fields, _distance: Schema.optional(Schema.Number) })
const HybridRow = Schema.Struct({ ...SearchRow.fields, _relevanceScore: Schema.optional(Schema.Number) })

/**
 * LanceDB filter for a file, or every file under a directory (so `src/a`
 * doesn't also match `src/ab`)
 */
const pathFilter = (path: string) => {
  const trimmed = path.replace(/^\.\//, "").replace(/\/+$/, "")
  return `(path = ${sqlString(trimmed)} OR starts_with(path, ${sqlString(`${trimmed}/`)}))`
}

/**
 * The directory a path glob can only match under, if any (`src` for
 * `src/**\/*.ts`). Globs without a `/` also match bare filenames, so they have none.
 */
const globBase = (glob: string): string | undefined => {
  const scan = micromatch.scan(glob)
  return glob.includes("/") && !scan.negated && scan.base !== "" ? scan.base : undefined
}

/**
 * LanceDB filter for paths matching a glob; `!glob` matches the paths it doesn't
 */
const globFilter = (glob: string) =>
  glob.startsWith("!")
    ? `NOT regexp_like(path, ${sqlString(globToRegex(glob.slice(1)))})`
    : `regexp_like(path, ${sqlString(globToRegex(glob))})`

// `*` matches dotfiles, as in search's globs
const matchesGlob = (file: { path: string; filename: string }, glob: string) =>
  micromatch.isMatch(file.path, glob, { dot: true }) || micromatch.isMatch(file.filename, glob, { dot: true })

const GREP_READ_CONCURRENCY = 16

// Bigger files are mostly data, fixtures or generated code, and slow to embed
export const MAX_INDEXED_FILE_BYTES = 1024 * 1024

const withoutCarriageReturn = (line: string) => (line.endsWith("\r") ? line.slice(0, -1) : line)

const NOT_FOUND = "NotFound" satisfies PlatformError.SystemErrorTag

const goneAsNone = <A>(effect: Effect.Effect<Option.Option<A>, PlatformError.PlatformError>) =>
  effect.pipe(Effect.catch((e) => (e.reason._tag === NOT_FOUND ? Effect.succeed(Option.none<A>()) : Effect.fail(e))))

/**
 * Apply the search options' repo and path filters to a LanceDB query
 */
const applySearchFilters = <Q extends { where(predicate: string): Q }>(search: Q, options: SearchOptions | undefined): Q => {
  if (options?.repo) search = search.where(`repo = ${sqlString(options.repo)}`)
  if (options?.repos && options.repos.length > 0) {
    search = search.where(`repo IN (${options.repos.map(sqlString).join(", ")})`)
  }
  if (options?.path) search = search.where(pathFilter(options.path))
  if (options?.glob) search = search.where(globFilter(options.glob))
  return search
}

/** Columns a search reads from each chunk, besides its score */
const SEARCH_COLUMNS = Object.keys(SearchRow.fields)

/**
 * One result per file from chunks ordered best first: each file's first (best)
 * chunk, up to `limit` files
 */
const bestChunkPerFile = <R extends typeof SearchRow.Type>(
  rows: ReadonlyArray<R>,
  score: (row: R) => number,
  query: string,
  limit: number
): Array<SearchResult> => {
  const seen = new Set<string>()
  const results: Array<SearchResult> = []
  for (const row of rows) {
    const key = `${row.repo}\0${row.path}`
    if (seen.has(key)) continue
    seen.add(key)
    results.push({
      repo: row.repo,
      path: row.path,
      filename: row.filename,
      score: score(row),
      snippet: extractSnippet(row.text, query),
      startLine: row.start_line,
      endLine: row.end_line
    })
    if (results.length >= limit) break
  }
  return results
}

const traceSearch =
  (mode: SearchMode, query: string, options: SearchOptions | undefined) =>
  <E, R>(search: Effect.Effect<SearchResult[], E, R>) =>
    search.pipe(
      Effect.tap((results) => Effect.annotateCurrentSpan("search.results", results.length)),
      Effect.withSpan("Indexer.search", {
        attributes: {
          "search.mode": mode,
          "search.query": query,
          "search.repo": options?.repo,
          "search.path": options?.path,
          "search.glob": options?.glob,
          "search.limit": options?.limit ?? 20
        }
      })
    )

/**
 * Row id of one chunk of a file in the index
 */
const recordId = (repoId: string, path: string, chunk: number) => `${repoId}:${path}#${chunk}`

/**
 * LanceDB rejects a write whose base version changed underneath it when
 * another writer (a worker thread or the MCP server) committed first. It
 * retries internally; this covers conflicts that still surface.
 */
const isCommitConflict = (error: IndexError) =>
  /commit conflict|conflicting|retryable|concurrent/i.test(error.message)

const COMMIT_CONFLICT_RETRIES = 5

const retryOnCommitConflict = <A>(effect: Effect.Effect<A, IndexError>) =>
  Effect.suspend(() => {
    let attempt = 0
    return effect.pipe(
      Effect.tapError((error) => {
        if (!isCommitConflict(error)) return Effect.void
        attempt++
        return Effect.logWarning(
          `LanceDB commit conflict in ${error.operation} (attempt ${attempt} of ${COMMIT_CONFLICT_RETRIES + 1})`,
          error.message
        )
      }),
      Effect.retry({
        while: isCommitConflict,
        schedule: Schedule.exponential("50 millis"),
        times: COMMIT_CONFLICT_RETRIES
      })
    )
  })

/**
 * Create an Indexer for a given index directory
 */
export const makeWith = (options: IndexerConfig) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const config = { ...options, indexDir: options.indexDir ?? INDEX_DIR, reposDir: options.reposDir ?? getReposDir() }

  const store = yield* makeIndexStore(config.indexDir)
  const embedder = yield* makeEmbedder(config)

  // A file's path inside `root`, if no symlink is on the way to it: a cloned
  // repo can't point indexing, read_file or grep at files outside itself
  const resolveInRepo = (root: string, filePath: string) =>
    Effect.gen(function* () {
      const expected = `${yield* fs.realPath(root)}/${filePath}`
      return (yield* fs.realPath(expected)) === expected ? Option.some(expected) : Option.none<string>()
    }).pipe(goneAsNone)

  const fileInRepo = (root: string, filePath: string) =>
    resolveInRepo(root, filePath).pipe(Effect.orElseSucceed(() => Option.none<string>()))

  // Read a file for indexing; None if it is gone, a symlink, too large, binary or generated
  const readIndexable = (repoPath: string, filePath: string) =>
    Effect.gen(function* () {
      const file = yield* resolveInRepo(repoPath, filePath)
      if (Option.isNone(file)) return Option.none<Uint8Array>()
      const info = yield* fs.stat(file.value)
      if (info.type !== "File" || Number(info.size) > MAX_INDEXED_FILE_BYTES) return Option.none<Uint8Array>()
      const buffer = yield* fs.readFile(file.value)
      return isBinary(buffer) || isGenerated(buffer) ? Option.none<Uint8Array>() : Option.some(buffer)
    }).pipe(
      goneAsNone,
      Effect.mapError((e) => new IndexError({ operation: "readFile", message: e.message, path: filePath }))
    )

  const existingHashes = (repoId: string) =>
    Effect.gen(function* () {
      const tbl = yield* store.table.pipe(
        Effect.mapError((e) => new IndexError({ operation: "planIndex.queryExisting", message: e.message, path: e.path }))
      )
      const existing = yield* Effect.tryPromise({
        try: () => tbl
          .query()
          .where(`repo = ${sqlString(repoId)} AND ${FIRST_CHUNK}`)
          .select(["path", "hash"])
          .toArray(),
        catch: (e) =>
          new IndexError({ operation: "planIndex.queryExisting", message: `Failed to query existing: ${e}` })
      }).pipe(Effect.flatMap(decodeRows(HashRow)))
      return new Map(existing.map((r) => [r.path, r.hash]))
    })

  const planFullIndex: IndexerService["planFullIndex"] = (repoId, repoPath, options) =>
    Effect.gen(function* () {
      const force = options?.force ?? false
      const existingByPath = yield* existingHashes(repoId)

      // Find all files using glob
      const glob = yield* Effect.tryPromise({
        try: () => import("fast-glob"),
        catch: (e) => new IndexError({ operation: "planIndex.glob", message: `Failed to import fast-glob: ${e}` })
      })

      const files = yield* Effect.tryPromise({
        try: () =>
          glob.default("**/*", {
            cwd: repoPath,
            ignore: DEFAULT_IGNORE_PATTERNS,
            onlyFiles: true,
            dot: true,
            followSymbolicLinks: false
          }),
        catch: (e) => new IndexError({ operation: "planIndex.glob", message: `Failed to glob files: ${e}` })
      })

      const seenPaths = new Set<string>()
      const toIndex: Array<IndexPlanFile> = []
      let skipped = 0

      for (const filePath of files) {
        const buffer = yield* readIndexable(repoPath, filePath)
        if (Option.isNone(buffer)) {
          skipped++
          continue
        }
        seenPaths.add(filePath)

        // Check hash for changes
        const hash = hashBuffer(buffer.value)
        if (!force && existingByPath.get(filePath) === hash) {
          skipped++
          continue
        }
        toIndex.push({ path: filePath, hash })
      }

      // Indexed files that are no longer in the repo, or can no longer be indexed
      const toDelete = [...existingByPath.keys()].filter((p) => !seenPaths.has(p))

      yield* Effect.annotateCurrentSpan({
        "plan.scanned": files.length,
        "plan.to_index": toIndex.length,
        "plan.to_delete": toDelete.length
      })
      return { toIndex, toDelete, skipped }
    }).pipe(Effect.withSpan("Indexer.planFullIndex", { attributes: { "plan.repo": repoId, "plan.force": options?.force ?? false } }))

  const planChanges: IndexerService["planChanges"] = (repoId, repoPath, changes) =>
    Effect.gen(function* () {
      const existingByPath = yield* existingHashes(repoId)
      const toIndex: Array<IndexPlanFile> = []
      const toDelete: Array<string> = []
      let skipped = 0

      for (const change of changes) {
        if (change.status === "D") {
          toDelete.push(change.path)
          continue
        }
        if (shouldIgnore(change.path)) {
          skipped++
          continue
        }
        const buffer = yield* readIndexable(repoPath, change.path)
        if (Option.isNone(buffer)) {
          // Added/modified but gone or now binary: drop any stale row
          toDelete.push(change.path)
          continue
        }
        const hash = hashBuffer(buffer.value)
        if (existingByPath.get(change.path) === hash) {
          skipped++
          continue
        }
        toIndex.push({ path: change.path, hash })
      }

      yield* Effect.annotateCurrentSpan({ "plan.to_index": toIndex.length, "plan.to_delete": toDelete.length })
      return { toIndex, toDelete, skipped }
    }).pipe(Effect.withSpan("Indexer.planChanges", { attributes: { "plan.repo": repoId, "plan.changes": changes.length } }))

  const deletePaths: IndexerService["deletePaths"] = (repoId, paths) =>
    Effect.gen(function* () {
      if (paths.length === 0) return
      const tbl = yield* store.table
      for (const group of Arr.chunksOf(paths, DELETE_CHUNK_SIZE)) {
        const list = group.map(sqlString).join(", ")
        yield* retryOnCommitConflict(
          Effect.tryPromise({
            // Every chunk of each file
            try: () => tbl.delete(`repo = ${sqlString(repoId)} AND path IN (${list})`),
            catch: (e) => new IndexError({ operation: "deletePaths", message: `Failed to delete: ${e}` })
          })
        )
      }
    }).pipe(Effect.withSpan("Indexer.deletePaths", { attributes: { "delete.repo": repoId, "delete.paths": paths.length } }))

  const indexBatch: IndexerService["indexBatch"] = (repoId, repoPath, files, options) =>
    Effect.gen(function* () {
      const tbl = yield* store.table
      const records: Array<Record<string, unknown>> = []
      // Each written file's chunk count, to drop chunks left from a longer version
      const chunkCounts: Array<readonly [string, number]> = []
      const gone: Array<string> = []
      const embedError = (path: string) => (e: IndexError) =>
        new IndexError({
          operation: e.operation === "loadEmbedder" ? e.operation : "indexBatch.embed",
          message: e.message,
          path
        })
      const countTokens = yield* embedder.tokenCounter.pipe(Effect.mapError(embedError(files[0]?.path ?? "")))

      const indexFile = (file: IndexPlanFile) =>
        Effect.gen(function* () {
          // Re-read: the file may have changed or disappeared since planning
          const buffer = yield* readIndexable(repoPath, file.path)
          if (Option.isNone(buffer)) return Option.none<Array<Record<string, unknown>>>()

          const contents = new TextDecoder().decode(buffer.value)
          const stat = yield* fs.stat(`${repoPath}/${file.path}`).pipe(
            Effect.catch(() => Effect.succeed({ mtime: Option.none<Date>(), size: BigInt(0) }))
          )
          // The platform's stat gives a JS Date
          const mtimeMs = Option.isSome(stat.mtime) ? stat.mtime.value.getTime() : yield* Clock.currentTimeMillis
          const hash = hashBuffer(buffer.value)

          const rows: Array<Record<string, unknown>> = []
          for (const chunk of chunkLines(contents, countTokens)) {
            const vector = yield* embedder.embed(chunk.text).pipe(Effect.mapError(embedError(file.path)))
            rows.push({
              id: recordId(repoId, file.path, chunk.chunk),
              repo: repoId,
              path: file.path,
              filename: file.path.split("/").pop() ?? file.path,
              chunk: chunk.chunk,
              start_line: chunk.startLine,
              end_line: chunk.endLine,
              text: chunk.text,
              mtime_ms: Math.trunc(mtimeMs),
              size_bytes: Number(stat.size),
              hash,
              vector
            })
          }
          return Option.some(rows)
        })

      const [embedTime] = yield* Effect.timed(
        Effect.gen(function* () {
          for (const file of files) {
            if (options?.onFile) yield* options.onFile(file.path)

            const [fileTime, rows] = yield* Effect.timed(indexFile(file))
            if (Option.isNone(rows)) {
              gone.push(file.path)
              continue
            }
            records.push(...rows.value)
            chunkCounts.push([file.path, rows.value.length])

            const fileMs = Math.round(Duration.toMillis(fileTime))
            if (fileMs >= SLOW_FILE_MS) {
              yield* Effect.logInfo(`Slow file: ${file.path} took ${fileMs}ms for ${rows.value.length} chunk(s)`).pipe(
                Effect.annotateLogs({ "index.path": file.path, "index.chunks": rows.value.length, "index.file_ms": fileMs })
              )
            }
          }
        })
      )
      if (gone.length > 0) {
        yield* Effect.logDebug(`Skipped ${gone.length} file(s) that were gone or binary when their batch ran`, gone)
      }

      const [writeTime] = yield* Effect.timed(
        Effect.gen(function* () {
          // Upsert by id, so re-running a batch never duplicates rows
          if (records.length > 0) {
            yield* retryOnCommitConflict(
              Effect.tryPromise({
                try: () =>
                  tbl.mergeInsert("id").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(records),
                catch: (e) => new IndexError({ operation: "indexBatch.write", message: `Failed to write batch: ${e}` })
              })
            )
            // Chunks past a file's new end, from when it was longer
            const stale = chunkCounts
              .map(([path, count]) => `(path = ${sqlString(path)} AND chunk >= ${count})`)
              .join(" OR ")
            yield* retryOnCommitConflict(
              Effect.tryPromise({
                try: () => tbl.delete(`repo = ${sqlString(repoId)} AND (${stale})`),
                catch: (e) => new IndexError({ operation: "indexBatch.write", message: `Failed to drop old chunks: ${e}` })
              })
            )
          }
          yield* deletePaths(repoId, gone).pipe(
            Effect.mapError((e) => new IndexError({ operation: "indexBatch.write", message: e.message, path: e.path }))
          )
        })
      )

      yield* Effect.annotateCurrentSpan({
        "index.indexed": chunkCounts.length,
        "index.skipped": gone.length,
        "index.chunks": records.length,
        "index.embed_ms": Math.round(Duration.toMillis(embedTime)),
        "index.write_ms": Math.round(Duration.toMillis(writeTime))
      })
      return { indexed: chunkCounts.length, skipped: gone.length }
    }).pipe(Effect.withSpan("Indexer.indexBatch", { attributes: { "index.repo": repoId, "index.files": files.length } }))

  const finalizeIndex: IndexerService["finalizeIndex"] = () =>
    Effect.gen(function* () {
      const tbl = yield* store.table
      const lancedb = yield* Effect.tryPromise({
        try: () => import("@lancedb/lancedb"),
        catch: (e) => new IndexError({ operation: "finalizeIndex", message: `Failed to import lancedb: ${e}` })
      })
      // Merge the small fragments left by per-batch writes, then rebuild FTS
      yield* retryOnCommitConflict(
        Effect.tryPromise({
          try: () => tbl.optimize(),
          catch: (e) => new IndexError({ operation: "finalizeIndex", message: `Failed to compact index: ${e}` })
        })
      ).pipe(Effect.withSpan("finalizeIndex.compact"))
      yield* retryOnCommitConflict(
        Effect.tryPromise({
          try: () => tbl.createIndex("text", { config: lancedb.Index.fts(), replace: true }),
          catch: (e) =>
            new IndexError({ operation: "finalizeIndex", message: `Failed to build full-text index: ${e}` })
        })
      ).pipe(Effect.withSpan("finalizeIndex.fts"))
    }).pipe(Effect.withSpan("Indexer.finalizeIndex"))

  const dropLegacyIndex: IndexerService["dropLegacyIndex"] = () =>
    Effect.gen(function* () {
      const database = yield* store.connection
      return yield* Effect.tryPromise({
        try: async () => {
          if (!(await database.tableNames()).includes(LEGACY_FILES_TABLE)) return false
          await database.dropTable(LEGACY_FILES_TABLE)
          return true
        },
        catch: (e) => new IndexError({ operation: "dropLegacyIndex", message: `Failed to drop the legacy table: ${e}` })
      })
    })

  // Apply a plan: drop removed files, index in batches, finalize
  const applyPlan = (
    repoId: string,
    repoPath: string,
    plan: IndexPlan,
    updateProgress: (update: Partial<IndexingProgress>) => Effect.Effect<void>
  ) =>
    Effect.gen(function* () {
      const startTime = yield* Clock.currentTimeMillis
      yield* updateProgress({ phase: "indexing", filesProcessed: 0, totalFiles: plan.toIndex.length })

      yield* deletePaths(repoId, plan.toDelete)

      let processed = 0
      let indexed = 0
      let skipped = plan.skipped
      for (const batch of Arr.chunksOf(plan.toIndex, INDEX_BATCH_SIZE)) {
        const result = yield* indexBatch(repoId, repoPath, batch, {
          onFile: (path) =>
            Effect.suspend(() => updateProgress({ filesProcessed: processed++, currentFile: path }))
        })
        indexed += result.indexed
        skipped += result.skipped
      }

      yield* updateProgress({
        phase: "finalizing",
        filesProcessed: plan.toIndex.length,
        totalFiles: plan.toIndex.length,
        currentFile: undefined
      })

      // FTS creation can fail on tiny or empty tables; search still works without it
      yield* finalizeIndex().pipe(
        Effect.catch((e) => Effect.logWarning(`Finalizing index for ${repoId} failed: ${e.message}`))
      )

      return {
        repo: repoId,
        filesIndexed: indexed,
        filesDeleted: plan.toDelete.length,
        filesSkipped: skipped,
        durationMs: (yield* Clock.currentTimeMillis) - startTime
      }
    })

  // Full repository indexing
  const indexRepo: IndexerService["indexRepo"] = (repoId, repoPath, options) =>
    Effect.gen(function* () {
      const startTime = yield* Clock.currentTimeMillis
      const progressRef = options?.progressRef
      const updateProgress = (update: Partial<IndexingProgress>) =>
        progressRef
          ? SubscriptionRef.update(progressRef, (prev) => ({ ...prev, ...update }))
          : Effect.void

      yield* updateProgress({ phase: "scanning", filesProcessed: 0, totalFiles: 0 })
      const plan = yield* planFullIndex(repoId, repoPath, { force: options?.force ?? false })
      const summary = yield* applyPlan(repoId, repoPath, plan, updateProgress)
      return { ...summary, durationMs: (yield* Clock.currentTimeMillis) - startTime }
    })

  // Incremental indexing based on git diff
  const indexChanges: IndexerService["indexChanges"] = (repoId, repoPath, changes) =>
    Effect.gen(function* () {
      const startTime = yield* Clock.currentTimeMillis
      const plan = yield* planChanges(repoId, repoPath, changes)
      const summary = yield* applyPlan(repoId, repoPath, plan, () => Effect.void)
      return { ...summary, durationMs: (yield* Clock.currentTimeMillis) - startTime }
    })

  // Remove all index data for a repo
  const removeIndex: IndexerService["removeIndex"] = (repoId) =>
    Effect.gen(function* () {
      const tbl = yield* store.table
      yield* retryOnCommitConflict(
        Effect.tryPromise({
          try: () => tbl.delete(`repo = ${sqlString(repoId)}`),
          catch: (e) => new IndexError({ operation: "removeIndex", message: `Failed to delete: ${e}` })
        })
      )
    })

  const hasFullTextIndex = (tbl: Table) =>
    Effect.tryPromise({
      try: async () =>
        ((await tbl.listIndices())).some((index) =>
          index.columns.includes("text")
        ),
      catch: (e) => new SearchError({ message: `Failed to list indexes: ${e}` })
    })

  // Keyword search (FTS only)
  const searchKeyword: IndexerService["searchKeyword"] = (query, options) =>
    Effect.gen(function* () {
      const tbl = yield* store.table.pipe(
        Effect.mapError((e) => new SearchError({ message: e.message }))
      )

      if (!(yield* hasFullTextIndex(tbl))) {
        yield* Effect.logWarning("No full-text index yet, so keyword search finds nothing until indexing finishes")
        return []
      }

      const limit = options?.limit ?? 20
      const search = applySearchFilters(tbl.query().fullTextSearch(query), options)

      // Select scores explicitly: LanceDB warns (on stderr, over the TUI) when they're implied
      const results = yield* Effect.tryPromise({
        try: () => search
          .select([...SEARCH_COLUMNS, "_score"])
          .limit(limit * CHUNKS_PER_RESULT)
          .toArray(),
        catch: (e) => new SearchError({ message: `Keyword search failed: ${e}` })
      }).pipe(Effect.flatMap((rows) => decodeRows(KeywordRow)(rows).pipe(Effect.mapError(asSearchError))))

      return bestChunkPerFile(results, (r) => r._score ?? 1, query, limit)
    }).pipe(traceSearch("keyword", query, options))

  // Semantic search (vector only)
  const searchSemantic: IndexerService["searchSemantic"] = (query, options) =>
    Effect.gen(function* () {
      const tbl = yield* store.table.pipe(
        Effect.mapError((e) => new SearchError({ message: e.message }))
      )
      const limit = options?.limit ?? 20
      const queryVector = yield* embedder.embed(query).pipe(
        Effect.mapError((e) => new SearchError({ message: e.message }))
      )

      const search = applySearchFilters(tbl.vectorSearch(queryVector).column("vector"), options)

      const results = yield* Effect.tryPromise({
        try: () => search
          .select([...SEARCH_COLUMNS, "_distance"])
          .limit(limit * CHUNKS_PER_RESULT)
          .toArray(),
        catch: (e) => new SearchError({ message: `Semantic search failed: ${e}` })
      }).pipe(Effect.flatMap((rows) => decodeRows(SemanticRow)(rows).pipe(Effect.mapError(asSearchError))))

      return bestChunkPerFile(results, (r) => 1 / (1 + (r._distance ?? 0)), query, limit)
    }).pipe(traceSearch("semantic", query, options))

  // Hybrid search (FTS + vector with RRF reranking)
  const searchHybrid: IndexerService["searchHybrid"] = (query, options) =>
    Effect.gen(function* () {
      const tbl = yield* store.table.pipe(
        Effect.mapError((e) => new SearchError({ message: e.message }))
      )

      if (!(yield* hasFullTextIndex(tbl))) {
        yield* Effect.logWarning("No full-text index yet, so hybrid search falls back to semantic search")
        return yield* searchSemantic(query, options)
      }

      const limit = options?.limit ?? 20
      const queryVector = yield* embedder.embed(query).pipe(
        Effect.mapError((e) => new SearchError({ message: e.message }))
      )

      const lancedb = yield* Effect.tryPromise({
        try: () => import("@lancedb/lancedb"),
        catch: (e) => new SearchError({ message: `Failed to import lancedb: ${e}` })
      })

      const reranker = yield* Effect.tryPromise({
        try: () => lancedb.rerankers.RRFReranker.create(),
        catch: (e) => new SearchError({ message: `Failed to create reranker: ${e}` })
      })

      const search = applySearchFilters(
        tbl.query().fullTextSearch(query).nearestTo(queryVector).rerank(reranker),
        options
      )

      const results = yield* Effect.tryPromise({
        try: () => search
          .select(SEARCH_COLUMNS)
          .limit(limit * CHUNKS_PER_RESULT)
          .toArray(),
        catch: (e) => new SearchError({ message: `Hybrid search failed: ${e}` })
      }).pipe(Effect.flatMap((rows) => decodeRows(HybridRow)(rows).pipe(Effect.mapError(asSearchError))))

      return bestChunkPerFile(results, (r) => r._relevanceScore ?? 1, query, limit)
    }).pipe(traceSearch("hybrid", query, options))

  // List files and directories in a repository path
  const listFiles: IndexerService["listFiles"] = (options) =>
    Effect.gen(function* () {
      const tbl = yield* store.table
      const { repo, path: dirPath = "" } = options

      if (!repo) {
        // List all repositories: the repo of every file, with no limit, so none drops out
        const results = yield* Effect.tryPromise({
          try: () => tbl
            .query()
            .where(FIRST_CHUNK)
            .select(["repo"])
            .toArray(),
          catch: (e) => new IndexError({ operation: "listFiles", message: `${e}` })
        }).pipe(Effect.flatMap(decodeRows(RepoRow)))

        const uniqueRepos = [...new Set(results.map((r) => r.repo))]
        return uniqueRepos.map(
          (r): FileInfo => ({
            repo: r,
            path: "",
            filename: r,
            isDirectory: true
          })
        )
      }

      // Validate directory path
      if (dirPath) {
        yield* validatePath(dirPath)
      }

      // Query files in this repo starting with the path prefix
      const searchPath = dirPath ? `${dirPath}/` : ""
      const results = yield* Effect.tryPromise({
        try: () =>
          tbl
            .query()
            .where(`repo = ${sqlString(repo)} AND starts_with(path, ${sqlString(searchPath)}) AND ${FIRST_CHUNK}`)
            .select(["path", "filename", "size_bytes", "mtime_ms"])
            .toArray(),
        catch: (e) => new IndexError({ operation: "listFiles", message: `${e}` })
      }).pipe(Effect.flatMap(decodeRows(FileRow)))

      // Extract immediate children (files and subdirectories)
      const entries = new Map<string, FileInfo>()

      for (const file of results) {
        let relativePath = file.path
        if (dirPath && file.path.startsWith(searchPath)) {
          relativePath = file.path.slice(searchPath.length)
        }

        const slashIndex = relativePath.indexOf("/")
        if (slashIndex === -1) {
          // Direct file in this directory
          entries.set(relativePath, {
            repo,
            path: file.path,
            filename: relativePath,
            isDirectory: false,
            size: file.size_bytes,
            mtime: DateTime.makeUnsafe(file.mtime_ms)
          })
        } else {
          // Subdirectory - only add if not already present
          const subdir = relativePath.slice(0, slashIndex)
          if (!entries.has(subdir)) {
            entries.set(subdir, {
              repo,
              path: dirPath ? `${dirPath}/${subdir}` : subdir,
              filename: subdir,
              isDirectory: true
            })
          }
        }
      }

      // Sort: directories first, then alphabetically
      return [...entries.values()].sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.filename.localeCompare(b.filename)
      })
    })

  // Find files matching a glob pattern
  const globFiles: IndexerService["globFiles"] = (pattern, options) =>
    Effect.gen(function* () {
      const tbl = yield* store.table
      const limit = options?.limit ?? 100

      // Query all files (or filtered by repo)
      const where = options?.repo ? [`repo = ${sqlString(options.repo)}`] : []

      const allFiles = yield* Effect.tryPromise({
        try: () =>
          tbl
            .query()
            .where([...where, FIRST_CHUNK].join(" AND "))
            .select(["repo", "path", "filename", "size_bytes", "mtime_ms"])
            .toArray(),
        catch: (e) => new IndexError({ operation: "globFiles", message: `${e}` })
      }).pipe(Effect.flatMap(decodeRows(RepoFileRow)))

      // Apply glob pattern matching
      const matched = allFiles.filter((file) => matchesGlob(file, pattern))

      // Limit results
      const limited = matched.slice(0, limit)

      return limited.map(
        (r): FileInfo => ({
          repo: r.repo,
          path: r.path,
          filename: r.filename,
          isDirectory: false,
          size: r.size_bytes,
          mtime: DateTime.makeUnsafe(r.mtime_ms)
        })
      )
    })

  // Read file contents from disk
  const readFile: IndexerService["readFile"] = (repo, filePath, options) =>
    Effect.gen(function* () {
      const tbl = yield* store.table

      // Validate path
      yield* validatePath(filePath)

      // Verify file exists in index
      const indexed = yield* Effect.tryPromise({
        try: () =>
          tbl
            .query()
            .where(`repo = ${sqlString(repo)} AND path = ${sqlString(filePath)} AND ${FIRST_CHUNK}`)
            .select(["path"])
            .limit(1)
            .toArray(),
        catch: (e) => new IndexError({ operation: "readFile", message: `${e}` })
      }).pipe(Effect.flatMap(decodeRows(PathRow)))

      if (indexed.length === 0) {
        return yield* Effect.fail(
          new FileNotFoundError({
            repo,
            path: filePath
          })
        )
      }

      // Read from disk
      const file = yield* fileInRepo(`${config.reposDir}/${repo}`, filePath)
      if (Option.isNone(file)) return yield* new FileNotFoundError({ repo, path: filePath })
      const content = yield* fs.readFileString(file.value).pipe(
        Effect.mapError(
          () =>
            new FileNotFoundError({
              repo,
              path: filePath
            })
        )
      )

      const lines = splitLines(content)
      const totalLines = lines.length
      const offset = Math.max(1, options?.offset ?? 1)
      const limit = options?.limit ?? totalLines

      const startLine = offset
      const endLine = Math.min(totalLines, offset + limit - 1)

      // Extract requested lines
      const selectedLines = lines.slice(startLine - 1, endLine)

      // Optionally format with line numbers
      const outputContent =
        options?.lineNumbers !== false
          ? selectedLines
              .map((line, i) => `${String(startLine + i).padStart(6)}|${line}`)
              .join("\n")
          : selectedLines.join("\n")

      return {
        repo,
        path: filePath,
        content: outputContent,
        totalLines,
        startLine,
        endLine
      }
    })

  // Grep pattern search with context support
  const grepPattern: IndexerService["grepPattern"] = (pattern, options) =>
    Effect.gen(function* () {
      const tbl = yield* store.table

      // Build regex - validate pattern first
      const flags = options?.ignoreCase ? "gi" : "g"
      let regex: RegExp
      try {
        regex = new RegExp(pattern, flags)
      } catch (e) {
        return yield* Effect.fail(
          new InvalidPatternError({
            pattern,
            message: e instanceof Error ? e.message : String(e)
          })
        )
      }

      // Query indexed files
      const where: Array<string> = []
      if (options?.repo) where.push(`repo = ${sqlString(options.repo)}`)
      if (options?.fileType) where.push(`ends_with(filename, ${sqlString(`.${options.fileType}`)})`)
      if (options?.path) where.push(pathFilter(options.path))
      // Only read files under the glob's fixed directory
      const base = options?.glob ? globBase(options.glob) : undefined
      if (base) where.push(pathFilter(base))

      const indexed = yield* Effect.tryPromise({
        try: () => tbl
          .query()
          .where([...where, FIRST_CHUNK]
            .join(" AND "))
          .select(["repo", "path", "filename"])
          .toArray(),
        catch: (e) => new IndexError({ operation: "grepPattern", message: `${e}` })
      }).pipe(Effect.flatMap(decodeRows(GrepRow)), Effect.withSpan("grep.query"))

      const files = indexed.filter(
        (file) =>
          (!options?.glob || matchesGlob(file, options.glob)) &&
          (!options?.exclude || !matchesGlob(file, options.exclude))
      )
      yield* Effect.annotateCurrentSpan({ "grep.indexed_files": indexed.length, "grep.candidates": files.length })

      return yield* Effect.gen(function* () {
        const results: GrepResult[] = []
        let outputCount = 0
        let filesRead = 0
        const limit = options?.limit ?? Number.MAX_SAFE_INTEGER

        const contextBefore = options?.contextBefore ?? 0
        const contextAfter = options?.contextAfter ?? 0

        const readFile = (file: { repo: string; path: string }) => {
          filesRead++
          return fileInRepo(`${config.reposDir}/${file.repo}`, file.path).pipe(
            Effect.flatMap(Option.match({ onNone: () => Effect.succeedNone, onSome: (path) => Effect.option(fs.readFileString(path)) })),
            Effect.catch(() => Effect.succeed(Option.none<string>())),
            Effect.map((content) => ({ file, content }))
          )
        }

        const handleFile = (file: { repo: string; path: string }, content: Option.Option<string>) => {
          if (Option.isNone(content)) return

          const lines = splitLines(content.value).map(withoutCarriageReturn)
          const matchingLineNums = new Set<number>()

          // Find all matching lines
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              matchingLineNums.add(i)
            }
            regex.lastIndex = 0 // Reset for global regex
          }

          if (matchingLineNums.size === 0) return

          if (options?.filesWithMatches || options?.count) {
            results.push({
              repo: file.repo,
              path: file.path,
              matches: [],
              matchCount: matchingLineNums.size
            })
            outputCount++
            return
          }

          // Build matches with context
          const linesToShow = new Set<number>()
          for (const matchLine of matchingLineNums) {
            for (
              let i = Math.max(0, matchLine - contextBefore);
              i <= Math.min(lines.length - 1, matchLine + contextAfter);
              i++
            ) {
              linesToShow.add(i)
            }
          }

          const matches: GrepMatch[] = []
          const sortedLines = [...linesToShow].sort((a, b) => a - b)

          for (const lineNum of sortedLines) {
            matches.push({
              lineNumber: lineNum + 1,
              content: lines[lineNum],
              isMatch: matchingLineNums.has(lineNum)
            })
            outputCount++
            if (outputCount >= limit) break
          }

          results.push({
            repo: file.repo,
            path: file.path,
            matches,
            matchCount: matchingLineNums.size
          })
        }

        // Reads run ahead concurrently but arrive in order, and reading stops once the limit is reached
        if (limit > 0) {
          yield* Stream.fromIterable(files).pipe(
            Stream.mapEffect(readFile, { concurrency: GREP_READ_CONCURRENCY }),
            Stream.runForEachWhile(({ file, content }) =>
              Effect.sync(() => {
                handleFile(file, content)
                return outputCount < limit
              })
            )
          )
        }

        yield* Effect.annotateCurrentSpan({ "grep.files_read": filesRead, "grep.files_matched": results.length })
        return results
      }).pipe(Effect.withSpan("grep.scan"))
    }).pipe(
      Effect.withSpan("Indexer.grepPattern", {
        attributes: {
          "grep.pattern": pattern,
          "grep.repo": options?.repo,
          "grep.path": options?.path,
          "grep.glob": options?.glob,
          "grep.ignore_case": options?.ignoreCase ?? false
        }
      })
    )

  return Indexer.of({
    indexRepo,
    indexChanges,
    removeIndex,
    planFullIndex,
    planChanges,
    deletePaths,
    indexBatch,
    finalizeIndex,
    dropLegacyIndex,
    searchKeyword,
    searchSemantic,
    searchHybrid,
    listFiles,
    globFiles,
    readFile,
    grepPattern
  })
})

/**
 * Create the Indexer service implementation for ~/.repobase/index
 */
export const make = makeWith({})

/**
 * Indexer layer - requires FileSystem
 */
export const layer = Layer.effect(Indexer, make)

/**
 * Indexer layer for a custom index directory (and, in tests, a fake embedder)
 */
export const layerWith = (config: IndexerConfig) => Layer.effect(Indexer, makeWith(config))
