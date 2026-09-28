// How the search results view presents result paths

/**
 * `repo/path` if it fits in `max` characters, else `repo/…/file`, else the
 * end of that (the file name is the most specific part)
 */
export const shortenPath = (repo: string, path: string, max: number): string => {
  const full = `${repo}/${path}`
  if (full.length <= max) return full

  const file = path.split("/").at(-1) ?? path
  const short = `${repo}/…/${file}`
  if (short.length <= max) return short

  return max <= 1 ? "…".slice(0, max) : `…${short.slice(short.length - (max - 1))}`
}

/**
 * A score as a percentage padded to a fixed width, so a column of them lines up
 */
export const formatScore = (score: number): string => `${Math.round(score * 100)}%`.padStart(4)
