import { describe, it, expect } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { RpcClientError } from "effect/unstable/rpc"
import { GitError } from "../src/errors.js"
import {
  classifyGitFailure,
  CloneFailedError,
  ConfigReadFailedError,
  cloneFailed,
  DeleteRemovedFailedError,
  DiffFailedError,
  EmbedderLoadFailedError,
  FetchFailedError,
  fetchFailed,
  FinalizeFtsFailedError,
  formatStepError,
  IndexBatchFailedError,
  isRetryable,
  PlanIndexFailedError,
  RemoteBranchMissingError,
  remoteHeadFailed,
  RepoAlreadyAddedError,
  RepoMissingError,
  ResetFailedError,
  ResolveHeadFailedError,
  SaveConfigFailedError,
  StepError,
  UnexpectedStepError,
  UpdateStoreFailedError,
  WorkerCrashedError,
  workerCrashed
} from "../src/jobs/errors.js"

const repoId = "acme-widgets"

// One of every step error, with the title the TUI should show
const examples: ReadonlyArray<readonly [StepError, string]> = [
  [new RepoAlreadyAddedError({ repoId, message: "exists" }), "acme-widgets is already added"],
  [new RepoMissingError({ repoId, message: "gone" }), "acme-widgets is no longer in your repositories"],
  [new ConfigReadFailedError({ repoId, message: "Unexpected token" }), "Could not read your repositories config"],
  [
    new CloneFailedError({ repoId, message: "denied", url: "https://x", reason: "auth" }),
    "Clone failed: authentication required"
  ],
  [new ResolveHeadFailedError({ repoId, message: "bad" }), "Could not read the current commit"],
  [new SaveConfigFailedError({ repoId, message: "EACCES" }), "Could not save the repository config"],
  [new FetchFailedError({ repoId, message: "timeout", reason: "network" }), "Fetch failed: network error"],
  [
    new RemoteBranchMissingError({ repoId, message: "unknown revision", branch: "main" }),
    "Branch main no longer exists on the remote"
  ],
  [
    new DiffFailedError({ repoId, message: "bad", from: "0123456789abcdef", to: "fedcba9876543210" }),
    "Could not compare 01234567..fedcba98"
  ],
  [
    new ResetFailedError({ repoId, message: "locked", ref: "origin/main" }),
    "Could not update the working tree to origin/main"
  ],
  [new PlanIndexFailedError({ repoId, message: "EMFILE", phase: "glob" }), "Could not scan the repository files"],
  [
    new PlanIndexFailedError({ repoId, message: "corrupt", phase: "queryExisting" }),
    "Could not read the existing index"
  ],
  [
    new DeleteRemovedFailedError({ repoId, message: "conflict", count: 3 }),
    "Could not remove 3 deleted file(s) from the index"
  ],
  [
    new IndexBatchFailedError({ repoId, message: "OOM", batch: 11, total: 40, file: "src/big.ts", phase: "embed" }),
    "Indexing batch 12/40 failed while embedding src/big.ts"
  ],
  [
    new IndexBatchFailedError({ repoId, message: "conflict", batch: 0, total: 2, phase: "write" }),
    "Indexing batch 1/2 failed while writing"
  ],
  [new EmbedderLoadFailedError({ repoId, message: "download failed" }), "Could not load the embedding model"],
  [new FinalizeFtsFailedError({ repoId, message: "conflict" }), "Could not rebuild the keyword search index"],
  [new UpdateStoreFailedError({ repoId, message: "EACCES" }), "Could not record the sync"],
  [
    new WorkerCrashedError({ repoId, message: "worker exited", step: "indexBatch:3" }),
    "A worker thread stopped during indexBatch:3"
  ],
  [
    new UnexpectedStepError({ repoId, message: "undefined is not a function", step: "planChanges" }),
    "Unexpected error during planChanges"
  ]
]

