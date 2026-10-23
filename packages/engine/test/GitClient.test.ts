import { describe, it, expect } from "@effect/vitest"
import { Cause, DateTime, Effect, Layer, Option, PlatformError, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { GitClient, GitError } from "../src/index.js"
import { layer as GitClientLayer } from "../src/services/GitClient.js"

/**
 * Mock ChildProcessSpawner that simulates git command responses
 */
interface MockCommand {
  stdout?: string
  stderr?: string
  exitCode?: number
  // Fail to spawn at all (e.g. git not installed)
  error?: string
}

const mockCommands: Record<string, MockCommand> = {
  "git clone --depth 1 -- https://github.com/test/repo /tmp/repo": { exitCode: 0 },
  "git clone --depth 1 --branch dev -- https://github.com/test/repo /tmp/repo": { exitCode: 0 },
  "git clone --depth 1 --no-checkout -- https://github.com/test/repo /tmp/repo": { exitCode: 0 },
  "git -C /tmp/repo fetch --depth 1 -- origin v1.0.0": { exitCode: 0 },
  "git -C /tmp/repo checkout --detach FETCH_HEAD": { exitCode: 0 },
  "git -C /tmp/repo fetch origin": { exitCode: 0 },
  "git -C /tmp/repo rev-parse HEAD": { stdout: "abc123def456\n" },
  "git -C /tmp/repo rev-parse --abbrev-ref HEAD": { stdout: "master\n" },
  "git -C /tmp/repo show -s --format=%ct abc123": { stdout: "1767323045\n" },
  "git -C /tmp/repo rev-parse origin/main": { stdout: "xyz789abc\n" },
  "git ls-remote -- https://github.com/test/repo refs/heads/main": { stdout: "xyz789abc\trefs/heads/main\n" },
  "git ls-remote -- https://github.com/test/repo refs/heads/gone": { stdout: "" },
  "git -C /tmp/repo reset --hard abc123": { exitCode: 0 },
  "git -C /tmp/repo checkout v1.0.0": { exitCode: 0 },
  "git -C /tmp/repo diff --name-status --no-renames -z abc..xyz": {
    stdout: "A\0new-file.ts\0M\0docs/café.md\0D\0has\ttab.ts\0"
  },
  "git -C /tmp/repo diff --name-status --no-renames -z abc..symlinked": { stdout: "T\0now-a-link.ts\0" },
  "git -C /tmp/repo diff --name-status --no-renames -z abc..unmerged": { stdout: "M\0ok.ts\0U\0conflict.ts\0" },
  // Failure cases
  "git clone --depth 1 -- https://github.com/invalid/repo /tmp/invalid": {
    exitCode: 128,
    stderr: "Cloning into '/tmp/invalid'...\nfatal: repository 'https://github.com/invalid/repo/' not found\n"
  },
  "git clone --depth 1 -- https://github.com/test/repo /tmp/no-git": {
    error: "spawn git ENOENT"
  },
  "git -C /tmp/missing rev-parse HEAD": {
    exitCode: 128,
    stderr: "fatal: cannot change to '/tmp/missing': No such file or directory\n"
  },
  "git -C /tmp/repo rev-parse origin/gone": {
    exitCode: 128,
    stderr: "fatal: ambiguous argument 'origin/gone': unknown revision or path not in the working tree.\n"
  },
  "git -C /tmp/repo diff --name-status --no-renames -z abc..missing": {
    exitCode: 128,
    stderr: "fatal: bad revision 'abc..missing'\n"
  },
  "git -C /tmp/repo reset --hard nope": { exitCode: 1 }
}

const lookup = (
  command: ChildProcess.Command
): Effect.Effect<MockCommand, PlatformError.PlatformError> => {
  const cmd = ChildProcess.isStandardCommand(command)
    ? [command.command, ...command.args].join(" ")
    : "<piped command>"
  const mock = mockCommands[cmd]
  if (!mock) {
    return Effect.fail({
      _tag: "SystemError",
      reason: "Unknown",
      message: `Unknown command: ${cmd}`
    } as any)
  }
  if (mock.error) {
    return Effect.fail({
      _tag: "SystemError",
      reason: "Unknown",
      message: mock.error
    } as any)
  }
  return Effect.succeed(mock)
}

const textStream = (text: string | undefined) =>
  text ? Stream.make(new TextEncoder().encode(text)) : Stream.empty

// A finished process: its output is already buffered and its exit code known
const mockHandle = (mock: MockCommand) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(mock.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: textStream(mock.stdout),
    stderr: textStream(mock.stderr),
    all: Stream.concat(textStream(mock.stdout), textStream(mock.stderr)),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void)
  })

