import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref, Stream, SubscriptionRef } from "effect";
import type { RepoConfig } from "../src/schemas.js";
import { makeWorkerEngineClient, WorkerClient } from "../src/services/EngineClient.js";
import type { WorkerEvent, WorkerInput } from "../src/services/EngineWorkerTypes.js";
import { RepobaseEngine, type AddRepoProgress } from "../src/services/RepobaseEngine.js";
import { trackingMode } from "../src/utils.js";

const makeRepo = (id: string): RepoConfig => ({
  id,
  url: `https://github.com/${id}/repo`,
  owner: id,
  name: "repo",
  localPath: `/mock/.repobase/repos/${id}`,
  mode: trackingMode("main"),
  lastSyncedCommit: Option.some("initial"),
  lastSyncedAt: Option.some(new Date()),
  addedAt: new Date(),
  cloudEnabled: false,
  lastPushedAt: Option.none(),
  lastPushedCommit: Option.none(),
});

const makeRepos = (n: number): RepoConfig[] =>
  Array.from({ length: n }, (_, i) => makeRepo(`repo-${i}`));

const mockClientLayer = (
  run: (input: WorkerInput) => Stream.Stream<WorkerEvent, Error>,
  maxConcurrency = 2,
): Layer.Layer<WorkerClient> =>
  Layer.succeed(WorkerClient, WorkerClient.of({ maxConcurrency, run }));

const workerEngineLayer = (client: Layer.Layer<WorkerClient>) =>
  Layer.effect(RepobaseEngine, makeWorkerEngineClient).pipe(Layer.provide(client));

const syncRepoResult = (id: string) => ({
  _tag: "syncRepo" as const,
  data: {
    id,
    updated: true,
    previousCommit: Option.some("initial"),
    currentCommit: "new-commit",
  },
});