describe("step errors", () => {
  describe("classifyGitFailure", () => {
    // Real git stderr, captured with GIT_TERMINAL_PROMPT=0
    it.each([
      [
        "notFound",
        "Cloning into 'x'...\nERROR: Repository not found.\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists."
      ],
      ["notFound", "remote: Repository not found.\nfatal: repository 'https://github.com/a/b/' not found"],
      ["notFound", "fatal: repository '/nonexistent/local/repo' does not exist"],
      ["notFound", "fatal: '/tmp/x' does not appear to be a git repository"],
      ["auth", "fatal: could not read Username for 'https://github.com': terminal prompts disabled"],
      ["auth", "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository."],
      ["auth", "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/a/b/'"],
      [
        "network",
        "fatal: unable to access 'https://nonexistent-host-xyz.invalid/a/b.git/': Could not resolve host: nonexistent-host-xyz.invalid"
      ],
      [
        "network",
        "fatal: unable to access 'https://github.com:1/x/y/': Failed to connect to github.com port 1 after 75003 ms: Couldn't connect to server"
      ],
      ["network", "error: RPC failed; curl 92 HTTP/2 stream 0 was not closed cleanly\nfatal: early EOF"],
      ["diskFull", "fatal: write error: No space left on device\nfatal: fetch-pack: invalid index-pack output"],
      ["unknown", "fatal: something unexpected happened"],
      ["unknown", ""]
    ] as const)("classifies as %s", (reason, stderr) => {
      expect(classifyGitFailure(stderr)).toBe(reason)
    })
  })

  describe("mappers", () => {
    it("cloneFailed classifies git's stderr", () => {
      const error = cloneFailed({ repoId, url: "https://github.com/a/b" })(
        new GitError({ command: "clone", message: "fatal: Could not resolve host: github.com" })
      )
      expect(error).toBeInstanceOf(CloneFailedError)
      expect(error.reason).toBe("network")
      expect(error.url).toBe("https://github.com/a/b")
    })

    it("fetchFailed classifies git's stderr", () => {
      const error = fetchFailed({ repoId })(
        new GitError({ command: "fetch", message: "fatal: Authentication failed for 'https://x'" })
      )
      expect(error.reason).toBe("auth")
    })

    it("remoteHeadFailed spots a missing branch", () => {
      const missing = remoteHeadFailed({ repoId, branch: "gone" })(
        new GitError({
          command: "rev-parse",
          message: "fatal: ambiguous argument 'origin/gone': unknown revision or path not in the working tree."
        })
      )
      expect(missing).toBeInstanceOf(RemoteBranchMissingError)

      const other = remoteHeadFailed({ repoId, branch: "main" })(
        new GitError({ command: "rev-parse", message: "fatal: not a git repository" })
      )
      expect(other).toBeInstanceOf(ResolveHeadFailedError)
    })

    it("workerCrashed wraps an RPC transport error", () => {
      const rpcError = new RpcClientError.RpcClientError({
        reason: new RpcClientError.RpcClientDefect({ message: "Error in worker", cause: "boom" })
      })
      const error = workerCrashed({ repoId, step: "clone" })(rpcError)
      expect(error).toBeInstanceOf(WorkerCrashedError)
      expect(error.step).toBe("clone")
      expect(error.message).toBe(rpcError.message)
    })
  })

  describe("formatStepError", () => {
    it.each(examples.map(([error, title]) => [error._tag, error, title] as const))(
      "%s has a specific title and a hint",
      (_, error, title) => {
        const display = formatStepError(error)
        expect(display.title).toBe(title)
        expect(display.detail).toBe(error.message)
        expect(display.hint).toBeTruthy()
      }
    )

    it("covers every error in the StepError union", () => {
      const tags = new Set(examples.map(([error]) => error._tag))
      expect(tags.size).toBe(StepError.members.length)
    })

    it.each(["auth", "notFound", "network", "diskFull", "unknown"] as const)(
      "gives clone failures a reason-specific title (%s)",
      (reason) => {
        const titles = new Set(
          (["auth", "notFound", "network", "diskFull", "unknown"] as const).map(
            (r) => formatStepError(new CloneFailedError({ repoId, message: "", url: "u", reason: r })).title
          )
        )
        expect(titles.size).toBe(5)
        expect(formatStepError(new CloneFailedError({ repoId, message: "", url: "u", reason })).title).toMatch(
          /^Clone failed: /
        )
      }
    )
  })

  describe("isRetryable", () => {
    it.each(examples.map(([error]) => [error._tag, error] as const))("%s", (tag, error) => {
      const permanent = ["RepoAlreadyAddedError", "RepoMissingError", "RemoteBranchMissingError"]
      expect(isRetryable(error)).toBe(!permanent.includes(tag))
    })
  })

  describe("serialization", () => {
    it.effect.each(examples.map(([error]) => [error._tag, error] as const))(
      "%s round-trips through the StepError union",
      ([_, error]) =>
        Effect.gen(function* () {
          const encoded = yield* Schema.encodeEffect(StepError)(error)
          const decoded = yield* Schema.decodeUnknownEffect(StepError)(structuredClone(encoded))
          expect(decoded).toBeInstanceOf(error.constructor)
          expect(decoded).toEqual(error)
          expect(formatStepError(decoded)).toEqual(formatStepError(error))
        })
    )
  })
})
