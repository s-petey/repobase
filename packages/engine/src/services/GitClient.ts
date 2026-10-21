import { Context, DateTime, Effect, Layer, Option, type PlatformError, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { GitError } from "../errors.js"
import type { FileChange, RepoMode } from "../schemas.js"

/**
 * Git client service interface
 */
export interface GitClientService {
  /**
   * Shallow-clone `url`, checking out the tracked branch or pinned ref of `mode`,
   * or the remote's default branch without one
   */
  readonly clone: (url: string, path: string, mode?: RepoMode) => Effect.Effect<void, GitError>
  readonly fetch: (path: string) => Effect.Effect<void, GitError>
  readonly resetHard: (path: string, ref: string) => Effect.Effect<void, GitError>
  readonly checkout: (path: string, ref: string) => Effect.Effect<void, GitError>
  readonly getCurrentCommit: (path: string) => Effect.Effect<string, GitError>
  readonly getCommitTime: (path: string, ref: string) => Effect.Effect<DateTime.Utc, GitError>
  readonly getCurrentBranch: (path: string) => Effect.Effect<string, GitError>
  readonly getRemoteHead: (path: string, branch: string) => Effect.Effect<string, GitError>
  readonly lsRemote: (remote: string, ref: string) => Effect.Effect<Option.Option<string>, GitError>
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
      message:
        typeof error === "object" && error !== null && "message" in error
          ? String(error.message)
          : String(error)
    })

/**
 * Create the GitClient service implementation
 */
export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  // Git must never wait for input: there's no terminal to answer a password
  // prompt in a worker thread, and a prompt on /dev/tty would draw over the
  // TUI. With prompts off, a repo needing credentials fails fast with
  // "terminal prompts disabled" instead of hanging. A user-provided
  // GIT_SSH_COMMAND is kept as is.
  const gitEnv: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    ...(process.env.GIT_SSH_COMMAND ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" })
  }

  const collectText = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
    stream.pipe(Stream.decodeText(), Stream.mkString)

  // Run a git command and return its stdout. A non-zero exit fails with a
  // GitError carrying git's stderr, so callers never mistake a failed command
  // for empty output.
  const run = (commandName: string, ...args: string[]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make("git", args, { env: gitEnv, extendEnv: true })
        )
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [collectText(handle.stdout), collectText(handle.stderr), handle.exitCode],
          { concurrency: "unbounded" }
        )
        return { stdout, stderr, exitCode }
      })
    ).pipe(
      Effect.mapError(toGitError(commandName)),
      Effect.flatMap(({ stdout, stderr, exitCode }) =>
        exitCode === 0
          ? Effect.succeed(stdout)
          : Effect.fail(
              new GitError({
                command: commandName,
                message: stderr.trim() || `Command exited with code ${exitCode}`
              })
            )
      )
    )

  return GitClient.of({
    clone: (url, path, mode) => {
      if (mode?._tag === "pinned") {
        // --branch takes no commit SHA, so fetch the ref on its own
        return run("clone", "clone", "--depth", "1", "--no-checkout", url, path).pipe(
          Effect.andThen(run("fetch", "-C", path, "fetch", "--depth", "1", "origin", mode.ref)),
          Effect.andThen(run("checkout", "-C", path, "checkout", "--detach", "FETCH_HEAD")),
          Effect.asVoid
        )
      }
      const branch = mode?._tag === "tracking" ? ["--branch", mode.branch] : []
      return run("clone", "clone", "--depth", "1", ...branch, url, path).pipe(Effect.asVoid)
    },

    fetch: (path) => run("fetch", "-C", path, "fetch", "origin").pipe(Effect.asVoid),

    getCurrentCommit: (path) =>
      run("rev-parse", "-C", path, "rev-parse", "HEAD").pipe(Effect.map((s) => s.trim())),

    getCommitTime: (path, ref) =>
      run("show", "-C", path, "show", "-s", "--format=%ct", ref).pipe(
        Effect.map((s) => DateTime.fromEpochSeconds(Number(s.trim())))
      ),

    getCurrentBranch: (path) =>
      run("rev-parse", "-C", path, "rev-parse", "--abbrev-ref", "HEAD").pipe(Effect.map((s) => s.trim())),

    getRemoteHead: (path, branch) =>
      run("rev-parse", "-C", path, "rev-parse", `origin/${branch}`).pipe(
        Effect.map((s) => s.trim())
      ),

    lsRemote: (remote, ref) =>
      run("ls-remote", "ls-remote", remote, ref).pipe(
        Effect.map((stdout) => {
          const commit = stdout.split("\t")[0].trim()
          return commit === "" ? Option.none() : Option.some(commit)
        })
      ),

    resetHard: (path, ref) => run("reset", "-C", path, "reset", "--hard", ref).pipe(Effect.asVoid),

    checkout: (path, ref) => run("checkout", "-C", path, "checkout", ref).pipe(Effect.asVoid),

    // --no-renames reports a rename as D + A, so every change is one of A/M/D.
    // -z keeps paths unquoted: without it git quotes non-ASCII paths.
    diffNameStatus: (path, fromCommit, toCommit) =>
      run(
        "diff",
        "-C",
        path,
        "diff",
        "--name-status",
        "--no-renames",
        "-z",
        `${fromCommit}..${toCommit}`
      ).pipe(
        Effect.map((stdout) => {
          // status NUL path NUL, repeated
          const fields = stdout.split("\0")
          const changes: FileChange[] = []
          for (let i = 0; i + 1 < fields.length; i += 2) {
            changes.push({ status: fields[i] as "A" | "M" | "D", path: fields[i + 1] })
          }
          return changes
        })
      )
  })
})

/**
 * GitClient layer - requires ChildProcessSpawner
 */
export const layer = Layer.effect(GitClient, make)
