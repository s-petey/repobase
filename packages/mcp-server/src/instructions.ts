import { needsReindex, type RepoConfig } from "@repobase/engine"

const HUMAN_INSTRUCTION = `
When a question involves one of them (its code, API, docs, types, tests or behavior),
look here first, before web searching or fetching docs: it's faster, and it's the exact
source rather than a summary of it.

- \`search\` finds the relevant files (hybrid keyword and semantic search). Start here.
- \`grep\` finds exact symbols or strings, and \`read_file\` reads a file you found. Narrow \`grep\`
  with \`path\` (a file or directory) or \`glob\` in large repositories.
- \`glob_files\` and \`list_files\` find files by name or path.

Pass \`repo\` (for example \`honojs/hono\`) to stay within one repository. Fall back to the web only
when repobase doesn't have the answer, or the question is about a newer version than
the one indexed (see \`list_repos\` for when each was last synced).
`.trim()

/**
 * What to tell an agent about repos in an old index format: no tool finds
 * anything in them until they're re-indexed
 */
export const reindexNotice = (repoIds: ReadonlyArray<string>): string =>
  `${repoIds.length === 1 ? `${repoIds[0]} uses` : `These repositories use`} an old index format, so every ` +
  `repobase tool finds nothing in ${repoIds.length === 1 ? "it" : "them"} until re-indexed` +
  `${repoIds.length === 1 ? "" : `: ${repoIds.join(", ")}`}. ` +
  "Tell the user to run `repobase reindex` or open the repobase TUI to re-index."

/**
 * What the server tells MCP clients when they connect. Clients like Claude Code
 * add it to the model's instructions, so it steers questions about an indexed
 * repository here before web searches.
 */
export const serverInstructions = (repos: ReadonlyArray<RepoConfig>): string => {
  if (repos.length === 0) {
    return "repobase has no repositories indexed yet. Add them with the `repobase` TUI or CLI, then its tools can search them."
  }

  const list = repos.map((repo) => `- ${repo.id}`).join("\n")
  const outdated = repos.filter(needsReindex).map((repo) => repo.id)
  return [
    "repobase has local, indexed copies of these repositories:",
    list,
    "",
    HUMAN_INSTRUCTION,
    ...(outdated.length > 0 ? ["", reindexNotice(outdated)] : [])
  ].join("\n")
}
