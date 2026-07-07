import { Effect, Layer, Option } from "effect";
import { FileNotFoundError, InvalidPatternError } from "../errors.js";
import type { FileChange } from "../services/GitClient.js";
import type {
  FileContent,
  FileInfo,
  GlobOptions,
  GrepMatch,
  GrepOptions,
  GrepResult,
  IndexOptions,
  IndexSummary,
  ListFilesOptions,
  SearchOptions,
  SearchResult,
} from "../services/Indexer.js";
import { Indexer } from "../services/Indexer.js";

export interface MockFileEntry {
  content: string;
  path: string;
}

export interface MockIndexerState {
  indexes: Map<string, IndexSummary>;
  searchResults: SearchResult[];
  files: Map<string, MockFileEntry[]>;
  listFilesResponse: FileInfo[];
  globFilesResponse: FileInfo[];
  grepResults: GrepResult[];
}

export const makeDefaultIndexerState = (): MockIndexerState => ({
  indexes: new Map(),
  searchResults: [],
  files: new Map(),
  listFilesResponse: [],
  globFilesResponse: [],
  grepResults: [],
});

export const mockIndexerLayer = (
  state: MockIndexerState = makeDefaultIndexerState(),
): Layer.Layer<Indexer> =>
  Layer.succeed(
    Indexer,
    Indexer.of({
      indexRepo: (repoId: string, _repoPath: string, _options?: IndexOptions) =>
        Effect.sync(() => {
          const existing = state.indexes.get(repoId);
          const summary: IndexSummary = {
            repo: repoId,
            filesIndexed: 3,
            filesDeleted: 0,
            filesSkipped: 0,
            durationMs: 100,
            ...existing,
          };
          state.indexes.set(repoId, summary);
          return summary;
        }),

      indexChanges: (repoId: string, _repoPath: string, changes: FileChange[]) =>
        Effect.succeed({
          repo: repoId,
          filesIndexed: changes.filter((c) => c.status !== "D").length,
          filesDeleted: changes.filter((c) => c.status === "D").length,
          filesSkipped: 0,
          durationMs: 50,
        }),

      removeIndex: (repoId: string) =>
        Effect.sync(() => {
          state.indexes.delete(repoId);
        }),

      searchKeyword: (query: string, options?: SearchOptions) => {
        const results =
          state.searchResults.length > 0
            ? state.searchResults
            : [
                {
                  repo: "mock-repo",
                  path: "src/file.ts",
                  filename: "file.ts",
                  score: 0.95,
                  snippet: Option.some(`...${query}...`),
                },
              ];
        return Effect.succeed(
          options?.repo ? results.filter((r) => r.repo === options.repo) : results,
        );
      },

      searchSemantic: (query: string, options?: SearchOptions) => {
        const results =
          state.searchResults.length > 0
            ? state.searchResults
            : [
                {
                  repo: "mock-repo",
                  path: "src/utils.ts",
                  filename: "utils.ts",
                  score: 0.85,
                  snippet: Option.some(`...semantic match for ${query}...`),
                },
              ];
        return Effect.succeed(
          options?.repo ? results.filter((r) => r.repo === options.repo) : results,
        );
      },

      searchHybrid: (query: string, options?: SearchOptions) => {
        const results =
          state.searchResults.length > 0
            ? state.searchResults
            : [
                {
                  repo: "mock-repo",
                  path: "src/index.ts",
                  filename: "index.ts",
                  score: 0.9,
                  snippet: Option.some(`...hybrid result for ${query}...`),
                },
              ];
        return Effect.succeed(
          options?.repo ? results.filter((r) => r.repo === options.repo) : results,
        );
      },

      listFiles: (_options: ListFilesOptions) =>
        Effect.succeed(state.listFilesResponse.length > 0 ? state.listFilesResponse : []),

      globFiles: (pattern: string, _options?: GlobOptions) =>
        state.globFilesResponse.length > 0
          ? (Effect.succeed(state.globFilesResponse) as Effect.Effect<
              readonly FileInfo[],
              InvalidPatternError
            >)
          : (Effect.succeed([
              {
                repo: "mock-repo",
                path: pattern,
                filename: pattern.split("/").pop() ?? pattern,
                isDirectory: false,
                size: 512,
              },
            ]) as Effect.Effect<readonly FileInfo[], InvalidPatternError>),

      readFile: (
        repo: string,
        filePath: string,
        _options?: { offset?: number; limit?: number; lineNumbers?: boolean },
      ) => {
        const entries = state.files.get(repo);
        const entry = entries?.find((f) => f.path === filePath);
        if (entry) {
          return Effect.succeed({
            repo,
            path: filePath,
            content: entry.content,
            totalLines: entry.content.split("\n").length,
            startLine: 1,
            endLine: entry.content.split("\n").length,
          } as FileContent);
        }
        return Effect.fail(new FileNotFoundError({ repo, path: filePath })) as Effect.Effect<
          FileContent,
          FileNotFoundError
        >;
      },

      grepPattern: (pattern: string, _options?: GrepOptions) =>
        state.grepResults.length > 0
          ? (Effect.succeed(state.grepResults) as Effect.Effect<
              readonly GrepResult[],
              InvalidPatternError
            >)
          : (Effect.succeed([
              {
                repo: "mock-repo",
                path: "src/file.ts",
                matchCount: 1,
                matches: [
                  {
                    lineNumber: 42,
                    content: `  const match = "${pattern}"`,
                    isMatch: true,
                  } as GrepMatch,
                  {
                    lineNumber: 43,
                    content: "  // context line",
                    isMatch: false,
                  } as GrepMatch,
                ],
              },
            ]) as Effect.Effect<readonly GrepResult[], InvalidPatternError>),
    }),
  );
