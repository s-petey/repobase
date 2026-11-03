import type { TrackingMode, PinnedMode } from "./schemas.js"

export function deriveRepoId(url: string): string {
  const { owner, name } = extractRepoParts(url)
  return `${owner}/${name}`
}

const GITHUB_URL_PATTERN = /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/
// An owner or name like this would make the id's folder the repos folder itself, or one outside it
const DOT_SEGMENTS = new Set([".", ".."])

export function extractRepoParts(url: string): { owner: string; name: string } {
  const match = url.match(GITHUB_URL_PATTERN)
  if (!match || DOT_SEGMENTS.has(match[1]) || DOT_SEGMENTS.has(match[2])) {
    throw new Error(`Invalid GitHub URL: ${url}`)
  }
  return { owner: match[1], name: match[2] }
}

/**
 * A repo's owner and name, e.g. to group repos by owner. Both fall back to the
 * id when the URL isn't a GitHub URL.
 */
export function repoNames(repo: { readonly id: string; readonly url: string }): { owner: string; name: string } {
  try {
    return extractRepoParts(repo.url)
  } catch {
    return { owner: repo.id, name: repo.id }
  }
}

/**
 * The owner/name id a repo added before ids were owner/name (e.g. "honojs-hono")
 * should have now, or undefined when its id is current or its URL isn't a
 * GitHub URL
 */
export function migratedRepoId(repo: { readonly id: string; readonly url: string }): string | undefined {
  try {
    const id = deriveRepoId(repo.url)
    return id === repo.id ? undefined : id
  } catch {
    return undefined
  }
}

/**
 * Split `owner/name/path/to/file` into the repo and the path inside it. Repo
 * ids contain a slash (and older ones don't), so the repo is the longest
 * indexed id the path starts with.
 */
export function splitRepoPath(
  repoIds: ReadonlyArray<string>,
  path: string
): { readonly repo: string; readonly path: string } | undefined {
  const repo = repoIds
    .filter((id) => path === id || path.startsWith(`${id}/`))
    .reduce<string | undefined>((longest, id) => (longest === undefined || id.length > longest.length ? id : longest), undefined)
  return repo === undefined ? undefined : { repo, path: path.slice(repo.length + 1) }
}

// Utility: create a default tracking mode
export function trackingMode(branch: string = "main"): TrackingMode {
  return { _tag: "tracking", branch }
}

// Utility: create a pinned mode
export function pinnedMode(ref: string): PinnedMode {
  return { _tag: "pinned", ref }
}
