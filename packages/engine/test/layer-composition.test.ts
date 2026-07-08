import { FileSystem } from "@effect/platform";
import { describe, expect, it } from "@effect/vitest";
import { Console, Effect, Layer, Option } from "effect";
import {
  CloudSync,
  GitClient,
  Indexer,
  RepobaseEngine,
  RepoStore,
  trackingMode,
  type RepoConfig,
} from "../src/index.js";
import { layer as RepoStoreLayer } from "../src/services/RepoStore.js";
import {
  createMockEngineLayer,
  makeCapturedConsole,
  makeDefaultFsState,
  makeDefaultMockEngineState,
  mockFileSystem,
  mockGitClientLayer,
  mockRepoStoreLayer,
  silentLoggerLayer,
  testConsoleLayer,
} from "../src/test-utils/index.js";

const { clone } = Effect.serviceFunctions(GitClient);
const { load, addRepo, updateRepo, getRepo } = Effect.serviceFunctions(RepoStore);
const { configure } = Effect.serviceFunctions(CloudSync);
const { listRepos } = Effect.serviceFunctions(RepobaseEngine);
const { log, error: consoleError } = Effect.serviceFunctions(Console.Console);

const createTestRepo = (id: string, overrides?: Partial<RepoConfig>): RepoConfig => ({
  id,
  url: `https://github.com/test/${id}`,
  localPath: `/mock/.repobase/repos/${id}`,
  mode: trackingMode("main"),
  lastSyncedCommit: Option.some("mock-init"),
  lastSyncedAt: Option.some(new Date()),
  addedAt: new Date(),
  cloudEnabled: false,
  lastPushedAt: Option.none(),
  lastPushedCommit: Option.none(),
  ...overrides,
});

describe("mock layer composition", () => {
  it.effect("provides GitClient service", () =>
    Effect.gen(function* () {
      const result = yield* clone("https://github.com/test/repo", "/tmp/repo").pipe(
        Effect.provide(createMockEngineLayer()),
      );
      expect(result).toBeUndefined();
    }),
  );

  it.effect("provides RepoStore service", () =>
    Effect.gen(function* () {
      const data = yield* load().pipe(Effect.provide(createMockEngineLayer()));
      expect(data.repos).toHaveLength(0);
    }),
  );

  it.effect("provides Indexer service", () =>
    Effect.gen(function* () {
      const { searchKeyword } = Effect.serviceFunctions(Indexer);
      const state = makeDefaultMockEngineState();
      state.indexer.searchResults = [
        {
          repo: "mock-repo",
          path: "src/file.ts",
          filename: "file.ts",
          score: 0.95,
          snippet: Option.some("...result..."),
        },
      ];
      const results = yield* searchKeyword("test").pipe(
        Effect.provide(createMockEngineLayer(state)),
      );
      expect(results).toHaveLength(1);
    }),
  );

  it.effect("provides CloudSync service", () =>
    Effect.gen(function* () {
      const result = yield* configure({
        userId: "test-user",
        apiKey: "test-key",
        endpoint: "https://example.com",
      }).pipe(Effect.provide(createMockEngineLayer()));
      expect(result).toBeUndefined();
    }),
  );

  it.effect("provides RepobaseEngine service", () =>
    Effect.gen(function* () {
      const repos = yield* listRepos().pipe(Effect.provide(createMockEngineLayer()));
      expect(repos).toHaveLength(0);
    }),
  );

  it.effect("provides Console service", () =>
    Effect.gen(function* () {
      const captured = makeCapturedConsole();
      yield* log("test").pipe(Effect.provide(testConsoleLayer(captured)));
      expect(captured.logs.length).toBeGreaterThanOrEqual(1);
    }),
  );
});

