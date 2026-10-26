import { Config, Effect, Layer, Option } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/unstable/observability"

// Any HTTP response means something is listening
const isReachable = (url: string) =>
  Effect.tryPromise((signal) => fetch(url, { signal }).then((response) => response.body?.cancel())).pipe(
    Effect.timeout("1 second"),
    Effect.as(true),
    Effect.orElseSucceed(() => false)
  )

/**
 * The OTLP/HTTP endpoint to export to: OTEL_EXPORTER_OTLP_ENDPOINT, unless
 * OTEL_SDK_DISABLED=true or nothing is listening there at startup, which is
 * logged once
 */
export const hostOtlpEndpoint: Effect.Effect<Option.Option<string>> = Effect.gen(function* () {
  const { endpoint, disabled } = yield* Config.all({
    endpoint: Config.option(Config.String("OTEL_EXPORTER_OTLP_ENDPOINT")),
    disabled: Config.Boolean("OTEL_SDK_DISABLED").pipe(Config.orElse(() => Config.succeed(false)))
  })
  if (disabled || Option.isNone(endpoint)) return Option.none()

  const base = endpoint.value.replace(/\/+$/, "")
  if (!(yield* isReachable(base))) {
    yield* Effect.logWarning(`Nothing is listening at ${base}, so traces and logs aren't exported this session`)
    return Option.none()
  }
  return Option.some(base)
}).pipe(Effect.orDie)

/**
 * Exports the process's traces and logs over OTLP/HTTP (JSON) to `endpoint`, if
 * there is one.
 *
 * Logs are added to the existing loggers, so build this with the file logger
 * already in its context.
 */
export const otlpLayer = (serviceName: string, endpoint: Option.Option<string>): Layer.Layer<never> => {
  if (Option.isNone(endpoint)) return Layer.empty
  const resource = { serviceName }
  // Worker threads and the TUI exit without waiting long, so export often
  return Layer.mergeAll(
    OtlpTracer.layer({ url: `${endpoint.value}/v1/traces`, resource, exportInterval: "1 second" }),
    OtlpLogger.layer({ url: `${endpoint.value}/v1/logs`, resource, exportInterval: "1 second" })
  ).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer))
}

/**
 * otlpLayer for the endpoint hostOtlpEndpoint resolves
 */
export const telemetryLayer = (serviceName: string): Layer.Layer<never> =>
  Layer.unwrap(Effect.map(hostOtlpEndpoint, (endpoint) => otlpLayer(serviceName, endpoint)))
