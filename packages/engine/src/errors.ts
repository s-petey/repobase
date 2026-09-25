import { Schema } from "effect"

// Errors are Schema classes so they can be encoded across worker threads and
// into job checkpoints; constructors and fields are unchanged for callers.

/**
 * Error from git command execution
 */
export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  command: Schema.String,
  message: Schema.String
}) {}

/**
 * Error from store operations (load/save config)
 */
export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  operation: Schema.String,
  message: Schema.String
}) {}

/**
 * Repository not found in store
 */
export class RepoNotFoundError extends Schema.TaggedError<RepoNotFoundError>()("RepoNotFoundError", {
  id: Schema.String
}) {}

/**
 * Repository already exists in store
 */
export class RepoAlreadyExistsError extends Schema.TaggedError<RepoAlreadyExistsError>()(
  "RepoAlreadyExistsError",
  {
    id: Schema.String
  }
) {}

/**
 * Error from indexing operations
 */
export class IndexError extends Schema.TaggedError<IndexError>()("IndexError", {
  operation: Schema.String,
  message: Schema.String,
  // The file being processed when the error happened, if any
  path: Schema.optional(Schema.String)
}) {}

/**
 * Error from search operations
 */
export class SearchError extends Schema.TaggedError<SearchError>()("SearchError", {
  message: Schema.String
}) {}

/**
 * Error from cloud sync operations
 */
export class CloudError extends Schema.TaggedError<CloudError>()("CloudError", {
  operation: Schema.String,
  message: Schema.String
}) {}

/**
 * Cloud sync not configured
 */
export class CloudNotConfiguredError extends Schema.TaggedError<CloudNotConfiguredError>()(
  "CloudNotConfiguredError",
  {}
) {}

/**
 * File not found in index or on disk
 */
export class FileNotFoundError extends Schema.TaggedError<FileNotFoundError>()("FileNotFoundError", {
  repo: Schema.String,
  path: Schema.String
}) {}

/**
 * Invalid pattern (e.g., malformed regex or glob)
 */
export class InvalidPatternError extends Schema.TaggedError<InvalidPatternError>()(
  "InvalidPatternError",
  {
    pattern: Schema.String,
    message: Schema.String
  }
) {}

/**
 * Union of all engine errors
 */
export type EngineError =
  | GitError
  | StoreError
  | RepoNotFoundError
  | RepoAlreadyExistsError
  | IndexError
  | SearchError
  | CloudError
  | CloudNotConfiguredError
  | FileNotFoundError
  | InvalidPatternError
