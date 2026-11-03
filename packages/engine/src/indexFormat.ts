import type { RepoConfig } from "./schemas.js"

/**
 * The layout and embeddings the index is written with. Bump it whenever stored
 * data stops matching what the engine writes (the table schema, the embedding
 * model or its dtype, how files are chunked), so existing repos are re-indexed.
 *
 * 1: one row per file in the `files` table, @xenova/transformers 2.x (q8)
 * 2: one row per chunk in the `chunks` table, @huggingface/transformers 4.x (fp32)
 */
export const CURRENT_INDEX_FORMAT = 2

/**
 * Whether a repo was indexed with an older format and has to be fully re-indexed
 * before it can be searched
 */
export const needsReindex = (repo: Pick<RepoConfig, "indexFormat">): boolean =>
  repo.indexFormat < CURRENT_INDEX_FORMAT
