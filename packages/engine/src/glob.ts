/*
 * Glob to regex conversion for filters that run inside the index query.
 * micromatch's regexes use lookaheads, which LanceDB's regex engine (Rust)
 * doesn't support, so this builds plain regexes instead.
 *
 * It follows micromatch's rules for the common syntax: `*` and `?` stay within
 * one path segment, `**` as a whole segment crosses them (`**\/` also matches
 * no directories, a trailing `/**` needs something under it), `{a,b}` expands
 * (and may contain `/`), and `[abc]` works. Unlike micromatch's default, `*`
 * also matches dotfiles. A glob without `/` matches the filename, as in grep's
 * glob.
 */

const escapeChar = (char: string) => (/[\\^$.|+()[\]{}*?]/.test(char) ? `\\${char}` : char)

// More would make a regex too large to be worth running
const MAX_EXPANSIONS = 64

/**
 * Expand `{a,b}` groups into separate globs, innermost first
 */
const expandBraces = (glob: string): string[] => {
  // The first `{` whose group closes before another opens: an innermost group
  const match = /\{([^{}]*)\}/.exec(glob)
  if (!match || !match[1].includes(",")) return [glob]
  const before = glob.slice(0, match.index)
  const after = glob.slice(match.index + match[0].length)
  const expanded = match[1].split(",").flatMap((option) => expandBraces(before + option + after))
  return expanded.slice(0, MAX_EXPANSIONS)
}

/** One path segment's pattern, without globstars */
const segmentToRegex = (segment: string): string => {
  let out = ""
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i]
    if (char === "*") {
      out += "[^/]*"
    } else if (char === "?") {
      out += "[^/]"
    } else if (char === "[") {
      const end = segment.indexOf("]", i + 2)
      if (end === -1) {
        out += "\\["
        continue
      }
      const body = segment.slice(i + 1, end)
      const negated = body.startsWith("!") || body.startsWith("^")
      const chars = (negated ? body.slice(1) : body).replaceAll("\\", "\\\\")
      out += negated ? `[^/${chars}]` : `[${chars}]`
      i = end
    } else {
      out += escapeChar(char)
    }
  }
  return out
}

/** One brace-free glob */
const singleGlobToRegex = (glob: string): string => {
  const trimmed = glob.replace(/^\.\//, "")
  // As in grep: a glob without a directory part matches the filename
  const segments = (trimmed.includes("/") ? trimmed : `**/${trimmed}`)
    .split("/")
    .filter((segment, i, all) => !(segment === "**" && all[i - 1] === "**"))

  let out = ""
  segments.forEach((segment, i) => {
    const last = i === segments.length - 1
    if (segment === "**") {
      // Leading or middle: any number of directories, including none
      if (!last) out += i === 0 ? "(?:.*/)?" : "/(?:.*/)?"
      // Trailing: anything under the directory before it
      else out += i === 0 ? ".*" : "/.*"
      return
    }
    const separator = i === 0 || segments[i - 1] === "**" ? "" : "/"
    out += separator + segmentToRegex(segment)
  })
  return out
}

/**
 * An anchored regex source matching the paths `glob` matches
 */
export const globToRegex = (glob: string): string => {
  const alternatives = [...new Set(expandBraces(glob).map(singleGlobToRegex))]
  return alternatives.length === 1 ? `^${alternatives[0]}$` : `^(?:${alternatives.join("|")})$`
}
