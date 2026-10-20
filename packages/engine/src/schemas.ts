import { Effect, Schema } from "effect"

// Repository tracking mode - tracks a branch (auto-updates on sync)
export const TrackingMode = Schema.Struct({
  _tag: Schema.Literal("tracking"),
  branch: Schema.String // e.g., "main", "master"
})

// Pinned mode - pinned to a specific tag or commit SHA
export const PinnedMode = Schema.Struct({
  _tag: Schema.Literal("pinned"),
  ref: Schema.String // tag or commit SHA
})

// Union of tracking modes
export const RepoMode = Schema.Union([TrackingMode, PinnedMode])

// Repository metadata
export const RepoConfig = Schema.Struct({
  id: Schema.String, // unique identifier (derived from URL)
  url: Schema.String, // GitHub URL
  localPath: Schema.String, // ~/.repobase/repos/<id>
  mode: RepoMode,
  lastSyncedCommit: Schema.OptionFromNullOr(Schema.String),
  lastSyncedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
  lastSyncedCommitAt: Schema.optional(Schema.DateTimeUtcFromMillis),
  addedAt: Schema.DateTimeUtcFromMillis,
  // Cloud sync fields - wip
  cloudEnabled: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.succeed(false))),
  lastPushedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
  lastPushedCommit: Schema.OptionFromNullOr(Schema.String),
  indexFormat: Schema.Number.pipe(Schema.withDecodingDefaultType(Effect.succeed(1)))
})

// Full store configuration
export const RepoStoreData = Schema.Struct({
  version: Schema.Literal(1),
  repos: Schema.Array(RepoConfig)
})

// Cloud configuration stored at ~/.repobase/cloud.json
export const CloudConfig = Schema.Struct({
  userId: Schema.String,
  apiKey: Schema.OptionFromNullOr(Schema.String),
  endpoint: Schema.String
})

// Manifest for tracking synced files per repo
export const SyncManifestFile = Schema.Struct({
  checksum: Schema.String,
  size: Schema.Number
})

export const SyncManifest = Schema.Struct({
  version: Schema.Literal(1),
  lastUpdated: Schema.DateTimeUtcFromMillis,
  files: Schema.Record(Schema.String, SyncManifestFile)
})

// A file change from git diff: Added, Modified or Deleted (renames arrive as D + A)
export const FileChange = Schema.Struct({
  status: Schema.Literals(["A", "M", "D"]),
  path: Schema.String
})

// A file the indexer should (re-)index, identified by its content hash
export const IndexPlanFile = Schema.Struct({
  path: Schema.String,
  hash: Schema.String
})

// What an indexing run will change: files to embed and paths to drop.
// `skipped` counts files left alone (unchanged, binary, ignored or unreadable).
export const IndexPlan = Schema.Struct({
  toIndex: Schema.Array(IndexPlanFile),
  toDelete: Schema.Array(Schema.String),
  skipped: Schema.Number
})

// Result of indexing one batch of planned files. A planned file that is gone
// or binary by the time its batch runs is skipped and removed from the index.
export const IndexBatchResult = Schema.Struct({
  indexed: Schema.Number,
  skipped: Schema.Number
})

// Summary of an indexing operation
export const IndexSummary = Schema.Struct({
  repo: Schema.String,
  filesIndexed: Schema.Number,
  filesDeleted: Schema.Number,
  filesSkipped: Schema.Number,
  durationMs: Schema.Number
})

// Progress state for indexing operations
export const IndexingProgress = Schema.Struct({
  phase: Schema.Literals(["scanning", "indexing", "finalizing"]),
  filesProcessed: Schema.Number,
  totalFiles: Schema.Number,
  currentFile: Schema.optional(Schema.String)
})

// Search mode
export const SearchMode = Schema.Literals(["keyword", "semantic", "hybrid"])

// A single search result
export const SearchResult = Schema.Struct({
  repo: Schema.String,
  path: Schema.String,
  filename: Schema.String,
  score: Schema.Number,
  snippet: Schema.optional(Schema.String),
  // Lines of the best-matching chunk, 1-based and inclusive
  startLine: Schema.optional(Schema.Number),
  endLine: Schema.optional(Schema.Number)
})

// Stage of adding a repository
export const AddRepoStage = Schema.Literals(["cloning", "indexing", "complete", "error"])

// Progress state for adding a repository
export const AddRepoProgress = Schema.Struct({
  stage: AddRepoStage,
  progress: Schema.Number, // 0-100
  message: Schema.String,
  filesIndexed: Schema.optional(Schema.Number),
  totalFiles: Schema.optional(Schema.Number),
  currentFile: Schema.optional(Schema.String)
})

// Result of a sync operation
export const SyncResult = Schema.Struct({
  id: Schema.String,
  updated: Schema.Boolean,
  previousCommit: Schema.OptionFromNullOr(Schema.String),
  currentCommit: Schema.String,
  indexSummary: Schema.optional(IndexSummary)
})

// Derive types from schemas
export type TrackingMode = Schema.Schema.Type<typeof TrackingMode>
export type PinnedMode = Schema.Schema.Type<typeof PinnedMode>
export type RepoMode = Schema.Schema.Type<typeof RepoMode>
export type RepoConfig = Schema.Schema.Type<typeof RepoConfig>
export type RepoStoreData = Schema.Schema.Type<typeof RepoStoreData>
export type CloudConfig = Schema.Schema.Type<typeof CloudConfig>
export type SyncManifestFile = Schema.Schema.Type<typeof SyncManifestFile>
export type SyncManifest = Schema.Schema.Type<typeof SyncManifest>
export type FileChange = Schema.Schema.Type<typeof FileChange>
export type IndexPlanFile = Schema.Schema.Type<typeof IndexPlanFile>
export type IndexPlan = Schema.Schema.Type<typeof IndexPlan>
export type IndexBatchResult = Schema.Schema.Type<typeof IndexBatchResult>
export type IndexSummary = Schema.Schema.Type<typeof IndexSummary>
export type IndexingProgress = Schema.Schema.Type<typeof IndexingProgress>
export type SearchMode = Schema.Schema.Type<typeof SearchMode>
export type SearchResult = Schema.Schema.Type<typeof SearchResult>
export type AddRepoStage = Schema.Schema.Type<typeof AddRepoStage>
export type AddRepoProgress = Schema.Schema.Type<typeof AddRepoProgress>
export type SyncResult = Schema.Schema.Type<typeof SyncResult>