const MockChildProcessSpawner = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.ChildProcessSpawner.of({
    spawn: (command) => lookup(command).pipe(Effect.map(mockHandle)),
    exitCode: () => Effect.die("GitClient should spawn, not use exitCode"),
    string: () => Effect.die("GitClient should spawn, not use string"),
    lines: () => Effect.die("GitClient should spawn, not use lines"),
    streamString: () => Stream.die("streamString not implemented in mock"),
    streamLines: () => Stream.die("streamLines not implemented in mock")
  })
)

// Run an effect expected to fail and return its GitError
const expectGitError = <A>(effect: Effect.Effect<A, GitError>) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(effect)
    expect(error).toBeInstanceOf(GitError)
    return error
  })

const TestGitClientLayer = GitClientLayer.pipe(Layer.provide(MockChildProcessSpawner))

describe("GitClient", () => {
  describe("clone", () => {
    it.effect("clones repository successfully", () =>
      Effect.gen(function* () {
        const git = yield* GitClient
        yield* git.clone("https://github.com/test/repo", "/tmp/repo")
        // If we get here without error, the test passes
      }).pipe(Effect.provide(TestGitClientLayer))
    )

    it.effect("clones the tracked branch", () =>
      Effect.gen(function* () {
        const git = yield* GitClient
        yield* git.clone("https://github.com/test/repo", "/tmp/repo", { _tag: "tracking", branch: "dev" })
      }).pipe(Effect.provide(TestGitClientLayer))
    )

    it.effect("checks out a pinned ref", () =>
      Effect.gen(function* () {
        const git = yield* GitClient
        yield* git.clone("https://github.com/test/repo", "/tmp/repo", { _tag: "pinned", ref: "v1.0.0" })
      }).pipe(Effect.provide(TestGitClientLayer))
    )

    it.effect("returns GitError on clone failure", () =>
      Effect.gen(function* () {
        const git = yield* GitClient
        const result = yield* Effect.exit(
          git.clone("https://github.com/invalid/repo", "/tmp/invalid")
        )
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          // Check it failed (rather than died or was interrupted)
          expect(Cause.hasFails(result.cause)).toBe(true)
        }
      }).pipe(Effect.provide(TestGitClientLayer))
    )

    it.effect("keeps git's stderr in the GitError", () =>
      Effect.gen(function* () {
        const git = yield* GitClient
        const error = yield* expectGitError(
          git.clone("https://github.com/invalid/repo", "/tmp/invalid")
        )
        expect(error.command).toBe("clone")
        expect(error.message).toContain("repository 'https://github.com/invalid/repo/' not found")
      }).pipe(Effect.provide(TestGitClientLayer))
    )

    it.effect("returns GitError when git cannot be spawned", () =>
      Effect.gen(function* () {
        const git = yield* GitClient
        const error = yield* expectGitError(git.clone("https://github.com/test/repo", "/tmp/no-git"))
        expect(error.command).toBe("clone")
        expect(error.message).toBe("spawn git ENOENT")
      }).pipe(Effect.provide(TestGitClientLayer))
    )
  })

  describe("fetch", () => {
    it.effect("fetches from origin", () =>
      Effect.gen(function* () {
        const git = yield* GitClient
        yield* git.fetch("/tmp/repo")
      }).pipe(Effect.provide(TestGitClientLayer))
    )
  })

  describe("getCurrentCommit", () => {
    it.effect("returns current commit hash trimmed", () =>
      Effect.gen(function* () {
        const git = yield* GitClient
        const commit = yield* git.getCurrentCommit("/tmp/repo")
        expect(commit).toBe("abc123def456")
      }).pipe(Effect.provide(TestGitClientLayer))
    )

    it.effect("fails instead of returning an empty commit for a missing repo", () =>
      Effect.gen(function* () {
        const git = yield* GitClient
        const error = yield* expectGitError(git.getCurrentCommit("/tmp/missing"))
        expect(error.command).toBe("rev-parse")
        expect(error.message).toContain("cannot change to '/tmp/missing'")
      }).pipe(Effect.provide(TestGitClientLayer))
    )
  })

  describe("getCommitTime", () => {
    it.effect("returns the committer date", () =>
      Effect.gen(function* () {
        const git = yield* GitClient
        const time = yield* git.getCommitTime("/tmp/repo", "abc123")
        expect(DateTime.formatIso(time)).toBe("2026-01-02T03:04:05.000Z")
      }).pipe(Effect.provide(TestGitClientLayer))
    )
  })

  describe("getCurrentBranch", () => {
    it.effect("returns the checked-out branch trimmed", () =>
      Effect.gen(function* () {
        const git = yield* GitClient
        expect(yield* git.getCurrentBranch("/tmp/repo")).toBe("master")
      }).pipe(Effect.provide(TestGitClientLayer))
    )
  })

  describe("getRemoteHead", () => {
    it.effect("returns remote head commit", () =>
      Effect.gen(function* () {
        const git = yield* GitClient
        const commit = yield* git.getRemoteHead("/tmp/repo", "main")
        expect(commit).toBe("xyz789abc")
      }).pipe(Effect.provide(TestGitClientLayer))
    )

    it.effect("fails when the remote branch does not exist", () =>
      Effect.gen(function* () {
        const git = yield* GitClient
        const error = yield* expectGitError(git.getRemoteHead("/tmp/repo", "gone"))
        expect(error.message).toContain("unknown revision")
      }).pipe(Effect.provide(TestGitClientLayer))
    )
  })

  describe("lsRemote", () => {
    it.effect("returns the commit a remote ref points at", () =>
      Effect.gen(function* () {
        const git = yield* GitClient
        expect(yield* git.lsRemote("https://github.com/test/repo", "refs/heads/main")).toEqual(Option.some("xyz789abc"))
      }).pipe(Effect.provide(TestGitClientLayer))
    )

    it.effect("returns nothing for a ref the remote doesn't have", () =>
      Effect.gen(function* () {
        const git = yield* GitClient
        expect(yield* git.lsRemote("https://github.com/test/repo", "refs/heads/gone")).toEqual(Option.none())
      }).pipe(Effect.provide(TestGitClientLayer))
    )
  })

  describe("resetHard", () => {
    it.effect("resets to specified ref", () =>
      Effect.gen(function* () {
        const git = yield* GitClient
        yield* git.resetHard("/tmp/repo", "abc123")
      }).pipe(Effect.provide(TestGitClientLayer))
    )

    it.effect("falls back to the exit code when git writes no stderr", () =>
      Effect.gen(function* () {
        const git = yield* GitClient
        const error = yield* expectGitError(git.resetHard("/tmp/repo", "nope"))
        expect(error.command).toBe("reset")
        expect(error.message).toBe("Command exited with code 1")
      }).pipe(Effect.provide(TestGitClientLayer))
    )
  })

  describe("checkout", () => {
    it.effect("checks out specified ref", () =>
      Effect.gen(function* () {
        const git = yield* GitClient
        yield* git.checkout("/tmp/repo", "v1.0.0")
      }).pipe(Effect.provide(TestGitClientLayer))
    )
  })

  describe("diffNameStatus", () => {
    it.effect("parses file changes, keeping non-ASCII and tab characters in paths", () =>
      Effect.gen(function* () {
        const git = yield* GitClient
        const changes = yield* git.diffNameStatus("/tmp/repo", "abc", "xyz")

        expect(changes).toEqual([
          { status: "A", path: "new-file.ts" },
          { status: "M", path: "docs/café.md" },
          { status: "D", path: "has\ttab.ts" }
        ])
      }).pipe(Effect.provide(TestGitClientLayer))
    )

    it.effect("reports a type change, such as a file becoming a symlink, as a modification", () =>
      Effect.gen(function* () {
        const git = yield* GitClient
        expect(yield* git.diffNameStatus("/tmp/repo", "abc", "symlinked")).toEqual([
          { status: "M", path: "now-a-link.ts" }
        ])
      }).pipe(Effect.provide(TestGitClientLayer))
    )

    it.effect("fails on a status it doesn't know, rather than passing it on", () =>
      Effect.gen(function* () {
        const git = yield* GitClient
        const error = yield* expectGitError(git.diffNameStatus("/tmp/repo", "abc", "unmerged"))
        expect(error.command).toBe("diff")
        expect(error.message).toBe("Unexpected status U for conflict.ts")
      }).pipe(Effect.provide(TestGitClientLayer))
    )

    it.effect("fails instead of returning no changes for a bad revision", () =>
      Effect.gen(function* () {
        const git = yield* GitClient
        const error = yield* expectGitError(git.diffNameStatus("/tmp/repo", "abc", "missing"))
        expect(error.command).toBe("diff")
        expect(error.message).toContain("bad revision")
      }).pipe(Effect.provide(TestGitClientLayer))
    )
  })
})
