import { Context, Effect, Layer, Option, Ref, Stream, SubscriptionRef } from "effect";
import {
  CloudError,
  CloudNotConfiguredError,
  FileNotFoundError,
  GitError,
  IndexError,
  InvalidPatternError,
  LockError,
  RepoAlreadyExistsError,
  RepoNotFoundError,
  SearchError,
  StoreError,
  type EngineError,
} from "../errors.js";
import { maxConcurrencyConfig } from "./Concurrency.js";
import { execute } from "./EngineWorkerManager.js";
import type {
  ErrorEventSchema,
  ProgressEventSchema,
  ResultEvent,
  WorkerEvent,
  WorkerInput,
} from "./EngineWorkerTypes.js";
import type { SearchMode, SearchOptions } from "./Indexer.js";
import { RepobaseEngine, type RepobaseEngineService } from "./RepobaseEngine.js";

// ── WorkerClient: run a single operation on the worker pool ──

export interface WorkerClientService {
  readonly maxConcurrency: number;
  readonly run: (input: WorkerInput) => Stream.Stream<WorkerEvent, Error>;
}

export class WorkerClient extends Context.Tag("@repobase/engine/WorkerClient")<
  WorkerClient,
  WorkerClientService
>() {}

export const WorkerClientLive = Layer.effect(
  WorkerClient,
  Effect.gen(function* () {
    const maxConcurrency = yield* maxConcurrencyConfig.pipe(Effect.orDie);
    return WorkerClient.of({
      maxConcurrency,
      run: (input) => execute(input),
    });
  }),
);

// ── Error reconstruction ─────────────────────────────────────
// The worker protocol only carries errorTag + message (see "Known issue"
// in parallel-worker-plan.md — error fields can't be serialized yet).
// We still build a typed instance and preserve the message on the client
// so `error._tag` and `error.message` are usable.

const tagged = <E extends EngineError>(make: () => E, message: string): E => {
  const error = make();
  error.message = message;
  return error;
};

const deserializeError = (event: ErrorEventSchema): EngineError => {
  switch (event.errorTag) {
    case "GitError":
      return tagged(() => new GitError({ command: "", message: "" }), event.message);
    case "StoreError":
      return tagged(() => new StoreError({ operation: "", message: "" }), event.message);
    case "RepoNotFoundError":
      return new RepoNotFoundError({ id: "" });
    case "RepoAlreadyExistsError":
      return new RepoAlreadyExistsError({ id: "" });
    case "IndexError":
      return tagged(() => new IndexError({ operation: "", message: "" }), event.message);
    case "SearchError":
      return tagged(() => new SearchError({ message: "" }), event.message);
    case "CloudError":
      return tagged(() => new CloudError({ operation: "", message: "" }), event.message);
    case "CloudNotConfiguredError":
      return new CloudNotConfiguredError();
    case "FileNotFoundError":
      return new FileNotFoundError({ repo: "", path: "" });
    case "InvalidPatternError":
      return tagged(() => new InvalidPatternError({ pattern: "", message: "" }), event.message);
    case "LockError":
      return tagged(() => new LockError({ targetPath: "", message: "" }), event.message);
  }
};

// ── Stream folding: run one operation, keep the terminal event ──

const runOperation = <A>(
  client: WorkerClientService,
  input: WorkerInput,
  onProgress: ((event: ProgressEventSchema) => Effect.Effect<void>) | undefined,
  extract: (event: ResultEvent) => A,
): Effect.Effect<A, EngineError> =>
  Effect.gen(function* () {
    const terminal = yield* Ref.make<Option.Option<ResultEvent | ErrorEventSchema>>(Option.none());
    yield* Stream.runForEach(client.run(input), (event) => {
      switch (event._tag) {
        case "Progress":
          return onProgress ? onProgress(event) : Effect.void;
        case "Result":
        case "Error":
          return Ref.set(terminal, Option.some(event));
      }
    });
    const outcome = yield* Ref.get(terminal);
    if (Option.isNone(outcome)) {
      return yield* Effect.fail(
        new StoreError({
          operation: input._tag,
          message: "Worker completed without a result",
        }),
      );
    }
    const event = outcome.value;
    if (event._tag === "Error") {
      return yield* Effect.fail(deserializeError(event));
    }
    return extract(event);
  }).pipe(
    Effect.mapError((e) =>
      e instanceof Error ? new StoreError({ operation: input._tag, message: e.message }) : e,
    ),
  );

const unexpected = (event: ResultEvent): never => {
  throw new Error(`Unexpected worker result: ${event.data._tag}`);
};

// ── Worker-backed RepobaseEngine ──────────────────────────────

export const makeWorkerEngineClient = Effect.gen(function* () {
  const client = yield* WorkerClient;

  const addRepo: RepobaseEngineService["addRepo"] = (url, options) =>
    Effect.gen(function* () {
      const progressRef = options?.progressRef;
      return yield* runOperation(
        client,
        { _tag: "addRepo", url },
        progressRef
          ? (event) =>
              SubscriptionRef.update(progressRef, (prev) => ({
                ...prev,
                stage: event.stage,
                message: event.message,
                progress: event.progress,
              }))
          : undefined,
        (event) => {
          if (event.data._tag === "addRepo") return event.data.data;
          return unexpected(event);
        },
      );
    });

  const removeRepo: RepobaseEngineService["removeRepo"] = (id) =>
    runOperation(client, { _tag: "removeRepo", id }, undefined, (event) => {
      if (event.data._tag === "removeRepo") return event.data.data;
      return unexpected(event);
    });

  const listRepos: RepobaseEngineService["listRepos"] = () =>
    runOperation(client, { _tag: "listRepos" }, undefined, (event) => {
      if (event.data._tag === "listRepos") return [...event.data.data];
      return unexpected(event);
    });

  const getRepo: RepobaseEngineService["getRepo"] = (id) =>
    runOperation(client, { _tag: "getRepo", id }, undefined, (event) => {
      if (event.data._tag === "getRepo") return event.data.data;
      return unexpected(event);
    });

  const syncRepo: RepobaseEngineService["syncRepo"] = (id) =>
    runOperation(client, { _tag: "syncRepo", id }, undefined, (event) => {
      if (event.data._tag === "syncRepo") return event.data.data;
      return unexpected(event);
    });

  const syncAll: RepobaseEngineService["syncAll"] = () =>
    Effect.gen(function* () {
      const repos = yield* runOperation(client, { _tag: "listRepos" }, undefined, (event) => {
        if (event.data._tag === "listRepos") return event.data.data;
        return unexpected(event);
      });
      if (repos.length === 0) {
        return [];
      }
      return yield* Effect.forEach(repos, (repo) => syncRepo(repo.id), {
        concurrency: client.maxConcurrency,
      });
    });

  const search: RepobaseEngineService["search"] = (
    query: string,
    mode: SearchMode,
    options?: SearchOptions,
  ) =>
    runOperation(
      client,
      { _tag: "search", query, mode, limit: options?.limit, repo: options?.repo },
      undefined,
      (event) => {
        if (event.data._tag === "search") return [...event.data.data];
        return unexpected(event);
      },
    );

  return RepobaseEngine.of({
    addRepo,
    removeRepo,
    listRepos,
    getRepo,
    syncRepo,
    syncAll,
    search,
  });
});

/**
 * RepobaseEngine backed by the worker pool instead of in-process services.
 */
export const RepobaseEngineWorkerLayer = Layer.effect(RepobaseEngine, makeWorkerEngineClient).pipe(
  Layer.provide(WorkerClientLive),
);
