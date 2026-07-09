import type { TrackingMode, PinnedMode } from "./schemas.js"

// Utility: derive repo ID from GitHub URL
// e.g., "https://github.com/Effect-TS/effect" -> "Effect-TS-effect"
export function deriveRepoId(url: string): string {
  const { owner, name } = extractRepoParts(url)

  return `${owner}-${name}`
}

/**
 * Utility: extract owner and name from a GitHub URL
 * e.g., "https://github.com/Effect-TS/effect" -> { owner: "Effect-TS", name: "effect" }
 */
export function extractRepoParts(url: string): { owner: string; name: string } {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (!match) {
    throw new Error(`Invalid GitHub URL: ${url}`)
  }
  return { owner: match[1], name: match[2] }
}

// Utility: extract repo owner from GitHub URL
// e.g., "https://github.com/Effect-TS/effect" -> "Effect-TS"
export function extractRepoOwner(url: string): string {
  return extractRepoParts(url).owner
}

// Utility: create a default tracking mode
export function trackingMode(branch: string = "main"): TrackingMode {
  return { _tag: "tracking", branch }
}

// Utility: create a pinned mode
export function pinnedMode(ref: string): PinnedMode {
  return { _tag: "pinned", ref }
}
