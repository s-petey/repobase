// Worker entry used by WorkerPool.test.ts; it logs nowhere, so tests don't
// write to ~/.repobase/worker.log
import { Logger } from "effect"
import { runWorker } from "../../src/worker/server.js"

runWorker({ logger: Logger.layer([]) })
