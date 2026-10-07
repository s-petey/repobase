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
 * The search box's filter: a path fragment the result paths must contain, or a glob used as is
 */
export interface SearchFilter {
  readonly kind: "path" | "glob"
  readonly text: string
}

/**
 * The glob a filter sends to the search: a path fragment matches any path
 * containing it (`editor` matches `crates/editor/src/main.rs` and `docs/editor.md`)
 */
export const filterToGlob = (filter: SearchFilter): string =>
  filter.kind === "glob" ? filter.text : `**/*${filter.text.replace(/^\/+|\/+$/g, "")}*{,/**}`

/**
 * How the results header describes a filter
 */
export const describeFilter = (filter: SearchFilter): string =>
  filter.kind === "glob" ? `matching ${filter.text}` : `in paths containing ${filter.text}`

/**
 * What's highlighted in the repo list, which search covers unless it's set to search all
 */
export interface SearchScope {
  readonly label: string // e.g. "Effect-TS/effect" or "Effect-TS (2 repos)"
  readonly repos: ReadonlyArray<string>
}

/**
 * The lines a result's best match covers, e.g. "lines 210–260", if the result has them
 */
export const formatLines = (result: { readonly startLine?: number; readonly endLine?: number }): string | undefined => {
  if (result.startLine === undefined || result.endLine === undefined) return undefined
  return result.startLine === result.endLine ? `line ${result.startLine}` : `lines ${result.startLine}–${result.endLine}`
}

/**
 * A score as a percentage padded to a fixed width, so a column of them lines up
 */
export const formatScore = (score: number): string => `${Math.round(score * 100)}%`.padStart(4)
