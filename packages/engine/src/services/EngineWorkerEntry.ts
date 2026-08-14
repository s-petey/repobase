import { WorkerRunner } from "@effect/platform";
import { BunCommandExecutor, BunFileSystem, BunWorkerRunner } from "@effect/platform-bun";
import { Effect, Layer, Logger, LogLevel, Stream, SubscriptionRef } from "effect";
import { logWorker } from "../diagnostic-logger.js";
import type { WorkerEvent, WorkerInput } from "./EngineWorkerTypes.js";
import { ErrorEventSchema, ProgressEventSchema, ResultEventSchema } from "./EngineWorkerTypes.js";
import { layer as GitClientLayer } from "./GitClient.js";
import { layer as IndexerLayer } from "./Indexer.js";
import type { AddRepoProgress } from "./RepobaseEngine.js";
import { initialProgress, RepobaseEngine, layer as RepobaseEngineLayer } from "./RepobaseEngine.js";
import { layer as RepoStoreLayer } from "./RepoStore.js";

// ── Handler: process one operation, stream events back ─────

const handler = (input: WorkerInput): Stream.Stream<WorkerEvent, never, RepobaseEngine> => {
  switch (input._tag) {
    case "addRepo":
      return Stream.unwrap(
        Effect.gen(function* () {
          const engine = yield* RepobaseEngine;
          const progressRef = yield* SubscriptionRef.make<AddRepoProgress>(initialProgress);

          const progressStream: Stream.Stream<WorkerEvent, never> = progressRef.changes.pipe(
            Stream.map((p) =>
              ProgressEventSchema.make({
                stage: p.stage,
                message: p.message,
                progress: p.progress,
              }),
            ),
            Stream.drop(1),
          );

          const resultStream = Stream.fromEffect(
            engine.addRepo(input.url, { progressRef }).pipe(
              Effect.map((repo) =>
                ResultEventSchema.make({
                  data: {
                    _tag: "addRepo",
                    data: repo,
                  },
                }),
              ),
              Effect.catchAll((e) =>
                Effect.succeed(
                  ErrorEventSchema.make({
                    errorTag: e._tag,
                    message: e.message ?? String(e),
                  }),
                ),
              ),
            ),
          );

          return Stream.merge(progressStream, resultStream).pipe(
            Stream.takeUntil(
              (event) => event._tag === "Result" || event._tag === "Error",
            ),
          );
        }),
      );

    case "syncRepo":
      return Stream.fromEffect(
        Effect.gen(function* () {
          const engine = yield* RepobaseEngine;
          return yield* engine.syncRepo(input.id).pipe(
            Effect.map((r) => ResultEventSchema.make({ data: { _tag: "syncRepo", data: r } })),
            Effect.catchAll((e) =>
              Effect.succeed(
                ErrorEventSchema.make({
                  errorTag: e._tag,
                  message: e.message ?? String(e),
                }),
              ),
            ),
          );
        }),
      );

    case "removeRepo":
      return Stream.fromEffect(
        Effect.gen(function* () {
          const engine = yield* RepobaseEngine;
          yield* engine
            .removeRepo(input.id)
            .pipe(
              Effect.catchAll((e) =>
                Effect.succeed(
                  ErrorEventSchema.make({
                    errorTag: e._tag,
                    message: e.message ?? String(e),
                  }),
                ),
              ),
            );
          return ResultEventSchema.make({ data: { _tag: "removeRepo", data: null } });
        }),
      );

    case "listRepos":
      return Stream.fromEffect(
        Effect.gen(function* () {
          const engine = yield* RepobaseEngine;
          const repos = yield* engine.listRepos().pipe(
            Effect.catchAll((e) =>
              Effect.succeed(
                ErrorEventSchema.make({
                  errorTag: e._tag,
                  message: e.message ?? String(e),
                }),
              ),
            ),
          );

          if (!Array.isArray(repos)) {
            return repos;
          }

          return ResultEventSchema.make({
            data: {
              _tag: "listRepos",
              data: repos,
            },
          });
        }),
      );

    case "getRepo":
      return Stream.fromEffect(
        Effect.gen(function* () {
          const engine = yield* RepobaseEngine;
          const repo = yield* engine
            .getRepo(input.id)
            .pipe(
              Effect.catchAll((e) =>
                Effect.succeed(
                  ErrorEventSchema.make({
                    errorTag: e._tag,
                    message: e.message ?? String(e),
                  }),
                ),
              ),
            );

          if (repo._tag === "Error") {
            return repo;
          }

          return ResultEventSchema.make({ data: { _tag: "getRepo", data: repo } });
        }),
      );

    case "search":
      return Stream.fromEffect(
        Effect.gen(function* () {
          const engine = yield* RepobaseEngine;
          const results = yield* engine
            .search(input.query, input.mode, {
              limit: input.limit,
              repo: input.repo,
            })
            .pipe(
              Effect.catchAll((e) =>
                Effect.succeed(
                  ErrorEventSchema.make({
                    errorTag: e._tag,
                    message: e.message ?? String(e),
                  }),
                ),
              ),
            );

          if (!Array.isArray(results)) {
            return results;
          }

          return ResultEventSchema.make({ data: { _tag: "search", data: results } });
        }),
      );
  }
};

// ── Build all engine dependencies with platform services ────

const CmdExe = BunCommandExecutor.layer.pipe(Layer.provide(BunFileSystem.layer));
const Plat = Layer.mergeAll(BunFileSystem.layer, CmdExe);

const WorkerHandlerLayer = WorkerRunner.layer(handler).pipe(
  Layer.provide(BunWorkerRunner.layer),
  Layer.provide(
    RepobaseEngineLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          GitClientLayer.pipe(Layer.provide(Plat)),
          RepoStoreLayer.pipe(Layer.provide(Plat)),
          IndexerLayer.pipe(Layer.provide(Plat)),
        ),
      ),
    ),
  ),
  Layer.provide(Logger.minimumLogLevel(LogLevel.Warning)),
);

// ── Launch the worker ───────────────────────────────────────

Effect.runFork(
  WorkerRunner.launch(WorkerHandlerLayer).pipe(
    Effect.catchAll((e) => Effect.sync(() => logWorker(`Worker error: ${e.message}`))),
  ) as any,
);
