/*
 * Splitting a file into the pieces that get one embedding each.
 *
 * all-MiniLM-L6-v2 truncates input past 256 word pieces (and was fine-tuned on
 * 128), so a whole file embeds only its opening. Chunks of up to
 * CHUNK_MAX_TOKENS, split on line boundaries, cover the rest. Consecutive
 * chunks share about CHUNK_OVERLAP_TOKENS of lines, so code that straddles a
 * boundary is whole in at least one of them.
 */

/** Tokens per chunk, including the model's two special tokens ([CLS], [SEP]) */
export const CHUNK_MAX_TOKENS = 256

/** Tokens of lines repeated at the start of the next chunk */
export const CHUNK_OVERLAP_TOKENS = 32

const SPECIAL_TOKENS = 2

export interface Chunk {
  /** 0-based position in the file */
  readonly chunk: number
  /** 1-based, inclusive */
  readonly startLine: number
  readonly endLine: number
  readonly text: string
}

export interface ChunkOptions {
  readonly maxTokens?: number
  readonly overlapTokens?: number
}

/**
 * Split `text` into chunks of whole lines. `countTokens` counts the word pieces
 * of one line, without special tokens. A line longer than a whole chunk gets a
 * chunk to itself (the model truncates it). Always returns at least one chunk,
 * so an empty file still has a row.
 */
export const chunkLines = (
  text: string,
  countTokens: (line: string) => number,
  options?: ChunkOptions
): ReadonlyArray<Chunk> => {
  const budget = (options?.maxTokens ?? CHUNK_MAX_TOKENS) - SPECIAL_TOKENS
  // At most half a chunk, so each chunk moves on by at least half
  const overlap = Math.min(options?.overlapTokens ?? CHUNK_OVERLAP_TOKENS, Math.floor(budget / 2))
  const lines = text.split("\n")
  const tokens = lines.map(countTokens)

  const chunks: Array<Chunk> = []
  let start = 0
  while (start < lines.length) {
    // Take lines until the next one would go over budget; always at least one
    let end = start
    let used = tokens[start]
    while (end + 1 < lines.length && used + tokens[end + 1] <= budget) {
      end++
      used += tokens[end]
    }

    chunks.push({
      chunk: chunks.length,
      startLine: start + 1,
      endLine: end + 1,
      text: lines.slice(start, end + 1).join("\n")
    })
    if (end + 1 >= lines.length) break

    // The next chunk starts with the trailing lines that fit in the overlap,
    // but always after this chunk's first line, so every chunk moves forward
    let next = end + 1
    let shared = 0
    while (next - 1 > start && shared + tokens[next - 1] <= overlap) {
      next--
      shared += tokens[next]
    }
    start = next
  }
  return chunks
}
