import { Effect, Layer } from "effect"
import * as crypto from "node:crypto"
import type { IndexError } from "../../src/errors.js"
import { Embedder } from "../../src/services/Embedder.js"

const EMBEDDING_DIMENSION = 384

// A deterministic unit vector derived from the text
export const fakeVector = (text: string): number[] => {
  const seed = crypto.createHash("sha256").update(text).digest()
  const vector = Array.from({ length: EMBEDDING_DIMENSION }, (_, i) => seed[i % seed.length] / 255 + 0.01)
  const norm = Math.hypot(...vector)
  return vector.map((v) => v / norm)
}

const countWords = (line: string) => line.split(/\s+/).filter(Boolean).length

export const fakeEmbedder = (
  embed: (text: string) => Effect.Effect<number[], IndexError> = (text) => Effect.succeed(fakeVector(text))
) => Layer.succeed(Embedder, Embedder.of({ embed, tokenCounter: Effect.succeed(countWords) }))
