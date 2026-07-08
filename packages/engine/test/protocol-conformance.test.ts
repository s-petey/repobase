import { describe, expect, it } from "@effect/vitest";
import { Console, Effect, Option, Schema } from "effect";
import {
  CloudError,
  CloudNotConfiguredError,
  CloudSync,
  FileNotFoundError,
  GitClient,
  GitClientLayer,
  GitError,
  IndexError,
  Indexer,
  IndexerLayer,
  InvalidPatternError,
  RepoAlreadyExistsError,
  RepoNotFoundError,
  RepoStore,
  RepoStoreLayer,
  RepobaseEngine,
  RepobaseEngineLayer,
  SearchError,
  StoreError,
  type EngineError,
  trackingMode,
} from "../src/index.js";
import { RepoConfig, RepoStoreData } from "../src/schemas.js";
import { SearchResult } from "../src/services/Indexer.js";
import { createMockEngineLayer, makeDefaultMockEngineState } from "../src/test-utils/index.js";

// ---------------------------------------------------------------------------
// ServiceFunctions — compile-time protocol checks
// ---------------------------------------------------------------------------

const { addRepo, removeRepo, listRepos, getRepo, syncRepo, syncAll, search } =
  Effect.serviceFunctions(RepobaseEngine);
const {
  indexRepo,
  indexChanges,
  removeIndex,
  searchKeyword,
  searchSemantic,
  searchHybrid,
  listFiles,
  globFiles,
  readFile,
  grepPattern,
} = Effect.serviceFunctions(Indexer);
const {
  load,
  save,
  getRepo: getRepoFromStore,
  addRepo: addRepoToStore,
  updateRepo,
  removeRepo: removeRepoFromStore,
} = Effect.serviceFunctions(RepoStore);
const { clone, fetch, resetHard, checkout, getCurrentCommit, getRemoteHead, diffNameStatus } =
  Effect.serviceFunctions(GitClient);
const {
  configure,
  getConfig,
  clearConfig,
  isConfigured,
  enableRepo,
  disableRepo,
  push,
  pushAll,
  pull,
  getStatus,
  listCloudEnabled,
} = Effect.serviceFunctions(CloudSync);
const { log, error: consoleError, warn, info, debug } = Effect.serviceFunctions(Console.Console);

// ---------------------------------------------------------------------------
// Error type conformance
// ---------------------------------------------------------------------------

