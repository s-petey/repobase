import { Context, Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { GitError } from "../errors.js"

/**
 * Represents a file change from git diff
 */
export interface FileChange {
  status: "A" | "M" | "D" // Added, Modified, Deleted
  path: string
}

/**
 * Git client service interface
 */
export interface GitClientService {
  readonly clone: (url: string, path: string) => Effect.Effect<void, GitError>
  readonly fetch: (path: string) => Effect.Effect<void, GitError>
  readonly resetHard: (path: string, ref: string) => Effect.Effect<void, GitError>
  readonly checkout: (path: string, ref: string) => Effect.Effect<void, GitError>
  readonly getCurrentCommit: (path: string) => Effect.Effect<string, GitError>
  readonly getRemoteHead: (path: string, branch: string) => Effect.Effect<string, GitError>
  readonly diffNameStatus: (
    path: string,
    fromCommit: string,
    toCommit: string
  ) => Effect.Effect<FileChange[], GitError>
}

/**
 * GitClient service tag
 */
export class GitClient extends Context.Service<GitClient, GitClientService>()(
  "@repobase/engine/GitClient"
) {}

/**
 * Helper to convert platform errors to GitError
 */
const toGitError =
  (command: string) =>
  (error: unknown): GitError =>
    new GitError({
      command,
      message: error instanceof Error ? error.message : String(error)
    })

/**
 * Create the GitClient service implementation
 */
export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const git = (...args: string[]) => ChildProcess.make("git", args)

  // Run command and check exit code - fail on non-zero
  const runCommand = (cmd: ChildProcess.Command, commandName: string) =>
    spawner.exitCode(cmd).pipe(
      Effect.flatMap((exitCode) =>
        exitCode === 0
          ? Effect.void
          : Effect.fail(
              new GitError({
                command: commandName,
                message: `Command exited with code ${exitCode}`
              })
            )
      )
    )

  const runString = (cmd: ChildProcess.Command) => spawner.string(cmd)

  const runLines = (cmd: ChildProcess.Command) => spawner.lines(cmd)

  return GitClient.of({
    clone: (url, path) =>
      runCommand(
        git("clone", "--depth", "1", url, path),
        "clone"
      ).pipe(Effect.mapError(toGitError("clone"))),

    fetch: (path) =>
      runCommand(
        git("-C", path, "fetch", "origin"),
        "fetch"
      ).pipe(Effect.mapError(toGitError("fetch"))),

    getCurrentCommit: (path) =>
      runString(git("-C", path, "rev-parse", "HEAD")).pipe(
        Effect.map((s) => s.trim()),
        Effect.mapError(toGitError("rev-parse"))
      ),

    getRemoteHead: (path, branch) =>
      runString(git("-C", path, "rev-parse", `origin/${branch}`)).pipe(
        Effect.map((s) => s.trim()),
        Effect.mapError(toGitError("rev-parse"))
      ),

    resetHard: (path, ref) =>
      runCommand(
        git("-C", path, "reset", "--hard", ref),
        "reset"
      ).pipe(Effect.mapError(toGitError("reset"))),

    checkout: (path, ref) =>
      runCommand(
        git("-C", path, "checkout", ref),
        "checkout"
      ).pipe(Effect.mapError(toGitError("checkout"))),

    diffNameStatus: (path, fromCommit, toCommit) =>
      runLines(
        git("-C", path, "diff", "--name-status", `${fromCommit}..${toCommit}`)
      ).pipe(
        Effect.map((lines) =>
          lines
            .filter((line) => line.trim().length > 0)
            .map((line) => {
              const [status, ...pathParts] = line.split("\t")
              return {
                status: status as "A" | "M" | "D",
                path: pathParts.join("\t")
              }
            })
        ),
        Effect.mapError(toGitError("diff"))
      )
  })
})

/**
 * GitClient layer - requires ChildProcessSpawner
 */
export const layer = Layer.effect(GitClient, make)
