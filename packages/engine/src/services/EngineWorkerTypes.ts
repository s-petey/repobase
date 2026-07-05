import { Schema } from "effect";
import { RepoConfig } from "../schemas";
import { SearchResult } from "./Indexer";
import { AddRepoStage, SyncResult } from "./RepobaseEngine";

const RepoActions = Schema.Literal('addRepo', 'removeRepo', 'syncRepo', 'syncAll', 'listRepos', 'getRepo', 'search')
export type RepoAction = Schema.Schema.Type<typeof RepoActions>

// ── Worker Input: what the main thread sends ─────────────

export const AddRepoInput = Schema.TaggedStruct(RepoActions.pipe(Schema.pickLiteral('addRepo')).Type, {
  url: Schema.String,
})

export const RemoveRepoInput = Schema.TaggedStruct(RepoActions.pipe(Schema.pickLiteral('removeRepo')).Type, {
  id: Schema.String,
})

export const SyncRepoInput = Schema.TaggedStruct(RepoActions.pipe(Schema.pickLiteral('syncRepo')).Type, {
  id: Schema.String,
})

export const SyncAllInput = Schema.TaggedStruct(RepoActions.pipe(Schema.pickLiteral('syncAll')).Type, {})

export const ListReposInput = Schema.TaggedStruct(RepoActions.pipe(Schema.pickLiteral('listRepos')).Type, {})

export const GetRepoInput = Schema.TaggedStruct(RepoActions.pipe(Schema.pickLiteral('getRepo')).Type, {
  id: Schema.String,
})

export const SearchInput = Schema.TaggedStruct(RepoActions.pipe(Schema.pickLiteral('search')).Type, {
  query: Schema.String,
  mode: Schema.Literal("keyword", "semantic", "hybrid"),
  limit: Schema.optional(Schema.Number),
  repo: Schema.optional(Schema.String),
})

export const WorkerInput = Schema.Union(
  AddRepoInput,
  RemoveRepoInput,
  SyncRepoInput,
  SyncAllInput,
  ListReposInput,
  GetRepoInput,
  SearchInput,
)

export type WorkerInput = Schema.Schema.Type<typeof WorkerInput>

// ── Worker Output: events streamed back ────────────────

const AddRepoOutput = Schema.TaggedStruct(RepoActions.pipe(Schema.pickLiteral('addRepo')).Type, {
  data: RepoConfig
})
export type AddRepoOutput = Schema.Schema.Type<typeof AddRepoOutput>

export const RemoveRepoOutput = Schema.TaggedStruct(RepoActions.pipe(Schema.pickLiteral('removeRepo')).Type, {
  data: Schema.Null
})
export type RemoveRepoOutput = Schema.Schema.Type<typeof RemoveRepoOutput>

export const SyncRepoOutput = Schema.TaggedStruct(RepoActions.pipe(Schema.pickLiteral('syncRepo')).Type, {
  data: SyncResult
})
export type SyncRepoOutput = Schema.Schema.Type<typeof SyncRepoOutput>

export const SyncAllOutput = Schema.TaggedStruct(RepoActions.pipe(Schema.pickLiteral('syncAll')).Type, {
  data: Schema.Array(SyncResult)
})
export type SyncAllOutput = Schema.Schema.Type<typeof SyncAllOutput>

export const ListReposOutput = Schema.TaggedStruct(RepoActions.pipe(Schema.pickLiteral('listRepos')).Type, {
  data: Schema.Array(RepoConfig)
})
export type ListReposOutput = Schema.Schema.Type<typeof ListReposOutput>

export const GetRepoOutput = Schema.TaggedStruct(RepoActions.pipe(Schema.pickLiteral('getRepo')).Type, {
  data: Schema.Option(RepoConfig)
})
export type GetRepoOutput = Schema.Schema.Type<typeof GetRepoOutput>

export const SearchOutput = Schema.TaggedStruct(RepoActions.pipe(Schema.pickLiteral('search')).Type, {
  data: Schema.Array(SearchResult)
})
export type SearchOutput = Schema.Schema.Type<typeof SearchOutput>

export const ProgressEventSchema = Schema.TaggedStruct("Progress", {
  stage: AddRepoStage,
  message: Schema.String,
  progress: Schema.Number,
})
export type ProgressEventSchema = Schema.Schema.Type<typeof ProgressEventSchema>

export const ResultEventSchema = Schema.TaggedStruct("Result", {
    data: Schema.Union(
      AddRepoOutput,
      RemoveRepoOutput,
      SyncRepoOutput,
      SyncAllOutput,
      ListReposOutput,
      GetRepoOutput,
      SearchOutput,
    ),
})
export type ResultEvent = Schema.Schema.Type<typeof ResultEventSchema>

export const ErrorEventSchema = Schema.TaggedStruct("Error", {
  message: Schema.String,
})

export const WorkerEvent = Schema.Union(
  ProgressEventSchema,
  ResultEventSchema,
  ErrorEventSchema,
)

export type WorkerEvent = Schema.Schema.Type<typeof WorkerEvent>

export type WorkerOutputByTag = {
  "addRepo": AddRepoOutput
  "removeRepo": RemoveRepoOutput
  "syncRepo": SyncRepoOutput
  "syncAll": SyncAllOutput
  "listRepos": ListReposOutput
  "getRepo": GetRepoOutput
  "search": SearchOutput
}