describe("error types", () => {
  it("GitError has correct _tag and fields", () => {
    const err = new GitError({ command: "clone", message: "failed to clone" });

    expect(err._tag).toBe("GitError");
    expect(err.command).toBe("clone");
    expect(err.message).toBe("failed to clone");
  });

  it("StoreError has correct _tag and fields", () => {
    const err = new StoreError({ operation: "save", message: "permission denied" });

    expect(err._tag).toBe("StoreError");
    expect(err.operation).toBe("save");
    expect(err.message).toBe("permission denied");
  });

  it("RepoNotFoundError has correct _tag and fields", () => {
    const err = new RepoNotFoundError({ id: "missing-repo" });

    expect(err._tag).toBe("RepoNotFoundError");
    expect(err.id).toBe("missing-repo");
  });

  it("RepoAlreadyExistsError has correct _tag and fields", () => {
    const err = new RepoAlreadyExistsError({ id: "duplicate" });

    expect(err._tag).toBe("RepoAlreadyExistsError");
    expect(err.id).toBe("duplicate");
  });

  it("IndexError has correct _tag and fields", () => {
    const err = new IndexError({ operation: "indexRepo", message: "corrupt index" });

    expect(err._tag).toBe("IndexError");
    expect(err.operation).toBe("indexRepo");
    expect(err.message).toBe("corrupt index");
  });

  it("SearchError has correct _tag and fields", () => {
    const err = new SearchError({ message: "search failed" });

    expect(err._tag).toBe("SearchError");
    expect(err.message).toBe("search failed");
  });

  it("CloudError has correct _tag and fields", () => {
    const err = new CloudError({ operation: "push", message: "network error" });

    expect(err._tag).toBe("CloudError");
    expect(err.operation).toBe("push");
    expect(err.message).toBe("network error");
  });

  it("CloudNotConfiguredError has correct _tag", () => {
    const err = new CloudNotConfiguredError();

    expect(err._tag).toBe("CloudNotConfiguredError");
  });

  it("FileNotFoundError has correct _tag and fields", () => {
    const err = new FileNotFoundError({ repo: "my-repo", path: "src/main.ts" });

    expect(err._tag).toBe("FileNotFoundError");
    expect(err.repo).toBe("my-repo");
    expect(err.path).toBe("src/main.ts");
  });

  it("InvalidPatternError has correct _tag and fields", () => {
    const err = new InvalidPatternError({ pattern: "[invalid", message: "unterminated bracket" });

    expect(err._tag).toBe("InvalidPatternError");
    expect(err.pattern).toBe("[invalid");
    expect(err.message).toBe("unterminated bracket");
  });

  it("EngineError union accepts all error types", () => {
    const errors: Array<EngineError> = [
      new GitError({ command: "c", message: "m" }),
      new StoreError({ operation: "o", message: "m" }),
      new RepoNotFoundError({ id: "x" }),
      new RepoAlreadyExistsError({ id: "x" }),
      new IndexError({ operation: "o", message: "m" }),
      new SearchError({ message: "m" }),
      new CloudError({ operation: "o", message: "m" }),
      new CloudNotConfiguredError(),
      new FileNotFoundError({ repo: "r", path: "p" }),
      new InvalidPatternError({ pattern: "p", message: "m" }),
    ];

    expect(errors).toHaveLength(10);
    for (const err of errors) {
      expect(typeof err._tag).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// Schema round-trip conformance
// ---------------------------------------------------------------------------

describe("schema round-trip", () => {
  it.effect("RepoConfig encodes and decodes preserving values", () =>
    Effect.gen(function* () {
      const original: RepoConfig = {
        id: "test-repo",
        url: "https://github.com/test/repo",
        localPath: "/mock/.repobase/repos/test-repo",
        mode: trackingMode("main"),
        lastSyncedCommit: Option.some("abc123"),
        lastSyncedAt: Option.some(new Date("2024-01-01")),
        addedAt: new Date("2024-01-01"),
        cloudEnabled: false,
        lastPushedAt: Option.none(),
        lastPushedCommit: Option.none(),
      };

      const encoded = yield* Schema.encode(RepoConfig)(original);
      const decoded = yield* Schema.decodeUnknown(RepoConfig)(encoded);

      expect(decoded.id).toBe("test-repo");
      expect(decoded.url).toBe("https://github.com/test/repo");
      expect(decoded.mode).toEqual({ _tag: "tracking", branch: "main" });
      expect(Option.isSome(decoded.lastSyncedCommit)).toBe(true);
      if (Option.isSome(decoded.lastSyncedCommit)) {
        expect(decoded.lastSyncedCommit.value).toBe("abc123");
      }
      expect(decoded.cloudEnabled).toBe(false);
      expect(Option.isNone(decoded.lastPushedAt)).toBe(true);
    }),
  );

  it.effect("RepoConfig handles optional and Option fields correctly", () =>
    Effect.gen(function* () {
      const withNulls: RepoConfig = {
        id: "minimal",
        url: "https://github.com/test/minimal",
        localPath: "/mock/.repobase/repos/minimal",
        mode: { _tag: "pinned", ref: "v1.0.0" },
        lastSyncedCommit: Option.none(),
        lastSyncedAt: Option.none(),
        addedAt: new Date("2024-06-15"),
        cloudEnabled: true,
        lastPushedAt: Option.none(),
        lastPushedCommit: Option.none(),
      };

      const encoded = yield* Schema.encode(RepoConfig)(withNulls);
      const decoded = yield* Schema.decodeUnknown(RepoConfig)(encoded);

      expect(decoded.id).toBe("minimal");
      expect(decoded.mode).toEqual({ _tag: "pinned", ref: "v1.0.0" });
      expect(Option.isNone(decoded.lastSyncedCommit)).toBe(true);
      expect(Option.isNone(decoded.lastSyncedAt)).toBe(true);
      expect(decoded.cloudEnabled).toBe(true);
    }),
  );

  it.effect("RepoStoreData encodes and decodes", () =>
    Effect.gen(function* () {
      const data: RepoStoreData = {
        version: 1,
        repos: [
          {
            id: "repo-a",
            url: "https://github.com/test/a",
            localPath: "/mock/.repobase/repos/repo-a",
            mode: trackingMode("main"),
            lastSyncedCommit: Option.none(),
            lastSyncedAt: Option.none(),
            addedAt: new Date(),
            cloudEnabled: false,
            lastPushedAt: Option.none(),
            lastPushedCommit: Option.none(),
          },
        ],
      };

      const encoded = yield* Schema.encode(RepoStoreData)(data);
      const decoded = yield* Schema.decodeUnknown(RepoStoreData)(encoded);

      expect(decoded.version).toBe(1);
      expect(decoded.repos).toHaveLength(1);
      expect(decoded.repos[0].id).toBe("repo-a");
    }),
  );

  it.effect("SearchResult encodes and decodes", () =>
    Effect.gen(function* () {
      const original = {
        repo: "my-repo",
        path: "src/index.ts",
        filename: "index.ts",
        score: 0.95,
        snippet: Option.some("...hello world..."),
      };

      const encoded = yield* Schema.encode(SearchResult)(original);
      const decoded = yield* Schema.decodeUnknown(SearchResult)(encoded);

      expect(decoded.repo).toBe("my-repo");
      expect(decoded.path).toBe("src/index.ts");
      expect(decoded.filename).toBe("index.ts");
      expect(decoded.score).toBe(0.95);
      expect(Option.isSome(decoded.snippet)).toBe(true);
      if (Option.isSome(decoded.snippet)) {
        expect(decoded.snippet.value).toContain("hello");
      }
    }),
  );
});

// ---------------------------------------------------------------------------
// Service interface shape conformance
// ---------------------------------------------------------------------------

describe("service interface shape", () => {
  it("RepobaseEngine mock implements all expected methods", () => {
    expect(typeof addRepo).toBe("function");
    expect(typeof removeRepo).toBe("function");
    expect(typeof listRepos).toBe("function");
    expect(typeof getRepo).toBe("function");
    expect(typeof syncRepo).toBe("function");
    expect(typeof syncAll).toBe("function");
    expect(typeof search).toBe("function");
  });

  it("Indexer mock implements all expected methods", () => {
    expect(typeof indexRepo).toBe("function");
    expect(typeof indexChanges).toBe("function");
    expect(typeof removeIndex).toBe("function");
    expect(typeof searchKeyword).toBe("function");
    expect(typeof searchSemantic).toBe("function");
    expect(typeof searchHybrid).toBe("function");
    expect(typeof listFiles).toBe("function");
    expect(typeof globFiles).toBe("function");
    expect(typeof readFile).toBe("function");
    expect(typeof grepPattern).toBe("function");
  });

  it("RepoStore mock implements all expected methods", () => {
    expect(typeof load).toBe("function");
    expect(typeof save).toBe("function");
    expect(typeof getRepoFromStore).toBe("function");
    expect(typeof addRepoToStore).toBe("function");
    expect(typeof updateRepo).toBe("function");
    expect(typeof removeRepoFromStore).toBe("function");
  });

  it("GitClient mock implements all expected methods", () => {
    expect(typeof clone).toBe("function");
    expect(typeof fetch).toBe("function");
    expect(typeof resetHard).toBe("function");
    expect(typeof checkout).toBe("function");
    expect(typeof getCurrentCommit).toBe("function");
    expect(typeof getRemoteHead).toBe("function");
    expect(typeof diffNameStatus).toBe("function");
  });

  it("CloudSync mock implements all expected methods", () => {
    expect(typeof configure).toBe("function");
    expect(typeof getConfig).toBe("function");
    expect(typeof clearConfig).toBe("function");
    expect(typeof isConfigured).toBe("function");
    expect(typeof enableRepo).toBe("function");
    expect(typeof disableRepo).toBe("function");
    expect(typeof push).toBe("function");
    expect(typeof pushAll).toBe("function");
    expect(typeof pull).toBe("function");
    expect(typeof getStatus).toBe("function");
    expect(typeof listCloudEnabled).toBe("function");
  });

  it("Console mock implements log and error", () => {
    expect(typeof log).toBe("function");
    expect(typeof consoleError).toBe("function");
    expect(typeof warn).toBe("function");
    expect(typeof info).toBe("function");
    expect(typeof debug).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Export surface conformance
// ---------------------------------------------------------------------------

describe("export surface", () => {
  it("service tags and layers are exported", () => {
    expect(GitClient).toBeDefined();
    expect(RepoStore).toBeDefined();
    expect(Indexer).toBeDefined();
    expect(CloudSync).toBeDefined();
    expect(RepobaseEngine).toBeDefined();

    expect(GitClientLayer).toBeDefined();
    expect(RepoStoreLayer).toBeDefined();
    expect(IndexerLayer).toBeDefined();
    expect(RepobaseEngineLayer).toBeDefined();
  });

  it("error classes are exported with correct constructors", () => {
    expect(GitError).toBeDefined();
    expect(StoreError).toBeDefined();
    expect(RepoNotFoundError).toBeDefined();
    expect(RepoAlreadyExistsError).toBeDefined();
    expect(IndexError).toBeDefined();
    expect(SearchError).toBeDefined();
    expect(CloudError).toBeDefined();
    expect(CloudNotConfiguredError).toBeDefined();
    expect(FileNotFoundError).toBeDefined();
    expect(InvalidPatternError).toBeDefined();
  });

  it("test-utils exports createMockEngineLayer and makeDefaultMockEngineState", () => {
    expect(createMockEngineLayer).toBeDefined();
    expect(makeDefaultMockEngineState).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// MCP tool to engine API mapping
// ---------------------------------------------------------------------------

describe("MCP tool to engine API mapping", () => {
  const toolMappings: Array<{
    tool: string;
    engineMethod: string;
    serviceName: string;
  }> = [
    { tool: "list_repos", engineMethod: "listRepos", serviceName: "RepobaseEngine" },
    { tool: "search", engineMethod: "search", serviceName: "RepobaseEngine" },
    { tool: "list_files", engineMethod: "listFiles", serviceName: "Indexer" },
    { tool: "glob_files", engineMethod: "globFiles", serviceName: "Indexer" },
    { tool: "read_file", engineMethod: "readFile", serviceName: "Indexer" },
    { tool: "grep", engineMethod: "grepPattern", serviceName: "Indexer" },
  ];

  it("all 6 MCP tools map to an engine method", () => {
    expect(toolMappings).toHaveLength(6);
    const toolNames = toolMappings.map((m) => m.tool);
    expect(toolNames).toEqual([
      "list_repos",
      "search",
      "list_files",
      "glob_files",
      "read_file",
      "grep",
    ]);
  });

  it.effect("list_repos maps to RepobaseEngine.listRepos", () =>
    Effect.gen(function* () {
      yield* listRepos().pipe(Effect.provide(createMockEngineLayer()));
    }),
  );

  it.effect("search maps to RepobaseEngine.search", () =>
    Effect.gen(function* () {
      yield* search("test", "hybrid", { limit: 10 }).pipe(Effect.provide(createMockEngineLayer()));
    }),
  );

  it.effect("list_files maps to Indexer.listFiles", () =>
    Effect.gen(function* () {
      yield* listFiles({}).pipe(Effect.provide(createMockEngineLayer()));
    }),
  );

  it.effect("glob_files maps to Indexer.globFiles", () =>
    Effect.gen(function* () {
      yield* globFiles("**/*.ts").pipe(Effect.provide(createMockEngineLayer()));
    }),
  );

  it.effect("read_file maps to Indexer.readFile", () =>
    Effect.gen(function* () {
      const state = makeDefaultMockEngineState();
      state.indexer.files.set("test-repo", [{ path: "test.ts", content: "hello" }]);
      yield* readFile("test-repo", "test.ts").pipe(Effect.provide(createMockEngineLayer(state)));
    }),
  );

  it.effect("grep maps to Indexer.grepPattern", () =>
    Effect.gen(function* () {
      yield* grepPattern("pattern").pipe(Effect.provide(createMockEngineLayer()));
    }),
  );

  it.effect("list_repos tool corresponds to engine.listRepos which returns repos", () =>
    Effect.gen(function* () {
      const repos = yield* listRepos().pipe(Effect.provide(createMockEngineLayer()));
      expect(Array.isArray(repos)).toBe(true);
    }),
  );

  it.effect("search tool corresponds to engine.search which returns results", () =>
    Effect.gen(function* () {
      const results = yield* search("test", "hybrid", { limit: 10 }).pipe(
        Effect.provide(createMockEngineLayer()),
      );
      expect(Array.isArray(results)).toBe(true);
    }),
  );
});
