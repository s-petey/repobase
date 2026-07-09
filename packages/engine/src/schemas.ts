import { ParseResult, Schema } from "effect"
import { extractRepoParts } from "./utils.js"

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
export const RepoMode = Schema.Union(TrackingMode, PinnedMode)

// Schema to decompose a GitHub URL into owner and name parts
export const GitHubUrlSchema = Schema.transformOrFail(
  Schema.String,
  Schema.Struct({ owner: Schema.String, name: Schema.String }),
  {
    decode: (input, _, ast) => {
      try {
        return ParseResult.succeed(extractRepoParts(input))
      } catch {
        return ParseResult.fail(new ParseResult.Type(ast, input, `Invalid GitHub URL: ${input}`))
      }
    },
    encode: ({ owner, name }) => ParseResult.succeed(`https://github.com/${owner}/${name}`)
  }
)

// Fields common to all repo config versions
const RepoConfigBaseFields = {
  id: Schema.String,
  url: Schema.String,
  localPath: Schema.String,
  mode: RepoMode,
  lastSyncedCommit: Schema.OptionFromNullOr(Schema.String),
  lastSyncedAt: Schema.OptionFromNullOr(Schema.DateFromNumber),
  addedAt: Schema.DateFromNumber,
  cloudEnabled: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  lastPushedAt: Schema.OptionFromNullOr(Schema.DateFromNumber),
  lastPushedCommit: Schema.OptionFromNullOr(Schema.String),
} as const

// Legacy format — owner/name may be missing (pre-migration data)
const RepoConfigV1 = Schema.Struct({
  ...RepoConfigBaseFields,
})

// Current in-app format — owner/name are always present
export const RepoConfig = Schema.Struct({
  ...RepoConfigBaseFields,
  owner: Schema.String,
  name: Schema.String,
})

// Legacy store (for decoding old config files)
export const RepoStoreDataV1 = Schema.Struct({
  version: Schema.Literal(1),
  repos: Schema.Array(RepoConfigV1),
})

// Current store
export const RepoStoreData = Schema.Struct({
  version: Schema.Literal(1),
  repos: Schema.Array(RepoConfig),
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
  lastUpdated: Schema.DateFromNumber,
  files: Schema.Record({ key: Schema.String, value: SyncManifestFile })
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
