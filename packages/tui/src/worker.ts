// Worker thread entry point, spawned by the worker pool in main.tsx.
// Built alongside main.tsx so it resolves as ./worker.js in dist.
import { fileLoggerLayer, logPath, runWorker } from "@repobase/engine"

runWorker({ logger: fileLoggerLayer(logPath("worker")) })
