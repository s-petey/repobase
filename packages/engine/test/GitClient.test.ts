import { describe, it, expect } from "@effect/vitest"
import { Cause, Effect, Layer, PlatformError, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { GitClient, GitError } from "../src/index.js"
import { layer as GitClientLayer } from "../src/services/GitClient.js"

/**
 * Mock ChildProcessSpawner that simulates git command responses
 */
interface MockCommand {
  stdout?: string
  exitCode?: number
  error?: string
}

const mockCommands: Record<string, MockCommand> = {
  "git clone --depth 1 https://github.com/test/repo /tmp/repo": { exitCode: 0 },
  "git -C /tmp/repo fetch origin": { exitCode: 0 },
  "git -C /tmp/repo rev-parse HEAD": { stdout: "abc123def456\n" },
  "git -C /tmp/repo rev-parse origin/main": { stdout: "xyz789abc\n" },
  "git -C /tmp/repo reset --hard abc123": { exitCode: 0 },
  "git -C /tmp/repo checkout v1.0.0": { exitCode: 0 },
  "git -C /tmp/repo diff --name-status abc..xyz": {
    stdout: "A\tnew-file.ts\nM\tmodified.ts\nD\tdeleted.ts\n"
  },
  // Failure cases
  "git clone --depth 1 https://github.com/invalid/repo /tmp/invalid": {
    error: "Repository not found"
  }
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

const MockChildProcessSpawner = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.ChildProcessSpawner.of({
    spawn: () => Effect.die("spawn not implemented in mock"),
    exitCode: (command) =>
      lookup(command).pipe(Effect.map((mock) => ChildProcessSpawner.ExitCode(mock.exitCode ?? 0))),
    string: (command) => lookup(command).pipe(Effect.map((mock) => mock.stdout ?? "")),
    lines: (command) =>
      lookup(command).pipe(
        Effect.map((mock) => (mock.stdout ?? "").split("\n").filter((l) => l.length > 0))
      ),
    streamString: () => Stream.die("streamString not implemented in mock"),
    streamLines: () => Stream.die("streamLines not implemented in mock")
  })
)

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
  })

  describe("getRemoteHead", () => {
    it.effect("returns remote head commit", () =>
      Effect.gen(function* () {
        const git = yield* GitClient
        const commit = yield* git.getRemoteHead("/tmp/repo", "main")
        expect(commit).toBe("xyz789abc")
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
    it.effect("parses file changes correctly", () =>
      Effect.gen(function* () {
        const git = yield* GitClient
        const changes = yield* git.diffNameStatus("/tmp/repo", "abc", "xyz")

        expect(changes).toHaveLength(3)
        expect(changes[0]).toEqual({ status: "A", path: "new-file.ts" })
        expect(changes[1]).toEqual({ status: "M", path: "modified.ts" })
        expect(changes[2]).toEqual({ status: "D", path: "deleted.ts" })
      }).pipe(Effect.provide(TestGitClientLayer))
    )
  })
})
