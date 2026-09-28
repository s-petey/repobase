import { BunWorker } from "@effect/platform-bun"
import { Context, Effect, Layer } from "effect"
import { RpcClient, type RpcClientError, type RpcGroup } from "effect/unstable/rpc"
import { hostWorkerCount, splitPools } from "./limits.js"
import { StepRpcs } from "./rpcs.js"

/**
 * RPC client for the worker pool that runs job steps, except for embedding
 * (see IndexingClient)
 */
export class WorkerClient extends Context.Service<
  WorkerClient,
  RpcClient.RpcClient<RpcGroup.Rpcs<typeof StepRpcs>, RpcClientError.RpcClientError>
>()("@repobase/engine/WorkerClient") {}

/**
 * How long an idle worker stays alive before the pool shuts it down
 */
const WORKER_TIME_TO_LIVE = "60 seconds"

/**
 * A pool of worker threads serving StepRpcs.
 *
 * Workers are spawned on demand up to `size` (by default the job share of
 * hostWorkerCount) and each runs one request at a time. Closing the
 * layer's scope shuts every worker down.
 *
 * @param workerUrl - Module that calls runWorker(); it must resolve both from
 *   source and from the bundled dist output
 */
export const layerWorkerPool = (options: {
  readonly workerUrl: URL
  readonly size?: number
}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const size = options.size ?? (yield* hostJobPoolSize)
      yield* Effect.logInfo(`Worker pool: up to ${size} worker thread(s)`)

      return Layer.effect(WorkerClient)(RpcClient.make(StepRpcs)).pipe(
        Layer.provide(
          RpcClient.layerProtocolWorker({
            minSize: 0,
            maxSize: size,
            concurrency: 1,
            timeToLive: WORKER_TIME_TO_LIVE
          })
        ),
        Layer.provide(BunWorker.layer(() => new Worker(options.workerUrl)))
      )
    })
  )

/**
 * RPC client for searches, on its own worker so searches don't queue behind
 * indexing jobs
 */
export class QueryClient extends Context.Service<QueryClient, WorkerClient["Service"]>()(
  "@repobase/engine/QueryClient"
) {}

/**
 * The search worker: one thread, started with the layer and kept for its whole
 * lifetime, so the first search doesn't wait for a worker (or its model) to start
 */
export const layerQueryPool = (options: { readonly workerUrl: URL }) =>
  Layer.effect(QueryClient)(RpcClient.make(StepRpcs)).pipe(
    Layer.provide(RpcClient.layerProtocolWorker({ size: 1, concurrency: 1 })),
    Layer.provide(BunWorker.layer(() => new Worker(options.workerUrl)))
  )

/**
 * RPC client for the indexing workers, the only ones that embed files
 */
export class IndexingClient extends Context.Service<IndexingClient, WorkerClient["Service"]>()(
  "@repobase/engine/IndexingClient"
) {}

/**
 * The indexing workers: `size` threads, started with the layer and kept for its
 * whole lifetime. Each loads the embedding model (onnxruntime) once. They're
 * never retired, because Bun 1.4 crashes when onnxruntime loads in a new worker
 * after a few that loaded it were terminated.
 */
export const layerIndexingPool = (options: { readonly workerUrl: URL; readonly size: number }) =>
  Layer.effect(IndexingClient)(RpcClient.make(StepRpcs)).pipe(
    Layer.provide(RpcClient.layerProtocolWorker({ size: options.size, concurrency: 1 })),
    Layer.provide(BunWorker.layer(() => new Worker(options.workerUrl)))
  )

/**
 * For a single-worker budget: searches go to the indexing workers, which hold
 * the embedding model anyway, so no retiring worker ever loads it
 */
export const layerQueryFromIndexingPool = Layer.effect(QueryClient)(
  Effect.gen(function* () {
    return yield* IndexingClient
  })
)

const hostJobPoolSize = Effect.gen(function* () {
  const resolved = yield* hostWorkerCount
  if (resolved.warning) yield* Effect.logWarning(resolved.warning)
  return splitPools(resolved.count).jobs
})
