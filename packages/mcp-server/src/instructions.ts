import { extractRepoParts, type RepoConfig } from "@repobase/engine"

const displayName = (repo: RepoConfig) => {
  try {
    const { owner, name } = extractRepoParts(repo.url)
    return `${owner}/${name}`
  } catch {
    return repo.id
  }
}

const HUMAN_INSTRUCTION = `
When a question involves one of them (its code, API, docs, types, tests or behavior),
look here first, before web searching or fetching docs: it's faster, and it's the exact
source rather than a summary of it.

- \`search\` finds the relevant files (hybrid keyword and semantic search). Start here.
- \`grep\` finds exact symbols or strings, and \`read_file\` reads a file you found.
- \`glob_files\` and \`list_files\` find files by name or path.

Pass \`repo\` with the repo id to stay within one repository. Fall back to the web only
when repobase doesn't have the answer, or the question is about a newer version than
the one indexed (see \`list_repos\` for when each was last synced).
`.trim()

/**
 * What the server tells MCP clients when they connect. Clients like Claude Code
 * add it to the model's instructions, so it steers questions about an indexed
 * repository here before web searches.
 */
export const serverInstructions = (repos: ReadonlyArray<RepoConfig>): string => {
  if (repos.length === 0) {
    return "repobase has no repositories indexed yet. Add them with the `repobase` TUI or CLI, then its tools can search them."
  }

  const list = repos.map((repo) => `- ${displayName(repo)} (repo id: ${repo.id})`).join("\n")
  return ["repobase has local, indexed copies of these repositories:", list, "", HUMAN_INSTRUCTION].join("\n")
}
