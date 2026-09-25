import { BunWorker } from "@effect/platform-bun"
import { Context, Effect, Layer } from "effect"
import { RpcClient, type RpcClientError, type RpcGroup } from "effect/unstable/rpc"
import { resolveHostWorkerCount, splitPools } from "./limits.js"
import { StepRpcs } from "./rpcs.js"

/**
 * RPC client for the worker pool that runs job steps
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
 * resolveHostWorkerCount) and each runs one request at a time. Closing the
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

const hostJobPoolSize = Effect.gen(function* () {
  const resolved = resolveHostWorkerCount()
  if (resolved.warning) yield* Effect.logWarning(resolved.warning)
  return splitPools(resolved.count).jobs
})