describe("state behavior", () => {
  it.effect("default state has no repos", () =>
    Effect.gen(function* () {
      const repos = yield* listRepos().pipe(Effect.provide(createMockEngineLayer()));
      expect(repos).toHaveLength(0);
    }),
  );

  it.effect("custom state is respected", () =>
    Effect.gen(function* () {
      const state = makeDefaultMockEngineState();
      state.engine.repos.push(createTestRepo("alpha"));
      const repos = yield* listRepos().pipe(Effect.provide(createMockEngineLayer(state)));
      expect(repos).toHaveLength(1);
      expect(repos[0].id).toBe("alpha");
    }),
  );

  it.effect("state mutations persist within a single layer instance", () =>
    Effect.gen(function* () {
      const state = makeDefaultMockEngineState();
      const layer = createMockEngineLayer(state);
      yield* addRepo(createTestRepo("mutated")).pipe(Effect.provide(layer));
      const data = yield* load().pipe(Effect.provide(layer));
      expect(data.repos).toHaveLength(1);
      expect(data.repos[0].id).toBe("mutated");
    }),
  );

  it.effect("state is isolated between separate layer instances", () => {
    const stateA = makeDefaultMockEngineState();
    stateA.engine.repos.push(createTestRepo("repo-a"));
    const stateB = makeDefaultMockEngineState();
    stateB.engine.repos.push(createTestRepo("repo-b"));

    return Effect.all([
      listRepos().pipe(Effect.provide(createMockEngineLayer(stateA))),
      listRepos().pipe(Effect.provide(createMockEngineLayer(stateB))),
    ]).pipe(
      Effect.map(([reposA, reposB]) => {
        expect(reposA).toHaveLength(1);
        expect(reposA[0].id).toBe("repo-a");
        expect(reposB).toHaveLength(1);
        expect(reposB[0].id).toBe("repo-b");
      }),
    );
  });
});

describe("console capture", () => {
  it.effect("testConsoleLayer captures log output", () =>
    Effect.gen(function* () {
      const captured = makeCapturedConsole();
      yield* log("hello world").pipe(Effect.provide(testConsoleLayer(captured)));
      expect(captured.logs.length).toBeGreaterThanOrEqual(1);
    }),
  );

  it.effect("testConsoleLayer captures error output", () =>
    Effect.gen(function* () {
      const captured = makeCapturedConsole();
      yield* consoleError("error message").pipe(Effect.provide(testConsoleLayer(captured)));
      expect(captured.errors.length).toBeGreaterThanOrEqual(1);
    }),
  );

  it.effect("silentLoggerLayer can be merged with testConsoleLayer", () =>
    Effect.gen(function* () {
      const captured = makeCapturedConsole();
      const layer = Layer.mergeAll(testConsoleLayer(captured), silentLoggerLayer);
      yield* log("visible").pipe(Effect.provide(layer));
      expect(captured.logs.length).toBeGreaterThanOrEqual(1);
    }),
  );
});

describe("partial composition", () => {
  it.effect("subset of mock services compose without the full layer", () =>
    Effect.gen(function* () {
      const partialLayer = Layer.mergeAll(mockGitClientLayer(), mockRepoStoreLayer());
      yield* clone("https://github.com/test/repo", "/tmp/repo").pipe(
        Effect.provide(partialLayer),
      );
      yield* addRepo(createTestRepo("partial")).pipe(Effect.provide(partialLayer));
      const data = yield* load().pipe(Effect.provide(partialLayer));
      expect(data.repos).toHaveLength(1);
    }),
  );
});

describe("live layer with mock platform", () => {
  const liveLayer = RepoStoreLayer.pipe(
    Layer.provide(
      Layer.succeed(FileSystem.FileSystem, mockFileSystem(makeDefaultFsState())),
    ),
  );

  it.effect("RepoStoreLayer with mock FileSystem loads and saves", () =>
    Effect.gen(function* () {
      yield* addRepo(createTestRepo("live-repo")).pipe(Effect.provide(liveLayer));
      const data = yield* load().pipe(Effect.provide(liveLayer));
      expect(data.repos).toHaveLength(1);
      expect(data.repos[0].id).toBe("live-repo");
    }),
  );

  it.effect("RepoStoreLayer with mock FileSystem persists updates", () =>
    Effect.gen(function* () {
      yield* addRepo(createTestRepo("persist-me")).pipe(Effect.provide(liveLayer));
      yield* updateRepo("persist-me", {
        lastSyncedCommit: Option.some("updated-commit"),
      }).pipe(Effect.provide(liveLayer));
      const result = yield* getRepo("persist-me").pipe(Effect.provide(liveLayer));
      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) {
        expect(Option.getOrNull(result.value.lastSyncedCommit)).toBe("updated-commit");
      }
    }),
  );
});
