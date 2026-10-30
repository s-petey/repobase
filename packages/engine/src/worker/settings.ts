import { Context, Effect, Layer, Option, Schema } from "effect"
import { EmbedLogLevel, hostEmbedLog } from "../embedLog.js"
import { hostOtlpEndpoint } from "../telemetry.js"

const schema = Schema.Struct({
  otlpEndpoint: Schema.optional(Schema.String),
  embedLog: EmbedLogLevel
})

/**
 * What a worker thread is told when it starts, resolved once by the main
 * thread; the pools send it to every worker they spawn. Workers read no
 * configuration of their own, and without an `otlpEndpoint` they don't export
 * telemetry.
 */
export class WorkerSettings extends Context.Service<WorkerSettings, typeof schema.Type>()(
  "@repobase/engine/WorkerSettings"
) {
  static readonly schema = schema

  /**
   * Resolved from the environment, warning once about anything it ignores
   */
  static readonly layer = Layer.effect(WorkerSettings)(
    Effect.gen(function* () {
      const otlpEndpoint = yield* hostOtlpEndpoint
      const embedLog = yield* hostEmbedLog
      if (embedLog.warning) yield* Effect.logWarning(embedLog.warning)
      return { otlpEndpoint: Option.getOrUndefined(otlpEndpoint), embedLog: embedLog.level }
    })
  )
}