describe("EngineClient", () => {
  it.effect("routes listRepos through the worker", () =>
    Effect.gen(function* () {
      const repos = makeRepos(2);
      const run = (input: WorkerInput): Stream.Stream<WorkerEvent, Error> => {
        expect(input._tag).toBe("listRepos");
        return Stream.succeed({
          _tag: "Result",
          data: { _tag: "listRepos", data: repos },
        });
      };

      const engine = yield* RepobaseEngine.pipe(
        Effect.provide(workerEngineLayer(mockClientLayer(run))),
      );
      const result = yield* engine.listRepos();

      expect(result).toEqual(repos);
    }),
  );

  it.effect("getRepo returns Option through the worker", () =>
    Effect.gen(function* () {
      const repo = makeRepos(1)[0];
      const run = (input: WorkerInput): Stream.Stream<WorkerEvent, Error> => {
        if (input._tag !== "getRepo") return Stream.empty;
        const data =
          input.id === "present"
            ? Option.some(repo)
            : Option.none<RepoConfig>();
        return Stream.succeed({ _tag: "Result", data: { _tag: "getRepo", data } });
      };

      const engine = yield* RepobaseEngine.pipe(
        Effect.provide(workerEngineLayer(mockClientLayer(run))),
      );

      expect(yield* engine.getRepo("present")).toEqual(Option.some(repo));
      expect(yield* engine.getRepo("absent")).toEqual(Option.none());
    }),
  );

  it.effect("routes removeRepo and returns null payload", () =>
    Effect.gen(function* () {
      const run = (input: WorkerInput): Stream.Stream<WorkerEvent, Error> => {
        expect(input._tag).toBe("removeRepo");
        return Stream.succeed({
          _tag: "Result",
          data: { _tag: "removeRepo", data: null },
        });
      };

      const engine = yield* RepobaseEngine.pipe(
        Effect.provide(workerEngineLayer(mockClientLayer(run))),
      );
      const result = yield* engine.removeRepo("repo-0");

      expect(result).toBeNull();
    }),
  );

  it.effect("routes search with options through the worker", () =>
    Effect.gen(function* () {
      const results = [
        {
          repo: "repo-0",
          path: "src/file.ts",
          filename: "file.ts",
          score: 0.9,
          snippet: Option.some("...match..."),
        },
      ];
      const run = (input: WorkerInput): Stream.Stream<WorkerEvent, Error> => {
        expect(input).toEqual({
          _tag: "search",
          query: "match",
          mode: "keyword",
          limit: 5,
          repo: "repo-0",
        });
        return Stream.succeed({
          _tag: "Result",
          data: { _tag: "search", data: results },
        });
      };

      const engine = yield* RepobaseEngine.pipe(
        Effect.provide(workerEngineLayer(mockClientLayer(run))),
      );
      const result = yield* engine.search("match", "keyword", {
        limit: 5,
        repo: "repo-0",
      });

      expect(result).toEqual(results);
    }),
  );

  it.effect("syncAll fans out per-repo at maxConcurrency", () =>
    Effect.gen(function* () {
      const repos = makeRepos(4);
      const inFlight = yield* Ref.make(0);
      const maxInFlight = yield* Ref.make(0);
      const synced = yield* Ref.make<string[]>([]);

      const run = (input: WorkerInput): Stream.Stream<WorkerEvent, Error> =>
        Stream.unwrap(
          Effect.gen(function* () {
            if (input._tag === "listRepos") {
              return Stream.succeed({
                _tag: "Result",
                data: { _tag: "listRepos", data: repos },
              });
            }
            if (input._tag === "syncRepo") {
              const now = yield* Ref.updateAndGet(inFlight, (n) => n + 1);
              yield* Ref.update(maxInFlight, (m) => Math.max(m, now));
              yield* Effect.tryPromise(
                () => new Promise((resolve) => setTimeout(resolve, 20)),
              );
              yield* Ref.update(inFlight, (n) => n - 1);
              yield* Ref.update(synced, (ids) => [...ids, input.id]);
              return Stream.succeed({
                _tag: "Result",
                data: syncRepoResult(input.id),
              });
            }
            return Stream.empty;
          }),
        );

      const engine = yield* RepobaseEngine.pipe(
        Effect.provide(workerEngineLayer(mockClientLayer(run, 2))),
      );
      const results = yield* engine.syncAll();

      expect(results.map((r) => r.id)).toEqual(repos.map((r) => r.id));
      expect(yield* Ref.get(maxInFlight)).toBe(2);
      expect(yield* Ref.get(synced)).toEqual(
        repos.map((r) => r.id).sort((a, b) => a.localeCompare(b)),
      );
    }),
  );

  it.effect("syncAll returns [] when there are no repos", () =>
    Effect.gen(function* () {
      const run = (input: WorkerInput): Stream.Stream<WorkerEvent, Error> => {
        if (input._tag !== "listRepos") return Stream.empty;
        return Stream.succeed({
          _tag: "Result",
          data: { _tag: "listRepos", data: [] },
        });
      };

      const engine = yield* RepobaseEngine.pipe(
        Effect.provide(workerEngineLayer(mockClientLayer(run))),
      );
      const results = yield* engine.syncAll();

      expect(results).toEqual([]);
    }),
  );

  it.effect("addRepo forwards progress and returns the repo", () =>
    Effect.gen(function* () {
      const repo = makeRepos(1)[0];
      const run = (input: WorkerInput): Stream.Stream<WorkerEvent, Error> => {
        expect(input._tag).toBe("addRepo");
        return Stream.make(
          {
            _tag: "Progress",
            stage: "cloning",
            message: "Cloning...",
            progress: 10,
          },
          {
            _tag: "Progress",
            stage: "indexing",
            message: "Indexing: src/main.ts",
            progress: 50,
          },
          { _tag: "Result", data: { _tag: "addRepo", data: repo } },
        );
      };

      const engine = yield* RepobaseEngine.pipe(
        Effect.provide(workerEngineLayer(mockClientLayer(run))),
      );
      const progressRef = yield* SubscriptionRef.make<AddRepoProgress>({
        stage: "cloning",
        progress: 0,
        message: "Starting...",
      });
      const result = yield* engine.addRepo("https://github.com/repo-0/repo", {
        progressRef,
      });

      expect(result).toEqual(repo);
      const state = yield* SubscriptionRef.get(progressRef);
      expect(state.stage).toBe("indexing");
      expect(state.progress).toBe(50);
      expect(state.message).toBe("Indexing: src/main.ts");
    }),
  );

  it.effect("maps a worker Error event to a typed EngineError", () =>
    Effect.gen(function* () {
      const run = (): Stream.Stream<WorkerEvent, Error> =>
        Stream.succeed({
          _tag: "Error",
          errorTag: "RepoNotFoundError",
          message: "missing",
        });

      const engine = yield* RepobaseEngine.pipe(
        Effect.provide(workerEngineLayer(mockClientLayer(run))),
      );
      const error = yield* engine.getRepo("nope").pipe(Effect.flip);

      expect(error._tag).toBe("RepoNotFoundError");
      expect(error.message).toBe("missing");
    }),
  );

  it.effect("fails with a typed GitError when the worker reports one", () =>
    Effect.gen(function* () {
      const run = (): Stream.Stream<WorkerEvent, Error> =>
        Stream.succeed({
          _tag: "Error",
          errorTag: "GitError",
          message: "clone failed",
        });

      const engine = yield* RepobaseEngine.pipe(
        Effect.provide(workerEngineLayer(mockClientLayer(run))),
      );
      const error = yield* engine.addRepo("https://github.com/repo-0/repo").pipe(
        Effect.flip,
      );

      expect(error._tag).toBe("GitError");
      expect(error.message).toBe("clone failed");
    }),
  );

  it.effect("fails with StoreError when the worker returns no terminal event", () =>
    Effect.gen(function* () {
      const run = (): Stream.Stream<WorkerEvent, Error> => Stream.empty;

      const engine = yield* RepobaseEngine.pipe(
        Effect.provide(workerEngineLayer(mockClientLayer(run))),
      );
      const error = yield* engine.listRepos().pipe(Effect.flip);

      expect(error._tag).toBe("StoreError");
    }),
  );
});
