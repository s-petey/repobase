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
  lastSyncedAt: Schema.OptionFromNullOr(Schema.DateFromMillis),
  addedAt: Schema.DateFromMillis,
  // Cloud sync fields - wip
  cloudEnabled: Schema.Boolean.pipe(Schema.withDecodingDefaultType(Effect.succeed(false))),
  lastPushedAt: Schema.OptionFromNullOr(Schema.DateFromMillis),
  lastPushedCommit: Schema.OptionFromNullOr(Schema.String)
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
  lastUpdated: Schema.DateFromMillis,
  files: Schema.Record(Schema.String, SyncManifestFile)
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
