import { BunServices, BunWorkerRunner } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { RpcServer } from "effect/unstable/rpc"
import { fileLoggerLayer, logPath } from "../file-logger.js"
import { GitClient, layer as GitClientLayer } from "../services/GitClient.js"
import { StepRpcs } from "./rpcs.js"

/**
 * Handlers for StepRpcs, run inside the worker thread
 */
const HandlersLayer = StepRpcs.toLayer(
  Effect.gen(function* () {
    const git = yield* GitClient

    return StepRpcs.of({
      GitResolveHead: ({ localPath }) =>
        git.getCurrentCommit(localPath).pipe(Effect.map((commit) => ({ commit })))
    })
  })
)

// provideMerge so the file logger is in the context the RPC server and its
// handlers are built with; otherwise worker logs would go to stdout.
const WorkerLayer = RpcServer.layer(StepRpcs).pipe(
  Layer.provide(HandlersLayer),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(BunWorkerRunner.layer),
  Layer.provide(GitClientLayer),
  Layer.provideMerge(fileLoggerLayer(logPath("worker"))),
  Layer.provide(BunServices.layer)
)

/**
 * Entry point for a worker thread: serve StepRpcs until the pool closes this
 * worker. The worker runner handles the close message from the main thread,
 * so there are no process signal handlers here.
 */
export const runWorker = () => {
  Effect.runFork(Layer.launch(WorkerLayer))
}
