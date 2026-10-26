import { Context, Effect, Layer } from "effect"
import type { FeatureExtractionPipeline } from "@huggingface/transformers"
import { IndexError } from "../errors.js"
import { EMBED_LOG_ENV, type EmbedLog, hostEmbedLog } from "../embedLog.js"

const MODEL_ID = "Xenova/all-MiniLM-L6-v2"

/**
 * Turns text into vectors, and counts the tokens it would see. The model
 * loads on first use and is released when the layer shuts down.
 */
export interface EmbedderService {
  readonly embed: (text: string) => Effect.Effect<number[], IndexError>
  // Counts one line's tokens for chunking, without the model's special tokens
  readonly tokenCounter: Effect.Effect<(line: string) => number, IndexError>
}

export class Embedder extends Context.Service<Embedder, EmbedderService>()(
  "@repobase/engine/Embedder"
) {}

export interface EmbedderConfig {
  /** Replaces the embedding model (e.g. a deterministic fake in tests) */
  readonly embed?: (text: string) => Promise<ReadonlyArray<number>>
  /** ONNX Runtime threads the model embeds with, including the caller's; defaults to its own pool */
  readonly threads?: number
  /** Defaults to reading EMBED_LOG_ENV */
  readonly embedLog?: EmbedLog
  /**
   * Counts a line's tokens when chunking. Defaults to the model's tokenizer, or
   * to a word count when `embed` replaces the model.
   */
  readonly countTokens?: (line: string) => number
}

export const make = (config: EmbedderConfig) =>
  Effect.gen(function* () {
    let model: FeatureExtractionPipeline | null = null

    yield* Effect.addFinalizer(() =>
      Effect.tryPromise(async () => {
        await model?.dispose()
      }).pipe(Effect.catch((e) => Effect.logWarning(`Releasing the embedding model failed: ${e}`)))
    )

    const getModel = Effect.gen(function* () {
      if (model) return model

      const transformers = yield* Effect.tryPromise({
        try: () => import("@huggingface/transformers"),
        catch: (e) => new IndexError({ operation: "loadEmbedder", message: `Failed to import transformers: ${e}` })
      })

      const embedLog = config.embedLog ?? (yield* hostEmbedLog.pipe(
        Effect.mapError((e) => new IndexError({ operation: "loadEmbedder", message: `Failed to read ${EMBED_LOG_ENV}: ${e}` })),
        Effect.tap((resolved) => (resolved.warning ? Effect.logWarning(resolved.warning) : Effect.void))
      ))

      model = yield* Effect.tryPromise({
        try: () =>
          transformers.pipeline("feature-extraction", MODEL_ID, {
            dtype: "fp32",
            session_options: {
              logSeverityLevel: embedLog.severity,
              ...(config.threads === undefined ? {} : { intraOpNumThreads: config.threads, interOpNumThreads: 1 })
            }
          }),
        catch: (e) => new IndexError({ operation: "loadEmbedder", message: `Failed to load embedding model: ${e}` })
      })

      return model
    })

    const embed = (text: string): Effect.Effect<number[], IndexError> =>
      Effect.gen(function* () {
        if (config.embed) {
          const fake = config.embed
          return yield* Effect.tryPromise({
            try: async () => [...(await fake(text))],
            catch: (e) => new IndexError({ operation: "embed", message: `Failed to embed text: ${e}` })
          })
        }
        const loaded = yield* getModel
        const output = yield* Effect.tryPromise({
          try: () => loaded(text.trim() || " ", { pooling: "mean", normalize: true }),
          catch: (e) => new IndexError({ operation: "embed", message: `Failed to embed text: ${e}` })
        })
        if (!(output.data instanceof Float32Array)) {
          return yield* new IndexError({ operation: "embed", message: `The model returned ${output.type} embeddings, not float32` })
        }
        return Array.from(output.data)
      })

    const tokenCounter: Effect.Effect<(line: string) => number, IndexError> = Effect.gen(function* () {
      if (config.countTokens) return config.countTokens
      if (config.embed) return (line: string) => line.split(/\s+/).filter(Boolean).length
      const loaded = yield* getModel
      return (line: string) => loaded.tokenizer.encode(line, { add_special_tokens: false }).length
    })

    return Embedder.of({ embed, tokenCounter })
  })

export const layer = (config: EmbedderConfig) => Layer.effect(Embedder, make(config))
