import type { TrackingMode, PinnedMode } from "./schemas.js"

export function deriveRepoId(url: string): string {
  const { owner, name } = extractRepoParts(url)
  return `${owner}/${name}`
}

export function extractRepoParts(url: string): { owner: string; name: string } {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (!match) {
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

// Utility: create a default tracking mode
export function trackingMode(branch: string = "main"): TrackingMode {
  return { _tag: "tracking", branch }
}

// Utility: create a pinned mode
export function pinnedMode(ref: string): PinnedMode {
  return { _tag: "pinned", ref }
}
