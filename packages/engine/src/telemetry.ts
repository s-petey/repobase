import { Config, Effect, Layer, Option } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/unstable/observability"

/**
 * Exports the process's traces and logs over OTLP/HTTP (JSON) when
 * OTEL_EXPORTER_OTLP_ENDPOINT is set.
 * OTEL_SDK_DISABLED=true turns it off.
 *
 * Logs are added to the existing loggers, so build this with the file logger
 * already in its context.
 */
export const telemetryLayer = (serviceName: string): Layer.Layer<never> =>
  Effect.gen(function* () {
    const { endpoint, disabled } = yield* Config.all({
      endpoint: Config.option(Config.String("OTEL_EXPORTER_OTLP_ENDPOINT")),
      disabled: Config.Boolean("OTEL_SDK_DISABLED").pipe(Config.withDefault(false))
    })
    if (disabled || Option.isNone(endpoint)) return Layer.empty

    const base = endpoint.value.replace(/\/+$/, "")
    const resource = { serviceName }
    // Worker threads and the TUI exit without waiting long, so export often
    return Layer.mergeAll(
      OtlpTracer.layer({ url: `${base}/v1/traces`, resource, exportInterval: "1 second" }),
      OtlpLogger.layer({ url: `${base}/v1/logs`, resource, exportInterval: "1 second" })
    ).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer))
  }).pipe(Effect.orDie, Layer.unwrap)
